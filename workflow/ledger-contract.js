"use strict";

const { types } = require("node:util");

const {
  canonicalJsonBytes,
  sha256Canonical,
} = require("./canonical-json");

const EVENT_SCHEMA = "orta.workflow-event.v1";
const EVENT_HASH_DOMAIN = "orta.workflow-event.v1";
const COMMAND_HASH_DOMAIN = "orta.workflow-command.v1";
const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMAND_ID_PATTERN = /^cmd_[0-9a-f]{32}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const LEAD_STATUSES = Object.freeze([
  "new",
  "contacted",
  "converted",
  "rejected",
]);
const ACTOR_ROLES = Object.freeze(["public", "admin", "sales", "system"]);
const EVENT_TYPES = Object.freeze([
  "lead.created",
  "lead.imported",
  "lead.claimed",
  "lead.assigned",
  "lead.status_changed",
]);
const WORKFLOW_ACTIONS = Object.freeze([
  "lead.create",
  "lead.import",
  "lead.claim",
  "lead.assign",
  "lead.transition",
]);
const ACTION_EVENT_TYPES = Object.freeze({
  "lead.create": "lead.created",
  "lead.import": "lead.imported",
  "lead.claim": "lead.claimed",
  "lead.assign": "lead.assigned",
  "lead.transition": "lead.status_changed",
});
const ALLOWED_TRANSITIONS = Object.freeze({
  new: Object.freeze(["contacted", "rejected"]),
  contacted: Object.freeze(["converted", "rejected"]),
  converted: Object.freeze([]),
  rejected: Object.freeze([]),
});

class LedgerContractError extends Error {
  constructor(code) {
    super(`Workflow ledger rejected: ${code}`);
    this.name = "LedgerContractError";
    this.code = code;
  }
}

function reject(code) {
  throw new LedgerContractError(code);
}

function exactKeys(value, expectedKeys, code) {
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
    ownKeys.some((key) => {
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

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    reject(code);
  }
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject(code);
  }
  return value;
}

function nullablePositiveInteger(value, code) {
  if (value === null) {
    return null;
  }
  return positiveInteger(value, code);
}

function closedString(value, allowed, code) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    reject(code);
  }
  return value;
}

function hash(value, code) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    reject(code);
  }
  return value;
}

function commandId(value) {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    reject("invalid_command_id");
  }
  return value;
}

function normalizeWorkflowCommand(command) {
  if (
    command === null ||
    typeof command !== "object" ||
    types.isProxy(command) ||
    Array.isArray(command) ||
    Object.getPrototypeOf(command) !== Object.prototype
  ) {
    reject("invalid_command");
  }
  const actionDescriptor = Object.getOwnPropertyDescriptor(command, "action");
  if (
    actionDescriptor === undefined ||
    actionDescriptor.enumerable !== true ||
    !("value" in actionDescriptor)
  ) {
    reject("invalid_command_action");
  }
  const action = closedString(
    actionDescriptor.value,
    WORKFLOW_ACTIONS,
    "invalid_command_action",
  );

  if (action === "lead.create") {
    exactKeys(command, ["action", "command_id", "lead_id"], "invalid_command_fields");
    return {
      action,
      command_id: commandId(command.command_id),
      lead_id: positiveInteger(command.lead_id, "invalid_command_lead_id"),
    };
  }

  if (action === "lead.import") {
    exactKeys(
      command,
      [
        "action",
        "assigned_role",
        "assigned_to",
        "command_id",
        "lead_id",
        "status",
      ],
      "invalid_command_fields",
    );
    const importedState = validateImportedState(
      command.assigned_role,
      command.assigned_to,
      command.status,
      "invalid_import_command_state",
    );
    return {
      action,
      ...importedState,
      command_id: commandId(command.command_id),
      lead_id: positiveInteger(command.lead_id, "invalid_command_lead_id"),
    };
  }

  const commonKeys = [
    "action",
    "actor_id",
    "command_id",
    "expected_version",
    "lead_id",
  ];
  const expectedKeys = commonKeys.slice();
  if (action === "lead.assign") {
    expectedKeys.push("to_assigned_to");
  }
  if (action === "lead.transition") {
    expectedKeys.push("to_status");
  }
  exactKeys(command, expectedKeys, "invalid_command_fields");

  const expectedVersion = nonNegativeInteger(
    command.expected_version,
    "invalid_expected_version",
  );
  if (expectedVersion >= Number.MAX_SAFE_INTEGER) {
    reject("invalid_expected_version");
  }
  const normalized = {
    action,
    actor_id: positiveInteger(command.actor_id, "invalid_command_actor_id"),
    command_id: commandId(command.command_id),
    expected_version: expectedVersion,
    lead_id: positiveInteger(command.lead_id, "invalid_command_lead_id"),
  };
  if (action === "lead.assign") {
    normalized.to_assigned_to = positiveInteger(
      command.to_assigned_to,
      "invalid_command_assignment",
    );
  }
  if (action === "lead.transition") {
    normalized.to_status = closedString(
      command.to_status,
      ["contacted", "converted", "rejected"],
      "invalid_command_status",
    );
  }
  return normalized;
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    reject("invalid_timestamp");
  }
  return value;
}

