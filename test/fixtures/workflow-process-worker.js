"use strict";

const { readSync, writeSync } = require("node:fs");
const path = require("node:path");

const Database = require("better-sqlite3");

const { configureDatabase } = require("../../database-core");
const { createWorkflowStore } = require("../../workflow/ledger-store");

const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{32}$/u;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PAUSE_STAGES = new Set([
  "after_event_insert",
  "after_projection_update",
  "after_head_update",
]);
const OPERATIONS = new Set(["create", "claim", "assign", "transition"]);
const LEAD_STATUSES = new Set([
  "new",
  "contacted",
  "converted",
  "rejected",
]);
const TRANSITION_STATUSES = new Set(["contacted", "converted", "rejected"]);
const MAX_BUSY_TIMEOUT_MS = 60_000;
const MAX_SYNTHETIC_SEED = 1_000_000;
const MAX_MARKER_BYTES = 512;
const MARKER_FD = 4;
const RELEASE_FD = 5;

class WorkerProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkerProtocolError";
    this.code = code;
  }
}

function reject(code) {
  throw new WorkerProtocolError(code);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, requiredKeys, optionalKeys, code) {
  if (!isPlainObject(value)) {
    reject(code);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
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

function safeCommandId(value) {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    reject("invalid_worker_command_id");
  }
  return value;
}

function safeRequestId(value) {
  if (
    (Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && REQUEST_ID_PATTERN.test(value))
  ) {
    return value;
  }
  reject("invalid_worker_request_id");
}

function requestIdForError(message) {
  if (!isPlainObject(message) || !Object.hasOwn(message, "requestId")) {
    return null;
  }
  try {
    return safeRequestId(message.requestId);
  } catch {
    return null;
  }
}

function safeIsoTimestamp(value) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    reject("invalid_worker_timestamp");
  }
  return value;
}

function safeBusyTimeout(value) {
  const timeout = safeNonNegativeInteger(
    value,
    "invalid_worker_busy_timeout",
  );
  if (timeout > MAX_BUSY_TIMEOUT_MS) {
    reject("invalid_worker_busy_timeout");
  }
  return timeout;
}

function safePauseStage(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !PAUSE_STAGES.has(value)) {
    reject("invalid_worker_pause_stage");
  }
  return value;
}

function safePauseAfterCommit(value) {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    reject("invalid_worker_pause_after_commit");
  }
  return value;
}

function normalizeCommonOperatorInput(input, extraKeys = []) {
  exactKeys(
    input,
    [
      "actorAuthVersion",
      "actorId",
      "commandId",
      "expectedVersion",
      "leadId",
      ...extraKeys,
    ],
    [],
    "invalid_worker_operation_input",
  );
  return {
    actorAuthVersion: safePositiveInteger(
      input.actorAuthVersion,
      "invalid_worker_actor_auth_version",
    ),
    actorId: safePositiveInteger(input.actorId, "invalid_worker_actor_id"),
    commandId: safeCommandId(input.commandId),
    expectedVersion: safeNonNegativeInteger(
      input.expectedVersion,
      "invalid_worker_expected_version",
    ),
    leadId: safePositiveInteger(input.leadId, "invalid_worker_lead_id"),
  };
}

function safeSyntheticSeed(value) {
  const seed = safePositiveInteger(value, "invalid_worker_synthetic_seed");
  if (seed > MAX_SYNTHETIC_SEED) {
    reject("invalid_worker_synthetic_seed");
  }
  return seed;
}

function syntheticContact(commandId, syntheticSeed) {
  const suffix = commandId.slice(-12);
  return {
    email: `process-${syntheticSeed}-${suffix}@example.com`,
    message: `Synthetic child-process integration fixture ${syntheticSeed}.`,
    name: `Synthetic Process Candidate ${syntheticSeed}-${suffix}`,
    phone: "+1-555-0100",
  };
}

function normalizeOperationInput(operation, input) {
  if (operation === "create") {
    exactKeys(
      input,
      ["commandId", "syntheticSeed"],
      [],
      "invalid_worker_operation_input",
    );
    const commandId = safeCommandId(input.commandId);
    const syntheticSeed = safeSyntheticSeed(input.syntheticSeed);
    return {
      commandId,
      contact: syntheticContact(commandId, syntheticSeed),
    };
  }

  if (operation === "claim") {
    return normalizeCommonOperatorInput(input);
  }

  if (operation === "assign") {
    const normalized = normalizeCommonOperatorInput(input, ["toAssignedTo"]);
    return {
      ...normalized,
      toAssignedTo: safePositiveInteger(
        input.toAssignedTo,
        "invalid_worker_assignment_target",
      ),
    };
  }

  if (operation === "transition") {
    const normalized = normalizeCommonOperatorInput(input, ["toStatus"]);
    if (
      typeof input.toStatus !== "string" ||
      !TRANSITION_STATUSES.has(input.toStatus)
    ) {
      reject("invalid_worker_transition_status");
    }
    return { ...normalized, toStatus: input.toStatus };
  }

  reject("invalid_worker_operation");
}

