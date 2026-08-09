"use strict";

const express = require("express");

const database = require("../database");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth");
const {
  LedgerContractError,
} = require("../workflow/ledger-contract");
const {
  WorkflowReplayError,
  replayWorkflowLedger,
} = require("../workflow/ledger-replay");
const {
  WorkflowStoreError,
  createWorkflowStore,
  normalizeContact,
} = require("../workflow/ledger-store");

const router = express.Router();
const workflowStore = createWorkflowStore(database);
const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{32}$/u;
const LEAD_STATUSES = new Set(["new", "contacted", "converted", "rejected"]);
const CREATE_RATE_LIMIT = 20;
const CREATE_RATE_WINDOW_MS = 60_000;
const MAX_RATE_KEYS = 1_024;
const createWindows = new Map();

function exactBody(value, allowedKeys, requiredKeys = allowedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowedKeys.includes(key)) &&
    requiredKeys.every((key) => keys.includes(key))
  );
}

function parsePositiveInteger(value) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseExpectedVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function commandId(req) {
  const value = req.get("Idempotency-Key");
  return typeof value === "string" && COMMAND_ID_PATTERN.test(value)
    ? value
    : null;
}

function rateKey(req) {
  return req.socket && typeof req.socket.remoteAddress === "string"
    ? req.socket.remoteAddress
    : "unknown";
}

function enforceCreateRateLimit(req, res, next) {
  const now = Date.now();
  const key = rateKey(req);
  let entry = createWindows.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + CREATE_RATE_WINDOW_MS };
  }

  entry.count += 1;
  createWindows.delete(key);
  createWindows.set(key, entry);
  while (createWindows.size > MAX_RATE_KEYS) {
    createWindows.delete(createWindows.keys().next().value);
  }

  const remaining = Math.max(0, CREATE_RATE_LIMIT - entry.count);
  res.set("RateLimit-Limit", String(CREATE_RATE_LIMIT));
  res.set("RateLimit-Remaining", String(remaining));
  res.set("RateLimit-Reset", String(Math.ceil(entry.resetAt / 1_000)));
  if (entry.count > CREATE_RATE_LIMIT) {
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1_000)));
    return res.status(429).json({ error: "public_lead_rate_limited" });
  }
  return next();
}

