"use strict";

const { types } = require("node:util");

const { canonicalJsonBytes } = require("./canonical-json");
const {
  EVENT_SCHEMA,
  createLedgerEvent,
  digestWorkflowCommand,
  verifyLedgerEvent,
} = require("./ledger-contract");
const {
  assertHeadMatchesEvents,
  assertNoProtectedTempObjects,
  clockTimestamp,
  defaultClock,
} = require("./ledger-schema");

const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{32}$/u;

class WorkflowStoreError extends Error {
  constructor(code, details = {}) {
    super(`Workflow store rejected: ${code}`);
    this.name = "WorkflowStoreError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function reject(code, details) {
  throw new WorkflowStoreError(code, details);
}

function exactObject(value, expectedKeys, code) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    reject(code);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    reject(code);
  }
  const keys = ownKeys.slice().sort();
  const expected = expectedKeys.slice().sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    reject(code);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      );
    })
  ) {
    reject(code);
  }
}

function safePositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    reject(code);
  }
  return value;
}

function safeNonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject(code);
  }
  return value;
}

function fromDatabaseInteger(value, code, { nullable = false, zero = false } = {}) {
  if (nullable && value === null) {
    return null;
  }
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (
    !Number.isSafeInteger(converted) ||
    (zero ? converted < 0 : converted <= 0)
  ) {
    reject(code);
  }
  return converted;
}

function commandId(value) {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    reject("invalid_command_id");
  }
  return value;
}

function validateUnicode(value, code) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        reject(code);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject(code);
    }
  }
}

function boundedText(value, { code, maximumBytes, nullable = false }) {
  if (nullable && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (typeof value !== "string") {
    reject(code);
  }
  const normalized = value.trim();
  validateUnicode(normalized, code);
  if (
    normalized === "" ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized, "utf8") > maximumBytes
  ) {
    reject(code);
  }
  return normalized;
}

function normalizeContact(contact) {
  exactObject(
    contact,
    ["email", "message", "name", "phone"],
    "invalid_contact_fields",
  );
  return Object.freeze({
    email: boundedText(contact.email, {
      code: "invalid_contact_email",
      maximumBytes: 320,
      nullable: true,
    }),
    message: boundedText(contact.message, {
      code: "invalid_contact_message",
      maximumBytes: 4_000,
      nullable: true,
    }),
    name: boundedText(contact.name, {
      code: "invalid_contact_name",
      maximumBytes: 200,
    }),
    phone: boundedText(contact.phone, {
      code: "invalid_contact_phone",
      maximumBytes: 64,
    }),
  });
}

function normalizeCreateInput(input) {
  exactObject(input, ["commandId", "contact"], "invalid_create_fields");
  return {
    commandId: commandId(input.commandId),
    contact: normalizeContact(input.contact),
  };
}

function normalizeOperatorInput(input, extraKeys = []) {
  exactObject(
    input,
    [
      "actorAuthVersion",
      "actorId",
      "commandId",
      "expectedVersion",
      "leadId",
      ...extraKeys,
    ],
    "invalid_operator_fields",
  );
  return {
    actorAuthVersion: safePositiveInteger(
      input.actorAuthVersion,
      "invalid_actor_auth_version",
    ),
    actorId: safePositiveInteger(input.actorId, "invalid_actor_id"),
    commandId: commandId(input.commandId),
    expectedVersion: safeNonNegativeInteger(
      input.expectedVersion,
      "invalid_expected_version",
    ),
    leadId: safePositiveInteger(input.leadId, "invalid_lead_id"),
  };
}

function isBusyError(error) {
  return (
    error &&
    typeof error.code === "string" &&
    (error.code === "SQLITE_BUSY" || error.code.startsWith("SQLITE_BUSY_"))
  );
}

function runImmediate(database, operation) {
  try {
    return database
      .transaction(() => {
        assertNoProtectedTempObjects(database);
        return operation();
      })
      .immediate();
  } catch (error) {
    if (isBusyError(error)) {
      reject("ledger_busy");
    }
    throw error;
  }
}