function normalizeExecuteMessage(message) {
  exactKeys(
    message,
    ["type", "requestId", "operation", "busyTimeoutMs", "now", "input"],
    ["pauseAt", "pauseAfterCommit"],
    "invalid_worker_message",
  );
  if (message.type !== "execute") {
    reject("invalid_worker_message_type");
  }
  if (typeof message.operation !== "string" || !OPERATIONS.has(message.operation)) {
    reject("invalid_worker_operation");
  }

  const pauseAfterCommit = safePauseAfterCommit(message.pauseAfterCommit);
  const pauseAt = safePauseStage(message.pauseAt);
  if (pauseAfterCommit && pauseAt !== null) {
    reject("invalid_worker_pause_combination");
  }

  return {
    busyTimeoutMs: safeBusyTimeout(message.busyTimeoutMs),
    input: normalizeOperationInput(message.operation, message.input),
    now: safeIsoTimestamp(message.now),
    operation: message.operation,
    pauseAfterCommit,
    pauseAt,
    requestId: safeRequestId(message.requestId),
  };
}

function safeHash(value, code) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function sanitizeReceipt(receipt) {
  if (!isPlainObject(receipt) || !isPlainObject(receipt.event)) {
    reject("invalid_worker_receipt");
  }
  const { event } = receipt;
  if (
    !isPlainObject(event.aggregate) ||
    !isPlainObject(event.actor) ||
    !isPlainObject(event.command) ||
    !isPlainObject(receipt.current_projection)
  ) {
    reject("invalid_worker_receipt");
  }
  const projection = receipt.current_projection;
  if (typeof receipt.replayed !== "boolean") {
    reject("invalid_worker_receipt");
  }
  const assignedTo = Object.hasOwn(projection, "assigned_to")
    ? projection.assigned_to
    : null;
  if (
    assignedTo !== null &&
    (!Number.isSafeInteger(assignedTo) || assignedTo <= 0)
  ) {
    reject("invalid_worker_receipt");
  }

  return {
    current_projection: {
      assigned_to: assignedTo,
      id: safePositiveInteger(projection.id, "invalid_worker_receipt"),
      status:
        typeof projection.status === "string" && LEAD_STATUSES.has(projection.status)
          ? projection.status
          : reject("invalid_worker_receipt"),
      workflow_version: safeNonNegativeInteger(
        projection.workflow_version,
        "invalid_worker_receipt",
      ),
    },
    event: {
      action:
        typeof event.command.action === "string"
          ? event.command.action
          : reject("invalid_worker_receipt"),
      actor_id:
        event.actor.id === null
          ? null
          : safePositiveInteger(event.actor.id, "invalid_worker_receipt"),
      actor_role:
        typeof event.actor.role === "string"
          ? event.actor.role
          : reject("invalid_worker_receipt"),
      aggregate_id: safePositiveInteger(
        event.aggregate.id,
        "invalid_worker_receipt",
      ),
      aggregate_version: safeNonNegativeInteger(
        event.aggregate.version,
        "invalid_worker_receipt",
      ),
      command_digest: safeHash(
        event.command_digest,
        "invalid_worker_receipt",
      ),
      command_id: safeCommandId(event.command.command_id),
      event_hash: safeHash(event.event_hash, "invalid_worker_receipt"),
      event_type:
        typeof event.event_type === "string"
          ? event.event_type
          : reject("invalid_worker_receipt"),
      occurred_at: safeIsoTimestamp(event.occurred_at),
      previous_hash: safeHash(event.previous_hash, "invalid_worker_receipt"),
      sequence: safePositiveInteger(event.sequence, "invalid_worker_receipt"),
    },
    replayed: receipt.replayed,
  };
}

function sanitizeError(error) {
  const name =
    error && typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)
      ? error.name
      : "Error";
  const code =
    error &&
    typeof error.code === "string" &&
    ERROR_CODE_PATTERN.test(error.code)
      ? error.code
      : "worker_failure";
  return { code, name };
}

