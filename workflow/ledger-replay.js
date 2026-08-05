"use strict";

const { TextDecoder } = require("node:util");

const {
  MAX_CANONICAL_BYTES,
  canonicalJsonBytes,
} = require("./canonical-json");
const { ZERO_HASH, verifyLedgerEvent } = require("./ledger-contract");
const { WORKFLOW_SCHEMA_VERSION } = require("./ledger-schema");

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EVENT_STORAGE_FUNCTIONS = new Set(["length", "typeof"]);
const DATABASE_ENCODINGS = Object.freeze({
  "UTF-16be": Object.freeze({ decoder: "utf-16be", multiplier: 2 }),
  "UTF-16le": Object.freeze({ decoder: "utf-16le", multiplier: 2 }),
  "UTF-8": Object.freeze({ decoder: "utf-8", multiplier: 1 }),
});
const MAX_ACTOR_ROLE_BYTES = 16;
const MAX_COMMAND_ID_BYTES = 36;
const MAX_EVENT_TYPE_BYTES = 32;
const MAX_HASH_BYTES = 64;
const MAX_PROJECTION_STATUS_BYTES = 32;
const MAX_SCHEMA_NAME_BYTES = 1_024;
const MAX_SCHEMA_SQL_BYTES = 1024 * 1024;
const MAX_TIMESTAMP_BYTES = 128;
const REQUIRED_TABLES = Object.freeze([
  "leads",
  "users",
  "workflow_events",
  "workflow_ledger_head",
  "workflow_schema",
]);
const REQUIRED_COLUMNS = Object.freeze({
  leads: Object.freeze([
    "archived_at",
    "assigned_to",
    "created_at",
    "id",
    "status",
    "updated_at",
    "workflow_version",
  ]),
  users: Object.freeze(["id"]),
  workflow_events: Object.freeze([
    "actor_id",
    "actor_role",
    "aggregate_id",
    "aggregate_version",
    "command_digest",
    "command_id",
    "event_hash",
    "event_json",
    "event_type",
    "occurred_at",
    "previous_hash",
    "sequence",
  ]),
  workflow_ledger_head: Object.freeze([
    "event_hash",
    "sequence",
    "singleton",
  ]),
  workflow_schema: Object.freeze(["singleton", "version"]),
});