function createWorkflowStore(
  database,
  { clock = defaultClock, faultInjector = () => {} } = {},
) {
  if (typeof clock !== "function" || typeof faultInjector !== "function") {
    reject("invalid_store_dependency");
  }
  assertNoProtectedTempObjects(database);

  const statements = {
    advanceHead: database.prepare(`
      UPDATE main.workflow_ledger_head
      SET sequence = ?, event_hash = ?
      WHERE singleton = 1 AND sequence = ? AND event_hash = ?
    `),
    eventByCommand: database.prepare(`
      SELECT *
      FROM main.workflow_events
      WHERE command_id = ?
    `),
    eventBySequence: database.prepare(`
      SELECT *
      FROM main.workflow_events
      WHERE sequence = ?
    `),
    insertEvent: database.prepare(`
      INSERT INTO main.workflow_events (
        sequence,
        event_hash,
        previous_hash,
        command_id,
        command_digest,
        event_type,
        aggregate_id,
        aggregate_version,
        actor_id,
        actor_role,
        occurred_at,
        event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertLead: database.prepare(`
      INSERT INTO main.leads (
        id,
        name,
        email,
        phone,
        message,
        status,
        assigned_to,
        workflow_version,
        archived_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'new', NULL, 0, NULL, ?, ?)
    `),
    leadById: database
      .prepare(`
        SELECT
          id,
          name,
          email,
          phone,
          message,
          status,
          assigned_to,
          workflow_version,
          archived_at,
          created_at,
          updated_at
        FROM main.leads
        WHERE id = ?
      `)
      .safeIntegers(true),
    nextLeadId: database
      .prepare(`
        SELECT MAX(
          COALESCE((
            SELECT seq FROM main.sqlite_sequence WHERE name = 'leads'
          ), 0),
          COALESCE((SELECT MAX(id) FROM main.leads), 0)
        ) + 1 AS id
      `)
      .safeIntegers(true),
    userById: database
      .prepare(`
        SELECT id, role, auth_version
        FROM main.users
        WHERE id = ?
      `)
      .safeIntegers(true),
    updateAssignment: database.prepare(`
      UPDATE main.leads
      SET assigned_to = ?, workflow_version = ?, updated_at = ?
      WHERE id = ? AND workflow_version = ? AND archived_at IS NULL
    `),
    updateClaim: database.prepare(`
      UPDATE main.leads
      SET assigned_to = ?, workflow_version = ?, updated_at = ?
      WHERE id = ?
        AND workflow_version = ?
        AND status = 'new'
        AND assigned_to IS NULL
        AND archived_at IS NULL
    `),
    updateStatus: database.prepare(`
      UPDATE main.leads
      SET status = ?, workflow_version = ?, updated_at = ?
      WHERE id = ? AND workflow_version = ? AND archived_at IS NULL
    `),
  };

  function normalizeLeadRow(row) {
    if (!row) {
      return null;
    }
    return Object.freeze({
      archived_at: row.archived_at,
      assigned_to: fromDatabaseInteger(row.assigned_to, "unsafe_assignee_id", {
        nullable: true,
      }),
      created_at: row.created_at,
      email: row.email,
      id: fromDatabaseInteger(row.id, "unsafe_lead_id"),
      message: row.message,
      name: row.name,
      phone: row.phone,
      status: row.status,
      updated_at: row.updated_at,
      workflow_version: fromDatabaseInteger(
        row.workflow_version,
        "unsafe_workflow_version",
        { zero: true },
      ),
    });
  }

  function readLead(leadId, { active = true } = {}) {
    const lead = normalizeLeadRow(statements.leadById.get(leadId));
    if (!lead || (active && lead.archived_at !== null)) {
      reject("lead_not_found", { lead_id: leadId });
    }
    return lead;
  }

  function readActor(actorId, actorAuthVersion, allowedRoles) {
    const row = statements.userById.get(actorId);
    if (!row) {
      reject("actor_not_found");
    }
    const resolvedId = fromDatabaseInteger(row.id, "unsafe_actor_id");
    const resolvedAuthVersion = fromDatabaseInteger(
      row.auth_version,
      "unsafe_auth_version",
    );
    if (resolvedAuthVersion !== actorAuthVersion) {
      reject("auth_version_conflict");
    }
    if (!allowedRoles.includes(row.role)) {
      reject("actor_forbidden");
    }
    return Object.freeze({ id: resolvedId, role: row.role });
  }

  function readRoleHolder(userId, requiredRole, errorCode) {
    const row = statements.userById.get(userId);
    if (!row || row.role !== requiredRole) {
      reject(errorCode);
    }
    return Object.freeze({
      id: fromDatabaseInteger(row.id, "unsafe_actor_id"),
      role: row.role,
    });
  }

  function decodeStoredEvent(row) {
    if (!row) {
      return null;
    }
    try {
      if (typeof row.event_json !== "string") {
        reject("ledger_corrupt");
      }
      const parsed = JSON.parse(row.event_json);
      const event = verifyLedgerEvent(parsed);
      if (canonicalJsonBytes(event).toString("utf8") !== row.event_json) {
        reject("ledger_corrupt");
      }

      const matchesColumns =
        row.sequence === event.sequence &&
        row.event_hash === event.event_hash &&
        row.previous_hash === event.previous_hash &&
        row.command_id === event.command.command_id &&
        row.command_digest === event.command_digest &&
        row.event_type === event.event_type &&
        row.aggregate_id === event.aggregate.id &&
        row.aggregate_version === event.aggregate.version &&
        row.actor_id === event.actor.id &&
        row.actor_role === event.actor.role &&
        row.occurred_at === event.occurred_at;
      if (!matchesColumns) {
        reject("ledger_corrupt");
      }
      return event;
    } catch (error) {
      if (error instanceof WorkflowStoreError) {
        throw error;
      }
      reject("ledger_corrupt");
    }
  }

  function readValidatedHead() {
    let head;
    try {
      head = assertHeadMatchesEvents(database);
      if (head.sequence > 0) {
        const finalEvent = decodeStoredEvent(
          statements.eventBySequence.get(head.sequence),
        );
        if (!finalEvent || finalEvent.event_hash !== head.event_hash) {
          reject("ledger_corrupt");
        }
      }
    } catch (error) {
      if (error instanceof WorkflowStoreError) {
        throw error;
      }
      reject("ledger_corrupt");
    }
    return head;
  }

  function findIdempotentEvent(command) {
    const row = statements.eventByCommand.get(command.command_id);
    if (!row) {
      return null;
    }
    const event = decodeStoredEvent(row);
    if (event.command_digest !== digestWorkflowCommand(command)) {
      reject("idempotency_conflict");
    }
    return event;
  }

  function findCreateReplay(commandIdentifier) {
    const row = statements.eventByCommand.get(commandIdentifier);
    if (!row) {
      return null;
    }
    const event = decodeStoredEvent(row);
    if (event.command.action !== "lead.create") {
      reject("idempotency_conflict");
    }
    return event;
  }

  function callFault(stage, event) {
    faultInjector(
      stage,
      Object.freeze({
        action: event.command.action,
        lead_id: event.aggregate.id,
        sequence: event.sequence,
      }),
    );
  }

  function insertEvent(event) {
    const insert = statements.insertEvent.run(
      event.sequence,
      event.event_hash,
      event.previous_hash,
      event.command.command_id,
      event.command_digest,
      event.event_type,
      event.aggregate.id,
      event.aggregate.version,
      event.actor.id,
      event.actor.role,
      event.occurred_at,
      canonicalJsonBytes(event).toString("utf8"),
    );
    if (insert.changes !== 1) {
      reject("event_insert_failed");
    }
    callFault("after_event_insert", event);
  }

  function advanceEventHead(event, previousHead) {
    const advanced = statements.advanceHead.run(
      event.sequence,
      event.event_hash,
      previousHead.sequence,
      previousHead.event_hash,
    );
    if (advanced.changes !== 1) {
      reject("head_compare_and_swap_failed");
    }
    callFault("after_head_update", event);
  }

  function assertProjectionState(leadId, expected) {
    const projection = readLead(leadId);
    if (
      projection.assigned_to !== expected.assigned_to ||
      projection.status !== expected.status ||
      projection.workflow_version !== expected.workflow_version
    ) {
      reject("projection_write_mismatch", { lead_id: leadId });
    }
    return projection;
  }

  function receipt(event, replayed, { publicView = false } = {}) {
    const projection = readLead(event.aggregate.id, { active: false });
    const currentProjection = publicView
      ? Object.freeze({
          id: projection.id,
          status: projection.status,
          workflow_version: projection.workflow_version,
        })
      : projection;
    return Object.freeze({
      current_projection: currentProjection,
      event,
      replayed,
    });
  }

  function assertExpectedVersion(lead, expectedVersion) {
    if (lead.workflow_version !== expectedVersion) {
      reject("version_conflict", {
        actual_version: lead.workflow_version,
        expected_version: expectedVersion,
        lead_id: lead.id,
      });
    }
  }

  function createLead(rawInput) {
    const input = normalizeCreateInput(rawInput);
    return runImmediate(database, () => {
      const existing = findCreateReplay(input.commandId);
      if (existing) {
        return receipt(existing, true, { publicView: true });
      }

      const occurredAt = clockTimestamp(clock);
      const head = readValidatedHead();
      const leadId = fromDatabaseInteger(
        statements.nextLeadId.get().id,
        "unsafe_lead_id",
      );
      const event = createLedgerEvent({
        actor: { id: null, role: "public" },
        aggregate: { id: leadId, type: "lead", version: 0 },
        command: {
          action: "lead.create",
          command_id: input.commandId,
          lead_id: leadId,
        },
        event_type: "lead.created",
        occurred_at: occurredAt,
        payload: { assigned_to: null, status: "new" },
        previous_hash: head.event_hash,
        schema: EVENT_SCHEMA,
        sequence: head.sequence + 1,
      });
      insertEvent(event);
      const inserted = statements.insertLead.run(
        leadId,
        input.contact.name,
        input.contact.email,
        input.contact.phone,
        input.contact.message,
        occurredAt,
        occurredAt,
      );
      if (inserted.changes !== 1) {
        reject("projection_insert_failed", { lead_id: leadId });
      }
      assertProjectionState(leadId, {
        assigned_to: null,
        status: "new",
        workflow_version: 0,
      });
      callFault("after_projection_update", event);
      advanceEventHead(event, head);
      return receipt(event, false, { publicView: true });
    });
  }

  function claimLead(rawInput) {
    const input = normalizeOperatorInput(rawInput);
    const command = {
      action: "lead.claim",
      actor_id: input.actorId,
      command_id: input.commandId,
      expected_version: input.expectedVersion,
      lead_id: input.leadId,
    };
    return runImmediate(database, () => {
      const existing = findIdempotentEvent(command);
      const actor = readActor(
        input.actorId,
        input.actorAuthVersion,
        ["sales"],
      );
      if (existing) {
        const currentLead = readLead(input.leadId);
        if (
          currentLead.assigned_to !== null &&
          currentLead.assigned_to !== actor.id
        ) {
          reject("lead_access_forbidden");
        }
        return receipt(existing, true);
      }

      const lead = readLead(input.leadId);
      assertExpectedVersion(lead, input.expectedVersion);
      const head = readValidatedHead();
      const occurredAt = clockTimestamp(clock);
      const event = createLedgerEvent({
        actor,
        aggregate: {
          id: lead.id,
          type: "lead",
          version: lead.workflow_version + 1,
        },
        command,
        event_type: "lead.claimed",
        occurred_at: occurredAt,
        payload: {
          from_assigned_to: lead.assigned_to,
          status: lead.status,
          to_assigned_to: actor.id,
        },
        previous_hash: head.event_hash,
        schema: EVENT_SCHEMA,
        sequence: head.sequence + 1,
      });
      insertEvent(event);
      const updated = statements.updateClaim.run(
        actor.id,
        event.aggregate.version,
        occurredAt,
        lead.id,
        lead.workflow_version,
      );
      if (updated.changes !== 1) {
        reject("version_conflict", { lead_id: lead.id });
      }
      assertProjectionState(lead.id, {
        assigned_to: actor.id,
        status: lead.status,
        workflow_version: event.aggregate.version,
      });
      callFault("after_projection_update", event);
      advanceEventHead(event, head);
      return receipt(event, false);
    });
  }

  function assignLead(rawInput) {
    const input = {
      ...normalizeOperatorInput(rawInput, ["toAssignedTo"]),
      toAssignedTo: safePositiveInteger(
        rawInput.toAssignedTo,
        "invalid_assignment_target",
      ),
    };
    const command = {
      action: "lead.assign",
      actor_id: input.actorId,
      command_id: input.commandId,
      expected_version: input.expectedVersion,
      lead_id: input.leadId,
      to_assigned_to: input.toAssignedTo,
    };
    return runImmediate(database, () => {
      const existing = findIdempotentEvent(command);
      const actor = readActor(
        input.actorId,
        input.actorAuthVersion,
        ["admin"],
      );
      if (existing) {
        return receipt(existing, true);
      }

      const target = readRoleHolder(
        input.toAssignedTo,
        "sales",
        "assignment_target_not_sales",
      );
      const lead = readLead(input.leadId);
      assertExpectedVersion(lead, input.expectedVersion);
      const head = readValidatedHead();
      const occurredAt = clockTimestamp(clock);
      const event = createLedgerEvent({
        actor,
        aggregate: {
          id: lead.id,
          type: "lead",
          version: lead.workflow_version + 1,
        },
        command,
        event_type: "lead.assigned",
        occurred_at: occurredAt,
        payload: {
          from_assigned_to: lead.assigned_to,
          status: lead.status,
          to_assigned_role: "sales",
          to_assigned_to: target.id,
        },
        previous_hash: head.event_hash,
        schema: EVENT_SCHEMA,
        sequence: head.sequence + 1,
      });
      insertEvent(event);
      const updated = statements.updateAssignment.run(
        target.id,
        event.aggregate.version,
        occurredAt,
        lead.id,
        lead.workflow_version,
      );
      if (updated.changes !== 1) {
        reject("version_conflict", { lead_id: lead.id });
      }
      assertProjectionState(lead.id, {
        assigned_to: target.id,
        status: lead.status,
        workflow_version: event.aggregate.version,
      });
      callFault("after_projection_update", event);
      advanceEventHead(event, head);
      return receipt(event, false);
    });
  }

  function transitionLead(rawInput) {
    const input = {
      ...normalizeOperatorInput(rawInput, ["toStatus"]),
      toStatus: rawInput.toStatus,
    };
    const command = {
      action: "lead.transition",
      actor_id: input.actorId,
      command_id: input.commandId,
      expected_version: input.expectedVersion,
      lead_id: input.leadId,
      to_status: input.toStatus,
    };
    return runImmediate(database, () => {
      const existing = findIdempotentEvent(command);
      const actor = readActor(
        input.actorId,
        input.actorAuthVersion,
        ["admin", "sales"],
      );
      const lead = readLead(input.leadId);
      if (actor.role === "sales" && lead.assigned_to !== actor.id) {
        reject("lead_access_forbidden");
      }
      if (existing) {
        return receipt(existing, true);
      }

      assertExpectedVersion(lead, input.expectedVersion);
      const head = readValidatedHead();
      const occurredAt = clockTimestamp(clock);
      const event = createLedgerEvent({
        actor,
        aggregate: {
          id: lead.id,
          type: "lead",
          version: lead.workflow_version + 1,
        },
        command,
        event_type: "lead.status_changed",
        occurred_at: occurredAt,
        payload: {
          assigned_to: lead.assigned_to,
          from_status: lead.status,
          to_status: input.toStatus,
        },
        previous_hash: head.event_hash,
        schema: EVENT_SCHEMA,
        sequence: head.sequence + 1,
      });
      insertEvent(event);
      const updated = statements.updateStatus.run(
        input.toStatus,
        event.aggregate.version,
        occurredAt,
        lead.id,
        lead.workflow_version,
      );
      if (updated.changes !== 1) {
        reject("version_conflict", { lead_id: lead.id });
      }
      assertProjectionState(lead.id, {
        assigned_to: lead.assigned_to,
        status: input.toStatus,
        workflow_version: event.aggregate.version,
      });
      callFault("after_projection_update", event);
      advanceEventHead(event, head);
      return receipt(event, false);
    });
  }

  return Object.freeze({
    assignLead,
    claimLead,
    createLead,
    transitionLead,
  });
}

module.exports = {
  WorkflowStoreError,
  createWorkflowStore,
  normalizeContact,
};