function validateActor(actor, eventType) {
  exactKeys(actor, ["id", "role"], "invalid_actor");
  const role = closedString(actor.role, ACTOR_ROLES, "invalid_actor_role");
  const id = nullablePositiveInteger(actor.id, "invalid_actor_id");

  if (eventType === "lead.created" && role !== "public") {
    reject("creation_requires_public_actor");
  }
  if (eventType === "lead.imported" && role !== "system") {
    reject("import_requires_system_actor");
  }
  if (role === "public" && (eventType !== "lead.created" || id !== null)) {
    reject("invalid_public_actor");
  }
  if (role === "system" && (eventType !== "lead.imported" || id !== null)) {
    reject("invalid_system_actor");
  }
  if ((role === "admin" || role === "sales") && id === null) {
    reject("missing_actor_id");
  }

  return { id, role };
}

function validateStatus(value, code = "invalid_status") {
  return closedString(value, LEAD_STATUSES, code);
}

function validateImportedState(
  assignedRoleValue,
  assignedToValue,
  statusValue,
  code,
) {
  const assignedTo = nullablePositiveInteger(assignedToValue, code);
  const status = validateStatus(statusValue, code);
  if (
    (assignedTo === null && (assignedRoleValue !== null || status !== "new")) ||
    (assignedTo !== null && assignedRoleValue !== "sales")
  ) {
    reject(code);
  }
  return {
    assigned_role: assignedTo === null ? null : "sales",
    assigned_to: assignedTo,
    status,
  };
}