class WorkflowReplayError extends Error {
  constructor(code, details = {}) {
    super(`Workflow replay rejected: ${code}`);
    this.name = "WorkflowReplayError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
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

function reject(code, details) {
  throw new WorkflowReplayError(code, details);
}

function safeInteger(value, { field, positive = false, position, code }) {
  if (
    typeof value !== "bigint" ||
    value < (positive ? 1n : 0n) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    reject(code, { field, position });
  }
  return Number(value);
}

function assertReplayConnectionSettings(database) {
  for (const name of ["ignore_check_constraints", "writable_schema"]) {
    let value;
    try {
      const setting = database
        .prepare(`PRAGMA ${name}`)
        .safeIntegers(false)
        .get();
      const values = setting ? Object.values(setting) : [];
      value = values.length === 1 ? values[0] : undefined;
    } catch {
      reject("database_integrity_failed");
    }
    if (value !== 0) {
      reject("database_integrity_failed");
    }
  }
  try {
    database.exec("PRAGMA writable_schema = RESET");
  } catch {
    reject("database_integrity_failed");
  }
}

function assertBoundedSchemaMetadata(database) {
  let invalid;
  try {
    invalid = database
      .prepare(`
        SELECT 1 AS invalid
        FROM main.sqlite_master
        WHERE typeof(name) <> 'text'
           OR length(CAST(name AS BLOB)) > ${MAX_SCHEMA_NAME_BYTES}
           OR typeof(tbl_name) <> 'text'
           OR length(CAST(tbl_name AS BLOB)) > ${MAX_SCHEMA_NAME_BYTES}
           OR (
             sql IS NOT NULL
             AND (
               typeof(sql) <> 'text'
               OR length(CAST(sql AS BLOB)) > ${MAX_SCHEMA_SQL_BYTES}
             )
           )
        LIMIT 1
      `)
      .get();
  } catch {
    reject("database_integrity_failed");
  }
  if (invalid) {
    reject("database_integrity_failed");
  }
}

function assertWorkflowEnabled(database) {
  let rows;
  try {
    const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
    rows = database
      .prepare(`
        SELECT DISTINCT name
        FROM main.sqlite_master
        WHERE type = 'table'
          AND rootpage > 0
          AND name IN (${placeholders})
        ORDER BY name
        LIMIT ${REQUIRED_TABLES.length + 1}
      `)
      .all(...REQUIRED_TABLES);
  } catch {
    reject("database_integrity_failed");
  }
  if (
    rows.length !== REQUIRED_TABLES.length ||
    REQUIRED_TABLES.some((name) => !rows.some((row) => row.name === name))
  ) {
    reject("workflow_not_enabled");
  }
}

function assertRequiredColumnsAreStored(database) {
  for (const [table, requiredNames] of Object.entries(REQUIRED_COLUMNS)) {
    let columns;
    try {
      columns = database
        .prepare(`PRAGMA main.table_xinfo(${table})`)
        .safeIntegers(false)
        .iterate();
    } catch {
      reject("workflow_not_enabled");
    }
    const seen = new Set();
    try {
      for (const column of columns) {
        if (!requiredNames.includes(column.name)) {
          continue;
        }
        if (column.hidden !== 0 || seen.has(column.name)) {
          reject("workflow_not_enabled");
        }
        seen.add(column.name);
      }
    } catch (error) {
      if (error instanceof WorkflowReplayError) {
        throw error;
      }
      reject("workflow_not_enabled");
    }
    if (seen.size !== requiredNames.length) {
      reject("workflow_not_enabled");
    }
  }
}

function assertDatabaseIntegrity(database) {
  let row;
  try {
    row = database.prepare("PRAGMA main.integrity_check(1)").get();
  } catch {
    reject("database_integrity_failed");
  }
  if (
    !row ||
    Object.values(row).length !== 1 ||
    Object.values(row)[0] !== "ok"
  ) {
    reject("database_integrity_failed");
  }
}

function assertForeignKeys(database) {
  let violation;
  try {
    violation = database.prepare("PRAGMA main.foreign_key_check").get();
  } catch {
    reject("foreign_key_violation");
  }
  if (violation) {
    reject("foreign_key_violation");
  }

  let missingAssignee;
  try {
    missingAssignee = database
      .prepare(`
        SELECT 1 AS violation
        FROM main.leads AS lead
        WHERE lead.assigned_to IS NOT NULL
          AND (
            typeof(lead.assigned_to) <> 'integer'
            OR NOT EXISTS (
              SELECT 1
              FROM main.users AS user
              WHERE typeof(user.id) = 'integer'
                AND user.id = lead.assigned_to
              LIMIT 1
            )
            OR EXISTS (
              SELECT 1
              FROM main.users AS user
              WHERE typeof(user.id) = 'integer'
                AND user.id = lead.assigned_to
              LIMIT 1 OFFSET 1
            )
          )
        LIMIT 1
      `)
      .get();
  } catch {
    reject("foreign_key_violation");
  }
  if (missingAssignee) {
    reject("foreign_key_violation");
  }
}

function readSchemaVersion(database) {
  let rows;
  try {
    rows = database
      .prepare(`
        SELECT
          CASE WHEN typeof(singleton) = 'integer' THEN singleton END AS singleton,
          CASE WHEN typeof(version) = 'integer' THEN version END AS version
        FROM main.workflow_schema
        LIMIT 2
      `)
      .safeIntegers(true)
      .all();
  } catch {
    reject("invalid_schema_marker");
  }
  if (rows.length !== 1) {
    reject("invalid_schema_marker", { reason: "row_count" });
  }
  const singleton = safeInteger(rows[0].singleton, {
    code: "invalid_schema_marker",
    field: "singleton",
  });
  const version = safeInteger(rows[0].version, {
    code: "invalid_schema_marker",
    field: "version",
    positive: true,
  });
  if (singleton !== 1 || version !== WORKFLOW_SCHEMA_VERSION) {
    reject("invalid_schema_marker", { reason: "unsupported_marker" });
  }
  return version;
}

function readDatabaseEncoding(database) {
  let row;
  try {
    row = database.prepare("PRAGMA main.encoding").get();
  } catch {
    reject("event_storage_invalid", {
      reason: "unreadable_database_encoding",
    });
  }
  const values = row ? Object.values(row) : [];
  const specification =
    values.length === 1 && typeof values[0] === "string"
      ? DATABASE_ENCODINGS[values[0]]
      : undefined;
  if (!specification) {
    reject("event_storage_invalid", {
      reason: "unsupported_database_encoding",
    });
  }
  return Object.freeze({
    decoder: new TextDecoder(specification.decoder, {
      fatal: true,
      ignoreBOM: true,
    }),
    multiplier: specification.multiplier,
  });
}

function storedTextLimit(encoding, maximumUtf8Bytes) {
  return encoding.multiplier * maximumUtf8Bytes;
}

function readHead(database, encoding) {
  const hashLimit = storedTextLimit(encoding, MAX_HASH_BYTES);
  let rows;
  try {
    rows = database
      .prepare(
        `
          SELECT
            CASE
              WHEN typeof(singleton) = 'integer' THEN singleton
            END AS singleton,
            CASE
              WHEN typeof(sequence) = 'integer' THEN sequence
            END AS sequence,
            CASE
              WHEN typeof(event_hash) = 'text'
                AND length(CAST(event_hash AS BLOB)) <= ${hashLimit}
                THEN event_hash
              ELSE NULL
            END AS event_hash
          FROM main.workflow_ledger_head
          LIMIT 2
        `,
      )
      .safeIntegers(true)
      .all();
  } catch {
    reject("invalid_ledger_head");
  }
  if (rows.length !== 1) {
    reject("invalid_ledger_head", { reason: "row_count" });
  }
  const singleton = safeInteger(rows[0].singleton, {
    code: "invalid_ledger_head",
    field: "singleton",
  });
  const sequence = safeInteger(rows[0].sequence, {
    code: "invalid_ledger_head",
    field: "sequence",
  });
  if (
    singleton !== 1 ||
    typeof rows[0].event_hash !== "string" ||
    !HASH_PATTERN.test(rows[0].event_hash) ||
    (sequence === 0 && rows[0].event_hash !== ZERO_HASH)
  ) {
    reject("invalid_ledger_head", { reason: "invalid_value" });
  }
  return { event_hash: rows[0].event_hash, sequence };
}

function eventInteger(value, field, position, { nullable = false, zero = false } = {}) {
  if (nullable && value === null) {
    return null;
  }
  return safeInteger(value, {
    code: "event_storage_invalid",
    field,
    positive: !zero,
    position,
  });
}

function eventText(value, field, position) {
  if (typeof value !== "string") {
    reject("event_storage_invalid", { field, position });
  }
  return value;
}

function assertNativeEventStorageFunctions(database) {
  let functions;
  try {
    functions = database
      .prepare("PRAGMA function_list")
      .safeIntegers(false)
      .iterate();
  } catch {
    reject("event_storage_invalid", { reason: "unreadable_function_list" });
  }
  try {
    for (const entry of functions) {
      if (
        entry.builtin === 0 &&
        typeof entry.name === "string" &&
        EVENT_STORAGE_FUNCTIONS.has(entry.name.toLowerCase()) &&
        (entry.narg === 1 || entry.narg === -1)
      ) {
        reject("event_storage_invalid", {
          reason: "unsafe_function_override",
        });
      }
    }
  } catch (error) {
    if (error instanceof WorkflowReplayError) {
      throw error;
    }
    reject("event_storage_invalid", { reason: "unreadable_function_list" });
  }
}

function decodeEventRow(row, position, encoding) {
  const stored = {
    actor_id: eventInteger(row.actor_id, "actor_id", position, {
      nullable: true,
    }),
    actor_role: eventText(row.actor_role, "actor_role", position),
    aggregate_id: eventInteger(row.aggregate_id, "aggregate_id", position),
    aggregate_version: eventInteger(
      row.aggregate_version,
      "aggregate_version",
      position,
      { zero: true },
    ),
    command_digest: eventText(row.command_digest, "command_digest", position),
    command_id: eventText(row.command_id, "command_id", position),
    event_hash: eventText(row.event_hash, "event_hash", position),
    event_type: eventText(row.event_type, "event_type", position),
    occurred_at: eventText(row.occurred_at, "occurred_at", position),
    previous_hash: eventText(row.previous_hash, "previous_hash", position),
    sequence: eventInteger(row.sequence, "sequence", position),
  };

  const eventJsonLength = eventInteger(
    row.event_json_length,
    "event_json",
    position,
  );
  if (
    row.event_json_type !== "text" ||
    eventJsonLength > storedTextLimit(encoding, MAX_CANONICAL_BYTES) ||
    !Buffer.isBuffer(row.event_json_bytes) ||
    row.event_json_bytes.length !== eventJsonLength
  ) {
    reject("event_storage_invalid", { field: "event_json", position });
  }

  let jsonText;
  try {
    jsonText = encoding.decoder.decode(row.event_json_bytes);
  } catch {
    reject("event_storage_invalid", {
      field: "event_json",
      position,
      reason: "invalid_text_encoding",
    });
  }

  let record;
  try {
    record = JSON.parse(jsonText);
  } catch {
    reject("event_storage_invalid", {
      field: "event_json",
      position,
      reason: "invalid_json",
    });
  }

  let suppliedCanonicalBytes;
  try {
    suppliedCanonicalBytes = canonicalJsonBytes(record);
  } catch {
    reject("event_storage_invalid", {
      field: "event_json",
      position,
      reason: "noncanonical_json",
    });
  }
  const suppliedUtf8Bytes = Buffer.from(jsonText, "utf8");
  if (!suppliedCanonicalBytes.equals(suppliedUtf8Bytes)) {
    reject("event_storage_invalid", {
      field: "event_json",
      position,
      reason: "noncanonical_bytes",
    });
  }

  let event;
  try {
    event = verifyLedgerEvent(record);
  } catch (error) {
    reject("event_contract_invalid", {
      position,
      reason:
        typeof error?.code === "string" ? error.code : "invalid_event_record",
    });
  }
  if (!canonicalJsonBytes(event).equals(suppliedUtf8Bytes)) {
    reject("event_storage_invalid", {
      field: "event_json",
      position,
      reason: "normalized_bytes_differ",
    });
  }

  const comparisons = [
    ["sequence", stored.sequence, event.sequence],
    ["event_hash", stored.event_hash, event.event_hash],
    ["previous_hash", stored.previous_hash, event.previous_hash],
    ["command_id", stored.command_id, event.command.command_id],
    ["command_digest", stored.command_digest, event.command_digest],
    ["event_type", stored.event_type, event.event_type],
    ["aggregate_id", stored.aggregate_id, event.aggregate.id],
    ["aggregate_version", stored.aggregate_version, event.aggregate.version],
    ["actor_id", stored.actor_id, event.actor.id],
    ["actor_role", stored.actor_role, event.actor.role],
    ["occurred_at", stored.occurred_at, event.occurred_at],
  ];
  const mismatch = comparisons.find(([, actual, expected]) => actual !== expected);
  if (mismatch) {
    reject("event_column_mismatch", { field: mismatch[0], position });
  }
  return event;
}

function transitionMismatch(position, reason) {
  reject("state_transition_mismatch", { position, reason });
}

function applyEvent(states, event, position) {
  const current = states.get(event.aggregate.id);
  const expectedVersion = current ? current.version + 1 : 0;
  if (event.aggregate.version !== expectedVersion) {
    reject("aggregate_version_mismatch", {
      actual_version: event.aggregate.version,
      expected_version: expectedVersion,
      position,
    });
  }

  if (event.aggregate.version === 0) {
    if (!["lead.created", "lead.imported"].includes(event.event_type)) {
      transitionMismatch(position, "missing_origin");
    }
    const imported = event.event_type === "lead.imported";
    states.set(event.aggregate.id, {
      assigned_to: event.payload.assigned_to,
      bound_created_at: imported ? null : event.occurred_at,
      bound_updated_at: imported ? null : event.occurred_at,
      status: event.payload.status,
      version: 0,
    });
    return;
  }

  if (!current) {
    transitionMismatch(position, "missing_origin");
  }
  if (event.event_type === "lead.claimed") {
    if (
      current.status !== "new" ||
      current.assigned_to !== null ||
      event.payload.status !== current.status ||
      event.payload.from_assigned_to !== current.assigned_to
    ) {
      transitionMismatch(position, "claim_before_state");
    }
    current.assigned_to = event.payload.to_assigned_to;
  } else if (event.event_type === "lead.assigned") {
    if (
      current.status !== event.payload.status ||
      current.assigned_to !== event.payload.from_assigned_to
    ) {
      transitionMismatch(position, "assignment_before_state");
    }
    current.assigned_to = event.payload.to_assigned_to;
  } else if (event.event_type === "lead.status_changed") {
    if (
      current.status !== event.payload.from_status ||
      current.assigned_to !== event.payload.assigned_to
    ) {
      transitionMismatch(position, "status_before_state");
    }
    current.status = event.payload.to_status;
  } else {
    transitionMismatch(position, "duplicate_origin");
  }
  current.version = event.aggregate.version;
  current.bound_updated_at = event.occurred_at;
}

function readEvents(database, encoding) {
  const actorRoleLimit = storedTextLimit(encoding, MAX_ACTOR_ROLE_BYTES);
  const commandIdLimit = storedTextLimit(encoding, MAX_COMMAND_ID_BYTES);
  const eventTypeLimit = storedTextLimit(encoding, MAX_EVENT_TYPE_BYTES);
  const hashLimit = storedTextLimit(encoding, MAX_HASH_BYTES);
  const timestampLimit = storedTextLimit(encoding, MAX_TIMESTAMP_BYTES);
  const eventJsonLimit = storedTextLimit(encoding, MAX_CANONICAL_BYTES);
  let invalidSequence;
  try {
    invalidSequence = database
      .prepare(`
        SELECT 1 AS invalid
        FROM main.workflow_events
        WHERE typeof(sequence) <> 'integer'
        LIMIT 1
      `)
      .get();
  } catch {
    reject("event_storage_invalid");
  }
  if (invalidSequence) {
    reject("event_storage_invalid", { field: "sequence" });
  }

  let iterator;
  try {
    iterator = database
      .prepare(`
        SELECT
          CASE
            WHEN typeof(sequence) = 'integer' THEN sequence
          END AS sequence,
          CASE
            WHEN typeof(event_hash) = 'text'
              AND length(CAST(event_hash AS BLOB)) <= ${hashLimit}
              THEN event_hash
            ELSE NULL
          END AS event_hash,
          CASE
            WHEN typeof(previous_hash) = 'text'
              AND length(CAST(previous_hash AS BLOB)) <= ${hashLimit}
              THEN previous_hash
            ELSE NULL
          END AS previous_hash,
          CASE
            WHEN typeof(command_id) = 'text'
              AND length(CAST(command_id AS BLOB)) <= ${commandIdLimit}
              THEN command_id
            ELSE NULL
          END AS command_id,
          CASE
            WHEN typeof(command_digest) = 'text'
              AND length(CAST(command_digest AS BLOB)) <= ${hashLimit}
              THEN command_digest
            ELSE NULL
          END AS command_digest,
          CASE
            WHEN typeof(event_type) = 'text'
              AND length(CAST(event_type AS BLOB)) <= ${eventTypeLimit}
              THEN event_type
            ELSE NULL
          END AS event_type,
          CASE
            WHEN typeof(aggregate_id) = 'integer' THEN aggregate_id
          END AS aggregate_id,
          CASE
            WHEN typeof(aggregate_version) = 'integer' THEN aggregate_version
          END AS aggregate_version,
          CASE
            WHEN actor_id IS NULL THEN NULL
            WHEN typeof(actor_id) = 'integer' THEN actor_id
            ELSE 0
          END AS actor_id,
          CASE
            WHEN typeof(actor_role) = 'text'
              AND length(CAST(actor_role AS BLOB)) <= ${actorRoleLimit}
              THEN actor_role
            ELSE NULL
          END AS actor_role,
          CASE
            WHEN typeof(occurred_at) = 'text'
              AND length(CAST(occurred_at AS BLOB)) <= ${timestampLimit}
              THEN occurred_at
            ELSE NULL
          END AS occurred_at,
          typeof(event_json) AS event_json_type,
          length(CAST(event_json AS BLOB)) AS event_json_length,
          CASE
            WHEN typeof(event_json) = 'text'
              AND length(CAST(event_json AS BLOB)) <= ${eventJsonLimit}
              THEN CAST(event_json AS BLOB)
            ELSE NULL
          END AS event_json_bytes
        FROM main.workflow_events AS stored_event
        ORDER BY stored_event.sequence
      `)
      .safeIntegers(true)
      .iterate();
  } catch {
    reject("event_storage_invalid");
  }

  const commandIds = new Set();
  const eventHashes = new Set();
  const states = new Map();
  let eventCount = 0;
  let previousHash = ZERO_HASH;
  try {
    for (const row of iterator) {
      const position = eventCount + 1;
      const event = decodeEventRow(row, position, encoding);
      if (commandIds.has(event.command.command_id)) {
        reject("duplicate_command_id", { position });
      }
      if (eventHashes.has(event.event_hash)) {
        reject("duplicate_event_hash", { position });
      }
      if (event.sequence !== position) {
        reject("global_sequence_mismatch", {
          actual_sequence: event.sequence,
          expected_sequence: position,
          position,
        });
      }
      if (event.previous_hash !== previousHash) {
        reject("previous_hash_mismatch", { position });
      }
      applyEvent(states, event, position);
      commandIds.add(event.command.command_id);
      eventHashes.add(event.event_hash);
      previousHash = event.event_hash;
      eventCount = position;
    }
  } catch (error) {
    if (error instanceof WorkflowReplayError) {
      throw error;
    }
    reject("event_storage_invalid", { position: eventCount + 1 });
  }
  return { eventCount, finalHash: previousHash, states };
}

function projectionInteger(value, field, position, { nullable = false, zero = false } = {}) {
  if (nullable && value === null) {
    return null;
  }
  return safeInteger(value, {
    code: "projection_mismatch",
    field,
    positive: !zero,
    position,
  });
}

function reconcileProjections(database, states, encoding) {
  const statusLimit = storedTextLimit(encoding, MAX_PROJECTION_STATUS_BYTES);
  const timestampLimit = storedTextLimit(encoding, MAX_TIMESTAMP_BYTES);
  let invalidId;
  try {
    invalidId = database
      .prepare(`
        SELECT 1 AS invalid
        FROM main.leads
        WHERE typeof(id) <> 'integer'
        LIMIT 1
      `)
      .get();
  } catch {
    reject("projection_mismatch", { reason: "unreadable_projection" });
  }
  if (invalidId) {
    reject("projection_mismatch", { field: "id" });
  }

  let iterator;
  try {
    iterator = database
      .prepare(`
        SELECT
          CASE WHEN typeof(id) = 'integer' THEN id END AS id,
          CASE
            WHEN typeof(status) = 'text'
              AND length(CAST(status AS BLOB)) <= ${statusLimit}
              THEN status
          END AS status,
          CASE
            WHEN assigned_to IS NULL THEN NULL
            WHEN typeof(assigned_to) = 'integer' THEN assigned_to
            ELSE 0
          END AS assigned_to,
          CASE
            WHEN typeof(workflow_version) = 'integer' THEN workflow_version
          END AS workflow_version,
          CASE
            WHEN archived_at IS NULL THEN NULL
            WHEN typeof(archived_at) = 'text'
              AND length(CAST(archived_at AS BLOB)) <= ${timestampLimit}
              THEN archived_at
            ELSE 0
          END AS archived_at,
          CASE
            WHEN created_at IS NULL THEN NULL
            WHEN typeof(created_at) = 'text'
              AND length(CAST(created_at AS BLOB)) <= ${timestampLimit}
              THEN created_at
            ELSE 0
          END AS created_at,
          CASE
            WHEN updated_at IS NULL THEN NULL
            WHEN typeof(updated_at) = 'text'
              AND length(CAST(updated_at AS BLOB)) <= ${timestampLimit}
              THEN updated_at
            ELSE 0
          END AS updated_at
        FROM main.leads AS projection
        ORDER BY projection.id
      `)
      .safeIntegers(true)
      .iterate();
  } catch {
    reject("projection_mismatch", { reason: "unreadable_projection" });
  }

  const seen = new Set();
  let position = 0;
  try {
    for (const row of iterator) {
      position += 1;
      const id = projectionInteger(row.id, "id", position);
      if (seen.has(id)) {
        reject("projection_mismatch", {
          field: "id",
          position,
          reason: "duplicate_projection",
        });
      }
      const state = states.get(id);
      if (!state) {
        reject("projection_mismatch", {
          position,
          reason: "projection_without_origin",
        });
      }
      const assignedTo = projectionInteger(
        row.assigned_to,
        "assigned_to",
        position,
        { nullable: true },
      );
      const version = projectionInteger(
        row.workflow_version,
        "workflow_version",
        position,
        { zero: true },
      );
      const comparisons = [
        ["status", row.status, state.status],
        ["assigned_to", assignedTo, state.assigned_to],
        ["workflow_version", version, state.version],
        ["archived_at", row.archived_at, null],
      ];
      if (state.bound_created_at !== null) {
        comparisons.push(["created_at", row.created_at, state.bound_created_at]);
      }
      if (state.bound_updated_at !== null) {
        comparisons.push(["updated_at", row.updated_at, state.bound_updated_at]);
      }
      const mismatch = comparisons.find(
        ([, actual, expected]) => actual !== expected,
      );
      if (mismatch) {
        reject("projection_mismatch", { field: mismatch[0], position });
      }
      seen.add(id);
    }
  } catch (error) {
    if (error instanceof WorkflowReplayError) {
      throw error;
    }
    reject("projection_mismatch", {
      position: position + 1,
      reason: "unreadable_projection",
    });
  }

  if (seen.size !== states.size) {
    reject("projection_mismatch", { reason: "missing_projection" });
  }
}

function replaySnapshot(database) {
  assertReplayConnectionSettings(database);
  assertNativeEventStorageFunctions(database);
  assertBoundedSchemaMetadata(database);
  assertWorkflowEnabled(database);
  assertRequiredColumnsAreStored(database);
  const encoding = readDatabaseEncoding(database);
  assertDatabaseIntegrity(database);
  assertForeignKeys(database);
  const schemaVersion = readSchemaVersion(database);
  const head = readHead(database, encoding);
  const replay = readEvents(database, encoding);
  reconcileProjections(database, replay.states, encoding);

  if (
    head.sequence !== replay.eventCount ||
    head.event_hash !== replay.finalHash
  ) {
    reject("ledger_head_mismatch", {
      reason:
        head.sequence !== replay.eventCount ? "sequence" : "event_hash",
    });
  }

  return deepFreeze({
    aggregate_count: replay.states.size,
    event_count: replay.eventCount,
    head: {
      event_hash: head.event_hash,
      sequence: head.sequence,
    },
    schema_version: schemaVersion,
  });
}

function replayWorkflowLedger(database) {
  if (database?.inTransaction === true) {
    reject("replay_requires_idle_connection");
  }
  let transaction;
  try {
    transaction = database.transaction(() => replaySnapshot(database));
  } catch {
    reject("replay_requires_idle_connection");
  }
  try {
    return transaction.deferred();
  } catch (error) {
    if (error instanceof WorkflowReplayError) {
      throw error;
    }
    reject("replay_requires_idle_connection");
  }
}

module.exports = {
  WorkflowReplayError,
  replayWorkflowLedger,
};