function safeConflictDetails(error) {
  const details = error && error.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const safe = {};
  for (const key of ["actual_version", "expected_version", "lead_id"]) {
    if (Number.isSafeInteger(details[key]) && details[key] >= 0) {
      safe[key] = details[key];
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function handleWorkflowError(error, res) {
  if (
    !(error instanceof WorkflowStoreError) &&
    !(error instanceof LedgerContractError)
  ) {
    return false;
  }

  const conflictCodes = new Set([
    "auth_version_conflict",
    "idempotency_conflict",
    "version_conflict",
  ]);
  const forbiddenCodes = new Set([
    "actor_forbidden",
    "lead_access_forbidden",
  ]);
  const serviceCodes = new Set([
    "event_insert_failed",
    "head_compare_and_swap_failed",
    "ledger_busy",
    "ledger_corrupt",
    "projection_insert_failed",
    "projection_write_mismatch",
  ]);

  let status = 400;
  if (error.code === "lead_not_found" || error.code === "actor_not_found") {
    status = 404;
  } else if (forbiddenCodes.has(error.code)) {
    status = 403;
  } else if (conflictCodes.has(error.code)) {
    status = 409;
  } else if (serviceCodes.has(error.code)) {
    status = 503;
  }

  if (error.code === "ledger_busy") {
    res.set("Retry-After", "1");
  }
  const details = safeConflictDetails(error);
  return res.status(status).json({
    error: error.code,
    ...(details ? { details } : {}),
  });
}

function sendReceipt(res, receipt, created = false) {
  const event = receipt.event;
  res.set("Cache-Control", "no-store");
  res.set("ETag", '"' + event.event_hash + '"');
  return res.status(created && !receipt.replayed ? 201 : 200).json({
    command_id: event.command.command_id,
    event_hash: event.event_hash,
    event_type: event.event_type,
    lead: receipt.current_projection,
    replayed: receipt.replayed,
    sequence: event.sequence,
  });
}

router.post("/", enforceCreateRateLimit, (req, res) => {
  if (
    !exactBody(
      req.body,
      ["email", "message", "name", "phone"],
      ["name", "phone"],
    )
  ) {
    return res.status(400).json({ error: "invalid_lead_fields" });
  }
  const identifier = commandId(req);
  if (!identifier) {
    return res.status(400).json({ error: "invalid_idempotency_key" });
  }

  try {
    const contact = normalizeContact({
      email: req.body.email,
      message: req.body.message,
      name: req.body.name,
      phone: req.body.phone,
    });
    const receipt = workflowStore.createLead({
      commandId: identifier,
      contact,
    });
    if (receipt.replayed) {
      const storedContact = database
        .prepare(
          "SELECT email, message, name, phone FROM main.leads WHERE id = ?",
        )
        .get(receipt.current_projection.id);
      if (
        !storedContact ||
        storedContact.email !== contact.email ||
        storedContact.message !== contact.message ||
        storedContact.name !== contact.name ||
        storedContact.phone !== contact.phone
      ) {
        throw new WorkflowStoreError("idempotency_conflict");
      }
    }
    res.location("/api/leads/" + receipt.current_projection.id);
    return sendReceipt(res, receipt, true);
  } catch (error) {
    if (handleWorkflowError(error, res)) {
      return undefined;
    }
    console.error("Public lead command failure:", error && error.name);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

router.get(
  "/_workflow/replay",
  authenticateToken,
  requireRole("admin"),
  (req, res) => {
    try {
      const replay = replayWorkflowLedger(database);
      res.set("Cache-Control", "no-store");
      return res.json({ status: "verified", ...replay });
    } catch (error) {
      if (error instanceof WorkflowReplayError) {
        return res.status(503).json({ error: "ledger_verification_failed" });
      }
      console.error("Workflow replay failure:", error && error.name);
      return res.status(500).json({ error: "internal_server_error" });
    }
  },
);

router.get(
  "/",
  authenticateToken,
  requireRole("admin", "sales"),
  (req, res) => {
    const allowedQuery = new Set(["assigned_to", "limit", "status"]);
    if (
      Object.keys(req.query).some((key) => !allowedQuery.has(key)) ||
      Object.values(req.query).some((value) => typeof value !== "string")
    ) {
      return res.status(400).json({ error: "invalid_lead_query" });
    }

    const limit =
      req.query.limit === undefined ? 50 : parsePositiveInteger(req.query.limit);
    if (!limit || limit > 100) {
      return res.status(400).json({ error: "invalid_lead_limit" });
    }
    if (
      req.query.status !== undefined &&
      !LEAD_STATUSES.has(req.query.status)
    ) {
      return res.status(400).json({ error: "invalid_lead_status" });
    }
    const requestedAssignee =
      req.query.assigned_to === undefined
        ? null
        : parsePositiveInteger(req.query.assigned_to);
    if (req.query.assigned_to !== undefined && !requestedAssignee) {
      return res.status(400).json({ error: "invalid_assignee" });
    }
    if (
      req.user.role === "sales" &&
      requestedAssignee !== null &&
      requestedAssignee !== req.user.id
    ) {
      return res.status(403).json({ error: "lead_access_forbidden" });
    }

    let sql =
      "SELECT l.*, u.name AS assigned_to_name FROM main.leads AS l " +
      "LEFT JOIN main.users AS u ON l.assigned_to = u.id " +
      "WHERE l.archived_at IS NULL";
    const parameters = [];
    if (req.query.status !== undefined) {
      sql += " AND l.status = ?";
      parameters.push(req.query.status);
    }
    if (requestedAssignee !== null) {
      sql += " AND l.assigned_to = ?";
      parameters.push(requestedAssignee);
    }
    if (req.user.role === "sales") {
      sql += " AND (l.assigned_to = ? OR l.assigned_to IS NULL)";
      parameters.push(req.user.id);
    }
    sql += " ORDER BY l.id DESC LIMIT ?";
    parameters.push(limit);
    return res.json(database.prepare(sql).all(...parameters));
  },
);

router.get(
  "/:id",
  authenticateToken,
  requireRole("admin", "sales"),
  (req, res) => {
    const leadId = parsePositiveInteger(req.params.id);
    if (!leadId) {
      return res.status(400).json({ error: "invalid_lead_id" });
    }
    const lead = database
      .prepare(
        "SELECT l.*, u.name AS assigned_to_name FROM main.leads AS l " +
          "LEFT JOIN main.users AS u ON l.assigned_to = u.id " +
          "WHERE l.id = ? AND l.archived_at IS NULL",
      )
      .get(leadId);
    if (!lead) {
      return res.status(404).json({ error: "lead_not_found" });
    }
    if (
      req.user.role === "sales" &&
      lead.assigned_to !== null &&
      lead.assigned_to !== req.user.id
    ) {
      return res.status(403).json({ error: "lead_access_forbidden" });
    }
    return res.json(lead);
  },
);

function operatorInput(req, allowedKeys) {
  if (!exactBody(req.body, allowedKeys)) {
    return null;
  }
  const leadId = parsePositiveInteger(req.params.id);
  const identifier = commandId(req);
  const expectedVersion = parseExpectedVersion(req.body.expected_version);
  if (!leadId || !identifier || expectedVersion === null) {
    return null;
  }
  return {
    actorAuthVersion: req.user.auth_version,
    actorId: req.user.id,
    commandId: identifier,
    expectedVersion,
    leadId,
  };
}

router.post(
  "/:id/claim",
  authenticateToken,
  requireRole("sales"),
  (req, res) => {
    const input = operatorInput(req, ["expected_version"]);
    if (!input) {
      return res.status(400).json({ error: "invalid_claim_command" });
    }
    try {
      return sendReceipt(res, workflowStore.claimLead(input));
    } catch (error) {
      if (handleWorkflowError(error, res)) {
        return undefined;
      }
      console.error("Lead claim failure:", error && error.name);
      return res.status(500).json({ error: "internal_server_error" });
    }
  },
);

router.post(
  "/:id/assign",
  authenticateToken,
  requireRole("admin"),
  (req, res) => {
    const input = operatorInput(req, ["assigned_to", "expected_version"]);
    const assignedTo = input ? parsePositiveInteger(req.body.assigned_to) : null;
    if (!input || !assignedTo) {
      return res.status(400).json({ error: "invalid_assign_command" });
    }
    try {
      return sendReceipt(
        res,
        workflowStore.assignLead({ ...input, toAssignedTo: assignedTo }),
      );
    } catch (error) {
      if (handleWorkflowError(error, res)) {
        return undefined;
      }
      console.error("Lead assignment failure:", error && error.name);
      return res.status(500).json({ error: "internal_server_error" });
    }
  },
);

router.post(
  "/:id/transition",
  authenticateToken,
  requireRole("admin", "sales"),
  (req, res) => {
    const input = operatorInput(req, ["expected_version", "status"]);
    if (!input || !LEAD_STATUSES.has(req.body.status)) {
      return res.status(400).json({ error: "invalid_transition_command" });
    }
    try {
      return sendReceipt(
        res,
        workflowStore.transitionLead({ ...input, toStatus: req.body.status }),
      );
    } catch (error) {
      if (handleWorkflowError(error, res)) {
        return undefined;
      }
      console.error("Lead transition failure:", error && error.name);
      return res.status(500).json({ error: "internal_server_error" });
    }
  },
);

router.patch(
  "/:id",
  authenticateToken,
  requireRole("admin", "sales"),
  (req, res) => {
    void req;
    res.set("Allow", "GET, POST");
    return res.status(405).json({ error: "direct_lead_mutation_disabled" });
  },
);

router.delete(
  "/:id",
  authenticateToken,
  requireRole("admin"),
  (req, res) => {
    void req;
    res.set("Allow", "GET, POST");
    return res.status(405).json({ error: "direct_lead_mutation_disabled" });
  },
);

module.exports = router;