function validatePayload(eventType, payload, actor) {
  if (eventType === "lead.created") {
    exactKeys(payload, ["assigned_to", "status"], "invalid_created_payload");
    if (payload.status !== "new" || payload.assigned_to !== null) {
      reject("invalid_created_payload");
    }
    return { assigned_to: null, status: "new" };
  }

  if (eventType === "lead.imported") {
    exactKeys(
      payload,
      ["assigned_role", "assigned_to", "status"],
      "invalid_imported_payload",
    );
    return validateImportedState(
      payload.assigned_role,
      payload.assigned_to,
      payload.status,
      "invalid_imported_payload",
    );
  }

  if (eventType === "lead.claimed") {
    exactKeys(
      payload,
      ["from_assigned_to", "status", "to_assigned_to"],
      "invalid_claim_payload",
    );
    if (
      payload.from_assigned_to !== null ||
      payload.status !== "new" ||
      payload.to_assigned_to !== actor.id ||
      actor.role !== "sales"
    ) {
      reject("invalid_claim_payload");
    }
    return {
      from_assigned_to: null,
      status: "new",
      to_assigned_to: actor.id,
    };
  }

  if (eventType === "lead.assigned") {
    exactKeys(
      payload,
      ["from_assigned_to", "status", "to_assigned_role", "to_assigned_to"],
      "invalid_assignment_payload",
    );
    if (actor.role !== "admin") {
      reject("assignment_requires_admin");
    }
    const fromAssignedTo = nullablePositiveInteger(
      payload.from_assigned_to,
      "invalid_previous_assignment",
    );
    const toAssignedTo = positiveInteger(
      payload.to_assigned_to,
      "invalid_next_assignment",
    );
    const status = validateStatus(payload.status);
    if (
      payload.to_assigned_role !== "sales" ||
      !["new", "contacted"].includes(status) ||
      fromAssignedTo === toAssignedTo
    ) {
      reject("invalid_assignment_transition");
    }
    return {
      from_assigned_to: fromAssignedTo,
      status,
      to_assigned_role: "sales",
      to_assigned_to: toAssignedTo,
    };
  }

  exactKeys(
    payload,
    ["assigned_to", "from_status", "to_status"],
    "invalid_transition_payload",
  );
  if (!["admin", "sales"].includes(actor.role)) {
    reject("transition_requires_operator");
  }
  const fromStatus = validateStatus(payload.from_status, "invalid_from_status");
  const toStatus = validateStatus(payload.to_status, "invalid_to_status");
  if (!ALLOWED_TRANSITIONS[fromStatus].includes(toStatus)) {
    reject("invalid_status_transition");
  }
  const assignedTo = positiveInteger(
    payload.assigned_to,
    "missing_transition_assignment",
  );
  if (actor.role === "sales" && assignedTo !== actor.id) {
    reject("sales_actor_not_assigned");
  }
  return {
    assigned_to: assignedTo,
    from_status: fromStatus,
    to_status: toStatus,
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizeEventCore(input) {
  exactKeys(
    input,
    [
      "actor",
      "aggregate",
      "command",
      "event_type",
      "occurred_at",
      "payload",
      "previous_hash",
      "schema",
      "sequence",
    ],
    "invalid_event_fields",
  );

  if (input.schema !== EVENT_SCHEMA) {
    reject("invalid_event_schema");
  }
  const eventType = closedString(input.event_type, EVENT_TYPES, "invalid_event_type");
  const actor = validateActor(input.actor, eventType);
  const command = normalizeWorkflowCommand(input.command);
  if (ACTION_EVENT_TYPES[command.action] !== eventType) {
    reject("command_event_mismatch");
  }

  exactKeys(input.aggregate, ["id", "type", "version"], "invalid_aggregate");
  if (input.aggregate.type !== "lead") {
    reject("invalid_aggregate_type");
  }
  const aggregateId = positiveInteger(
    input.aggregate.id,
    "invalid_aggregate_id",
  );
  const version = nonNegativeInteger(
    input.aggregate.version,
    "invalid_aggregate_version",
  );
  const isInitialEvent = ["lead.created", "lead.imported"].includes(eventType);
  if (isInitialEvent !== (version === 0)) {
    reject("event_version_mismatch");
  }
  if (command.lead_id !== aggregateId) {
    reject("command_aggregate_mismatch");
  }
  if (
    !isInitialEvent && version !== command.expected_version + 1
  ) {
    reject("command_version_mismatch");
  }
  if (
    !isInitialEvent && command.actor_id !== actor.id
  ) {
    reject("command_actor_mismatch");
  }

  const payload = validatePayload(eventType, input.payload, actor);
  if (
    eventType === "lead.assigned" &&
    command.to_assigned_to !== payload.to_assigned_to
  ) {
    reject("command_assignment_mismatch");
  }
  if (
    eventType === "lead.status_changed" &&
    command.to_status !== payload.to_status
  ) {
    reject("command_status_mismatch");
  }
  if (
    eventType === "lead.imported" &&
    (command.assigned_role !== payload.assigned_role ||
      command.assigned_to !== payload.assigned_to ||
      command.status !== payload.status)
  ) {
    reject("command_import_mismatch");
  }
  const sequence = positiveInteger(input.sequence, "invalid_sequence");
  const previousHash = hash(input.previous_hash, "invalid_previous_hash");
  if (
    (sequence === 1 && previousHash !== ZERO_HASH) ||
    (sequence > 1 && previousHash === ZERO_HASH) ||
    (sequence === 1 && !isInitialEvent)
  ) {
    reject("invalid_chain_origin");
  }
  if (version >= sequence) {
    reject("event_sequence_mismatch");
  }
  const normalized = {
    actor,
    aggregate: {
      id: aggregateId,
      type: "lead",
      version,
    },
    command,
    command_digest: digestWorkflowCommand(command),
    event_type: eventType,
    occurred_at: timestamp(input.occurred_at),
    payload,
    previous_hash: previousHash,
    schema: EVENT_SCHEMA,
    sequence,
  };

  canonicalJsonBytes(normalized);
  return normalized;
}

function eventHash(eventBody) {
  return sha256Canonical(EVENT_HASH_DOMAIN, eventBody);
}

function createLedgerEvent(input) {
  const body = normalizeEventCore(input);
  return deepFreeze({
    ...body,
    event_hash: eventHash(body),
  });
}

function verifyLedgerEvent(record) {
  exactKeys(
    record,
    [
      "actor",
      "aggregate",
      "command",
      "command_digest",
      "event_hash",
      "event_type",
      "occurred_at",
      "payload",
      "previous_hash",
      "schema",
      "sequence",
    ],
    "invalid_record_fields",
  );
  const {
    command_digest: suppliedCommandDigest,
    event_hash: suppliedHash,
    ...coreInput
  } = record;
  const body = normalizeEventCore(coreInput);
  if (
    hash(suppliedCommandDigest, "invalid_command_digest") !==
    body.command_digest
  ) {
    reject("command_digest_mismatch");
  }
  const expectedHash = eventHash(body);
  if (hash(suppliedHash, "invalid_event_hash") !== expectedHash) {
    reject("event_hash_mismatch");
  }
  return deepFreeze({ ...body, event_hash: expectedHash });
}

function digestWorkflowCommand(command) {
  return sha256Canonical(
    COMMAND_HASH_DOMAIN,
    normalizeWorkflowCommand(command),
  );
}

module.exports = {
  ACTION_EVENT_TYPES,
  ACTOR_ROLES,
  ALLOWED_TRANSITIONS,
  COMMAND_HASH_DOMAIN,
  EVENT_HASH_DOMAIN,
  EVENT_SCHEMA,
  EVENT_TYPES,
  LEAD_STATUSES,
  LedgerContractError,
  ZERO_HASH,
  createLedgerEvent,
  digestWorkflowCommand,
  normalizeWorkflowCommand,
  verifyLedgerEvent,
  WORKFLOW_ACTIONS,
};