function writeMarker(marker) {
  const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");
  if (bytes.length > MAX_MARKER_BYTES) {
    reject("worker_marker_too_large");
  }

  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(MARKER_FD, bytes, offset, bytes.length - offset);
  }

  const release = Buffer.allocUnsafe(1);
  let released = false;
  while (!released) {
    try {
      const bytesRead = readSync(RELEASE_FD, release, 0, 1, null);
      if (bytesRead === 0) {
        reject("worker_release_pipe_closed");
      }
      released = true;
    } catch (error) {
      if (!error || error.code !== "EINTR") {
        throw error;
      }
    }
  }
}

function validateDatabaseFilename(argv) {
  if (
    argv.length !== 3 ||
    typeof argv[2] !== "string" ||
    argv[2] === "" ||
    argv[2].includes("\0") ||
    !path.isAbsolute(argv[2])
  ) {
    reject("invalid_worker_database_path");
  }
  return argv[2];
}

let database = null;
let store = null;
let activeRequest = null;
let activeTimestamp = null;
let activePauseAt = null;
let closed = false;

function closeDatabase() {
  if (closed) {
    return;
  }
  closed = true;
  if (database && database.open) {
    database.close();
  }
}

function safeSend(message, callback) {
  if (typeof process.send !== "function" || !process.connected) {
    if (callback) {
      callback();
    }
    return;
  }
  process.send(message, callback);
}

function executeOperation(request) {
  database.pragma(`busy_timeout = ${request.busyTimeoutMs}`);
  activeRequest = request;
  activeTimestamp = request.now;
  activePauseAt = request.pauseAt;

  try {
    let receipt;
    if (request.operation === "create") {
      receipt = store.createLead(request.input);
    } else if (request.operation === "claim") {
      receipt = store.claimLead(request.input);
    } else if (request.operation === "assign") {
      receipt = store.assignLead(request.input);
    } else {
      receipt = store.transitionLead(request.input);
    }

    const result = sanitizeReceipt(receipt);
    if (request.pauseAfterCommit) {
      writeMarker({
        event_hash: result.event.event_hash,
        operation: request.operation,
        request_id: request.requestId,
        sequence: result.event.sequence,
        stage: "after_commit",
        type: "paused",
      });
    }
    return result;
  } finally {
    activePauseAt = null;
    activeRequest = null;
    activeTimestamp = null;
  }
}

function handleExecute(message) {
  const requestId = requestIdForError(message);
  try {
    const request = normalizeExecuteMessage(message);
    const result = executeOperation(request);
    safeSend({ requestId: request.requestId, result, type: "result" });
  } catch (error) {
    safeSend({ error: sanitizeError(error), requestId, type: "error" });
  }
}

function handleShutdown(message) {
  try {
    exactKeys(message, ["type"], [], "invalid_worker_message");
    if (message.type !== "shutdown") {
      reject("invalid_worker_message_type");
    }
  } catch (error) {
    safeSend({
      error: sanitizeError(error),
      requestId: requestIdForError(message),
      type: "error",
    });
    return;
  }

  closeDatabase();
  safeSend({ type: "shutdown" }, () => {
    if (process.connected) {
      process.disconnect();
    }
  });
}

function handleMessage(message) {
  if (!isPlainObject(message) || typeof message.type !== "string") {
    safeSend({
      error: { code: "invalid_worker_message", name: "WorkerProtocolError" },
      requestId: requestIdForError(message),
      type: "error",
    });
    return;
  }
  if (message.type === "execute") {
    handleExecute(message);
    return;
  }
  if (message.type === "shutdown") {
    handleShutdown(message);
    return;
  }
  safeSend({
    error: {
      code: "invalid_worker_message_type",
      name: "WorkerProtocolError",
    },
    requestId: requestIdForError(message),
    type: "error",
  });
}

function initialize() {
  if (typeof process.send !== "function") {
    reject("worker_ipc_required");
  }
  database = new Database(validateDatabaseFilename(process.argv), {
    fileMustExist: true,
  });
  configureDatabase(database);
  store = createWorkflowStore(database, {
    clock() {
      if (activeTimestamp === null) {
        reject("worker_clock_inactive");
      }
      return new Date(activeTimestamp);
    },
    faultInjector(stage, metadata) {
      if (stage !== activePauseAt) {
        return;
      }
      writeMarker({
        action: metadata.action,
        lead_id: metadata.lead_id,
        operation: activeRequest.operation,
        request_id: activeRequest.requestId,
        sequence: metadata.sequence,
        stage,
        type: "paused",
      });
    },
  });
  process.on("message", handleMessage);
  process.once("disconnect", closeDatabase);
  safeSend({ type: "ready" });
}

try {
  initialize();
} catch (error) {
  closeDatabase();
  safeSend(
    { error: sanitizeError(error), requestId: null, type: "error" },
    () => {
      if (process.connected) {
        process.disconnect();
      }
      process.exitCode = 1;
    },
  );
}
