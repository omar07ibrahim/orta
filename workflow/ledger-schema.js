"use strict";

const { randomBytes } = require("node:crypto");

const { canonicalJsonBytes } = require("./canonical-json");
const {
  EVENT_SCHEMA,
  ZERO_HASH,
  createLedgerEvent,
} = require("./ledger-contract");

const WORKFLOW_SCHEMA_VERSION = 1;

class WorkflowSchemaError extends Error {
  constructor(code, details = {}) {
    super(`Workflow schema rejected: ${code}`);
    this.name = "WorkflowSchemaError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function reject(code, details) {
  throw new WorkflowSchemaError(code, details);
}

function defaultClock() {
  return new Date();
}

function defaultCommandIdGenerator() {
  return `cmd_${randomBytes(16).toString("hex")}`;
}

function clockTimestamp(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    reject("invalid_clock");
  }
  return value.toISOString();
}

function tableColumns(database, tableName) {
  return new Set(
    database
      .prepare(`PRAGMA main.table_info(${tableName})`)
      .all()
      .map((column) => column.name),
  );
}

function addColumnIfMissing(database, tableName, columnName, definition) {
  if (!tableColumns(database, tableName).has(columnName)) {
    database.exec(`ALTER TABLE main.${tableName} ADD COLUMN ${definition}`);
  }
}

const PROTECTED_MAIN_OBJECTS = Object.freeze([
  "ai_chats",
  "leads",
  "users",
  "workflow_events",
  "workflow_ledger_head",
  "workflow_schema",
]);

function assertNoProtectedTempObjects(database) {
  const placeholders = PROTECTED_MAIN_OBJECTS.map(() => "?").join(", ");
  const shadow = database
    .prepare(`
      SELECT type, name, tbl_name
      FROM temp.sqlite_master
      WHERE name IN (${placeholders})
         OR tbl_name IN (${placeholders})
      ORDER BY type, name
      LIMIT 1
    `)
    .get(...PROTECTED_MAIN_OBJECTS, ...PROTECTED_MAIN_OBJECTS);
  if (shadow) {
    reject("protected_temp_shadow", {
      object: shadow.name,
      object_type: shadow.type,
      table: shadow.tbl_name,
    });
  }
}

const WORKFLOW_TABLE_DEFINITIONS = Object.freeze({
  workflow_schema: `
    CREATE TABLE workflow_schema (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL CHECK(version > 0)
    ) STRICT
  `,
  workflow_ledger_head: `
    CREATE TABLE workflow_ledger_head (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      event_hash TEXT NOT NULL
        CHECK(length(event_hash) = 64)
        CHECK(event_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK(sequence > 0 OR event_hash = '${ZERO_HASH}')
    ) STRICT
  `,
  workflow_events: `
    CREATE TABLE workflow_events (
      sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
      event_hash TEXT NOT NULL UNIQUE
        CHECK(length(event_hash) = 64)
        CHECK(event_hash NOT GLOB '*[^0-9a-f]*'),
      previous_hash TEXT NOT NULL UNIQUE
        CHECK(length(previous_hash) = 64)
        CHECK(previous_hash NOT GLOB '*[^0-9a-f]*'),
      command_id TEXT NOT NULL UNIQUE
        CHECK(length(command_id) = 36)
        CHECK(substr(command_id, 1, 4) = 'cmd_')
        CHECK(substr(command_id, 5) NOT GLOB '*[^0-9a-f]*'),
      command_digest TEXT NOT NULL
        CHECK(length(command_digest) = 64)
        CHECK(command_digest NOT GLOB '*[^0-9a-f]*'),
      event_type TEXT NOT NULL,
      aggregate_id INTEGER NOT NULL,
      aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 0),
      actor_id INTEGER,
      actor_role TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL CHECK(json_valid(event_json)),
      UNIQUE(aggregate_id, aggregate_version),
      FOREIGN KEY (aggregate_id) REFERENCES leads(id) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT
  `,
});

const WORKFLOW_INDEX_DEFINITIONS = Object.freeze({
  idx_workflow_events_aggregate: `
    CREATE INDEX idx_workflow_events_aggregate
      ON workflow_events(aggregate_id, sequence)
  `,
  idx_workflow_events_occurred_at: `
    CREATE INDEX idx_workflow_events_occurred_at
      ON workflow_events(occurred_at)
  `,
});

const WORKFLOW_TRIGGER_DEFINITIONS = Object.freeze({
  workflow_events_no_update: `
    CREATE TRIGGER workflow_events_no_update
    BEFORE UPDATE ON workflow_events
    BEGIN
      SELECT RAISE(ABORT, 'workflow_events_append_only');
    END
  `,
  workflow_events_append_guard: `
    CREATE TRIGGER workflow_events_append_guard
    BEFORE INSERT ON workflow_events
    WHEN NEW.sequence <> COALESCE((
           SELECT sequence + 1
           FROM workflow_ledger_head
           WHERE singleton = 1
         ), -1)
      OR NEW.previous_hash <> COALESCE((
           SELECT event_hash
           FROM workflow_ledger_head
           WHERE singleton = 1
         ), '')
    BEGIN
      SELECT RAISE(ABORT, 'workflow_event_not_next');
    END
  `,
  workflow_events_no_delete: `
    CREATE TRIGGER workflow_events_no_delete
    BEFORE DELETE ON workflow_events
    BEGIN
      SELECT RAISE(ABORT, 'workflow_events_append_only');
    END
  `,
  workflow_head_insert_guard: `
    CREATE TRIGGER workflow_head_insert_guard
    BEFORE INSERT ON workflow_ledger_head
    WHEN EXISTS(SELECT 1 FROM workflow_ledger_head)
      OR NEW.singleton <> 1
      OR NEW.sequence <> 0
      OR NEW.event_hash <> '${ZERO_HASH}'
    BEGIN
      SELECT RAISE(ABORT, 'workflow_head_invalid_origin');
    END
  `,
  workflow_head_update_guard: `
    CREATE TRIGGER workflow_head_update_guard
    BEFORE UPDATE ON workflow_ledger_head
    WHEN NEW.singleton <> OLD.singleton
      OR NEW.sequence <> OLD.sequence + 1
      OR NOT EXISTS (
        SELECT 1
        FROM workflow_events
        WHERE sequence = NEW.sequence
          AND event_hash = NEW.event_hash
          AND previous_hash = OLD.event_hash
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow_head_not_next');
    END
  `,
  workflow_head_no_delete: `
    CREATE TRIGGER workflow_head_no_delete
    BEFORE DELETE ON workflow_ledger_head
    BEGIN
      SELECT RAISE(ABORT, 'workflow_head_required');
    END
  `,
  workflow_leads_insert_guard: `
    CREATE TRIGGER workflow_leads_insert_guard
    BEFORE INSERT ON leads
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_events AS event
      WHERE event.sequence = (
          SELECT sequence + 1
          FROM workflow_ledger_head
          WHERE singleton = 1
        )
        AND event.aggregate_id = NEW.id
        AND event.aggregate_version = 0
        AND NEW.workflow_version = 0
        AND NEW.archived_at IS NULL
        AND event.event_type IN ('lead.created', 'lead.imported')
        AND json_extract(event.event_json, '$.payload.status') IS NEW.status
        AND json_extract(event.event_json, '$.payload.assigned_to')
          IS NEW.assigned_to
        AND NEW.created_at IS event.occurred_at
        AND NEW.updated_at IS event.occurred_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow_projection_event_required');
    END
  `,
  workflow_leads_update_guard: `
    CREATE TRIGGER workflow_leads_update_guard
    BEFORE UPDATE ON leads
    WHEN NEW.id <> OLD.id
      OR NEW.name IS NOT OLD.name
      OR NEW.email IS NOT OLD.email
      OR NEW.phone IS NOT OLD.phone
      OR NEW.message IS NOT OLD.message
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.archived_at IS NOT OLD.archived_at
      OR NEW.workflow_version <> OLD.workflow_version + 1
      OR NOT EXISTS (
        SELECT 1
        FROM workflow_events AS event
        WHERE event.sequence = (
            SELECT sequence + 1
            FROM workflow_ledger_head
            WHERE singleton = 1
          )
          AND event.aggregate_id = OLD.id
          AND event.aggregate_version = NEW.workflow_version
          AND (
            (
              event.event_type = 'lead.claimed'
              AND OLD.status = 'new'
              AND OLD.assigned_to IS NULL
              AND NEW.status IS OLD.status
              AND json_extract(
                event.event_json,
                '$.payload.from_assigned_to'
              ) IS OLD.assigned_to
              AND json_extract(event.event_json, '$.payload.status')
                IS OLD.status
              AND json_extract(event.event_json, '$.payload.to_assigned_to')
                IS NEW.assigned_to
            )
            OR (
              event.event_type = 'lead.assigned'
              AND NEW.status IS OLD.status
              AND json_extract(
                event.event_json,
                '$.payload.from_assigned_to'
              ) IS OLD.assigned_to
              AND json_extract(event.event_json, '$.payload.status')
                IS OLD.status
              AND json_extract(event.event_json, '$.payload.to_assigned_to')
                IS NEW.assigned_to
            )
            OR (
              event.event_type = 'lead.status_changed'
              AND NEW.assigned_to IS OLD.assigned_to
              AND json_extract(event.event_json, '$.payload.assigned_to')
                IS OLD.assigned_to
              AND json_extract(event.event_json, '$.payload.from_status')
                IS OLD.status
              AND json_extract(event.event_json, '$.payload.to_status')
                IS NEW.status
            )
          )
          AND NEW.updated_at IS event.occurred_at
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow_projection_event_required');
    END
  `,
  workflow_leads_delete_guard: `
    CREATE TRIGGER workflow_leads_delete_guard
    BEFORE DELETE ON leads
    BEGIN
      SELECT RAISE(ABORT, 'workflow_projection_delete_unsupported');
    END
  `,
});

function normalizeSql(value) {
  return value.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
}

function inMainSchema(definition, objectType, { ifNotExists = false } = {}) {
  return definition.replace(
    new RegExp(`^(\\s*)CREATE ${objectType} ([a-z_][a-z0-9_]*)`, "iu"),
    `$1CREATE ${objectType}${ifNotExists ? " IF NOT EXISTS" : ""} main.$2`,
  );
}

function sqliteDefinition(database, type, name) {
  return database
    .prepare("SELECT sql FROM main.sqlite_master WHERE type = ? AND name = ?")
    .get(type, name)?.sql;
}

function assertDefinition(database, type, name, expected) {
  const actual = sqliteDefinition(database, type, name);
  if (!actual || normalizeSql(actual) !== normalizeSql(expected)) {
    reject("unsupported_schema_definition", { object: name });
  }
}

function assertManagedSchemaOrigin(database) {
  const managedTableNames = Object.keys(WORKFLOW_TABLE_DEFINITIONS);
  const placeholders = managedTableNames.map(() => "?").join(", ");
  const existingTables = database
    .prepare(`
      SELECT name
      FROM main.sqlite_master
      WHERE type = 'table' AND name IN (${placeholders})
      ORDER BY name
    `)
    .all(...managedTableNames)
    .map((row) => row.name);
  if (existingTables.length === 0) {
    return;
  }
  if (
    existingTables.length !== managedTableNames.length ||
    managedTableNames.some((name) => !existingTables.includes(name))
  ) {
    reject("unmanaged_workflow_schema");
  }

  for (const [name, definition] of Object.entries(WORKFLOW_TABLE_DEFINITIONS)) {
    assertDefinition(database, "table", name, definition);
  }
  const marker = database
    .prepare("SELECT version FROM main.workflow_schema WHERE singleton = 1")
    .get();
  if (!marker || marker.version !== WORKFLOW_SCHEMA_VERSION) {
    reject("unmanaged_workflow_schema");
  }
}

function createWorkflowTables(database) {
  for (const definition of Object.values(WORKFLOW_TABLE_DEFINITIONS)) {
    database.exec(inMainSchema(definition, "TABLE", { ifNotExists: true }));
  }
  for (const definition of Object.values(WORKFLOW_INDEX_DEFINITIONS)) {
    database.exec(inMainSchema(definition, "INDEX", { ifNotExists: true }));
  }
}

function dropWorkflowTriggers(database) {
  for (const name of Object.keys(WORKFLOW_TRIGGER_DEFINITIONS)) {
    database.exec(`DROP TRIGGER IF EXISTS main.${name}`);
  }
}

function replaceWorkflowTriggers(database) {
  dropWorkflowTriggers(database);
  for (const definition of Object.values(WORKFLOW_TRIGGER_DEFINITIONS)) {
    database.exec(inMainSchema(definition, "TRIGGER"));
  }
}

function assertWorkflowDefinitions(database) {
  for (const [name, definition] of Object.entries(WORKFLOW_TABLE_DEFINITIONS)) {
    assertDefinition(database, "table", name, definition);
  }
  for (const [name, definition] of Object.entries(WORKFLOW_INDEX_DEFINITIONS)) {
    assertDefinition(database, "index", name, definition);
  }
  for (const [name, definition] of Object.entries(WORKFLOW_TRIGGER_DEFINITIONS)) {
    assertDefinition(database, "trigger", name, definition);
  }

  const protectedTables = [
    "leads",
    "workflow_events",
    "workflow_ledger_head",
    "workflow_schema",
  ];
  const placeholders = protectedTables.map(() => "?").join(", ");
  const allowedTriggers = new Set(Object.keys(WORKFLOW_TRIGGER_DEFINITIONS));
  const unexpectedTrigger = database
    .prepare(`
      SELECT name
      FROM main.sqlite_master
      WHERE type = 'trigger' AND tbl_name IN (${placeholders})
      ORDER BY name
    `)
    .all(...protectedTables)
    .find((row) => !allowedTriggers.has(row.name));
  if (unexpectedTrigger) {
    reject("unexpected_workflow_trigger", {
      trigger: unexpectedTrigger.name,
    });
  }
}

function assertWorkflowTableShape(database) {
  const requiredColumns = {
    workflow_events: [
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
    ],
    workflow_ledger_head: ["event_hash", "sequence", "singleton"],
    workflow_schema: ["singleton", "version"],
  };

  for (const [tableName, expectedColumns] of Object.entries(requiredColumns)) {
    const actualColumns = tableColumns(database, tableName);
    if (
      actualColumns.size !== expectedColumns.length ||
      expectedColumns.some((column) => !actualColumns.has(column))
    ) {
      reject("unsupported_table_shape", { table: tableName });
    }
  }
}

function assertWorkflowBaseColumns(database) {
  const expectations = [
    ["users", "auth_version", "INTEGER", 1, "1"],
    [
      "leads",
      "workflow_version",
      "INTEGER",
      1,
      "0",
    ],
    ["leads", "archived_at", "TEXT", 0, null],
  ];
  for (const [table, name, type, notnull, defaultValue] of expectations) {
    const column = database
      .prepare(`PRAGMA main.table_info(${table})`)
      .all()
      .find((candidate) => candidate.name === name);
    if (
      !column ||
      column.type.toUpperCase() !== type ||
      column.notnull !== notnull ||
      column.dflt_value !== defaultValue
    ) {
      reject("unsupported_base_column", { column: name, table });
    }
  }
}

function assertCheckConstraint(database, operation, details) {
  database.exec("SAVEPOINT workflow_constraint_probe");
  let checkRejected = false;
  try {
    operation();
  } catch (error) {
    checkRejected = error?.code === "SQLITE_CONSTRAINT_CHECK";
  } finally {
    database.exec("ROLLBACK TO workflow_constraint_probe");
    database.exec("RELEASE workflow_constraint_probe");
  }
  if (!checkRejected) {
    reject("unsupported_base_constraint", details);
  }
}

function assertWorkflowBaseConstraints(database) {
  const probeEmail = `workflow-probe-${randomBytes(16).toString("hex")}@example.invalid`;
  assertCheckConstraint(
    database,
    () =>
      database
        .prepare(`
          INSERT INTO main.users (
            email, password, role, name, phone, auth_version
          ) VALUES (?, 'unused-probe-hash', 'student', 'Constraint Probe', NULL, 0)
        `)
        .run(probeEmail),
    { column: "auth_version", table: "users" },
  );
  assertCheckConstraint(
    database,
    () =>
      database
        .prepare(`
          INSERT INTO main.leads (
            name, phone, status, workflow_version
          ) VALUES ('Constraint Probe', '+0', 'new', -1)
        `)
        .run(),
    { column: "workflow_version", table: "leads" },
  );
}

function insertEvent(database, event) {
  const result = database
    .prepare(`
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
      ) VALUES (
        @sequence,
        @event_hash,
        @previous_hash,
        @command_id,
        @command_digest,
        @event_type,
        @aggregate_id,
        @aggregate_version,
        @actor_id,
        @actor_role,
        @occurred_at,
        @event_json
      )
    `)
    .run({
      actor_id: event.actor.id,
      actor_role: event.actor.role,
      aggregate_id: event.aggregate.id,
      aggregate_version: event.aggregate.version,
      command_digest: event.command_digest,
      command_id: event.command.command_id,
      event_hash: event.event_hash,
      event_json: canonicalJsonBytes(event).toString("utf8"),
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      previous_hash: event.previous_hash,
      sequence: event.sequence,
    });

  if (result.changes !== 1) {
    reject("event_insert_failed");
  }
}

function advanceHead(database, previousHead, event) {
  const result = database
    .prepare(`
      UPDATE main.workflow_ledger_head
      SET sequence = ?, event_hash = ?
      WHERE singleton = 1 AND sequence = ? AND event_hash = ?
    `)
    .run(
      event.sequence,
      event.event_hash,
      previousHead.sequence,
      previousHead.event_hash,
    );

  if (result.changes !== 1) {
    reject("head_compare_and_swap_failed");
  }
}

function assertHeadMatchesEvents(database) {
  const head = database
    .prepare(
      "SELECT sequence, event_hash FROM main.workflow_ledger_head WHERE singleton = 1",
    )
    .get();
  if (!head) {
    reject("missing_ledger_head");
  }

  const summary = database
    .prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS maximum_sequence
      FROM main.workflow_events
    `)
    .get();
  if (
    summary.count !== head.sequence ||
    summary.maximum_sequence !== head.sequence
  ) {
    reject("ledger_head_sequence_mismatch");
  }

  if (head.sequence === 0) {
    if (head.event_hash !== ZERO_HASH) {
      reject("ledger_head_hash_mismatch");
    }
    return head;
  }

  const finalEvent = database
    .prepare("SELECT event_hash FROM main.workflow_events WHERE sequence = ?")
    .get(head.sequence);
  if (!finalEvent || finalEvent.event_hash !== head.event_hash) {
    reject("ledger_head_hash_mismatch");
  }
  return head;
}

function assertEveryLeadCovered(database) {
  const uncovered = database
    .prepare(`
      SELECT l.id
      FROM main.leads AS l
      LEFT JOIN (
        SELECT aggregate_id, MAX(aggregate_version) AS latest_version
        FROM main.workflow_events
        GROUP BY aggregate_id
      ) AS latest ON latest.aggregate_id = l.id
      WHERE latest.latest_version IS NULL
         OR latest.latest_version <> l.workflow_version
      ORDER BY l.id
      LIMIT 1
    `)
    .get();
  if (uncovered) {
    reject("lead_projection_not_covered", { lead_id: uncovered.id });
  }
}

function importLegacyLeads(database, options) {
  let head = assertHeadMatchesEvents(database);
  if (head.sequence !== 0) {
    return;
  }

  const leads = database
    .prepare(`
      SELECT id, status, assigned_to, workflow_version, archived_at
      FROM main.leads
      ORDER BY id
    `)
    .safeIntegers(true)
    .all();
  const findUserRole = database.prepare(
    "SELECT role FROM main.users WHERE id = ?",
  );

  for (const rawLead of leads) {
    const leadId = Number(rawLead.id);
    const assignedTo =
      rawLead.assigned_to === null ? null : Number(rawLead.assigned_to);
    const workflowVersion = Number(rawLead.workflow_version);
    if (!Number.isSafeInteger(leadId) || leadId <= 0) {
      reject("legacy_lead_id_not_safe");
    }
    if (
      assignedTo !== null &&
      (!Number.isSafeInteger(assignedTo) || assignedTo <= 0)
    ) {
      reject("legacy_assignee_id_not_safe", { lead_id: leadId });
    }
    if (!Number.isSafeInteger(workflowVersion) || workflowVersion !== 0) {
      reject("legacy_lead_version_mismatch", { lead_id: leadId });
    }
    if (rawLead.archived_at !== null) {
      reject("legacy_archive_unsupported", { lead_id: leadId });
    }
    if (!["new", "contacted", "converted", "rejected"].includes(rawLead.status)) {
      reject("legacy_status_invalid", { lead_id: leadId });
    }
    if (assignedTo === null && rawLead.status !== "new") {
      reject("legacy_unassigned_state", { lead_id: leadId });
    }

    let assignedRole = null;
    if (assignedTo !== null) {
      const assignee = findUserRole.get(rawLead.assigned_to);
      if (!assignee || assignee.role !== "sales") {
        reject("legacy_assignment_not_sales", { lead_id: leadId });
      }
      assignedRole = "sales";
    }

    const command = {
      action: "lead.import",
      assigned_role: assignedRole,
      assigned_to: assignedTo,
      command_id: options.commandIdGenerator(),
      lead_id: leadId,
      status: rawLead.status,
    };
    const event = createLedgerEvent({
      actor: { id: null, role: "system" },
      aggregate: { id: leadId, type: "lead", version: 0 },
      command,
      event_type: "lead.imported",
      occurred_at: clockTimestamp(options.clock),
      payload: {
        assigned_role: assignedRole,
        assigned_to: assignedTo,
        status: rawLead.status,
      },
      previous_hash: head.event_hash,
      schema: EVENT_SCHEMA,
      sequence: head.sequence + 1,
    });

    insertEvent(database, event);
    advanceHead(database, head, event);
    head = { event_hash: event.event_hash, sequence: event.sequence };
  }
}

function initializeWorkflowSchema(
  database,
  {
    clock = defaultClock,
    commandIdGenerator = defaultCommandIdGenerator,
  } = {},
) {
  if (typeof clock !== "function" || typeof commandIdGenerator !== "function") {
    reject("invalid_migration_dependency");
  }
  const migrate = database.transaction(() => {
    assertNoProtectedTempObjects(database);
    assertManagedSchemaOrigin(database);
    dropWorkflowTriggers(database);
    addColumnIfMissing(
      database,
      "users",
      "auth_version",
      "auth_version INTEGER NOT NULL DEFAULT 1 CHECK(auth_version > 0)",
    );
    addColumnIfMissing(
      database,
      "leads",
      "workflow_version",
      "workflow_version INTEGER NOT NULL DEFAULT 0 CHECK(workflow_version >= 0)",
    );
    addColumnIfMissing(
      database,
      "leads",
      "archived_at",
      "archived_at TEXT",
    );
    assertWorkflowBaseColumns(database);
    assertWorkflowBaseConstraints(database);
    createWorkflowTables(database);
    assertWorkflowTableShape(database);
    replaceWorkflowTriggers(database);
    assertWorkflowDefinitions(database);

    const existingSchema = database
      .prepare("SELECT version FROM main.workflow_schema WHERE singleton = 1")
      .get();
    const existingEventCount = database
      .prepare("SELECT COUNT(*) AS count FROM main.workflow_events")
      .get().count;
    const existingHead = database
      .prepare(
        "SELECT sequence, event_hash FROM main.workflow_ledger_head WHERE singleton = 1",
      )
      .get();
    if (
      !existingSchema &&
      (existingEventCount > 0 || (existingHead && existingHead.sequence > 0))
    ) {
      reject("unmanaged_populated_ledger");
    }

    database
      .prepare(
        "INSERT OR IGNORE INTO main.workflow_schema (singleton, version) VALUES (1, ?)",
      )
      .run(WORKFLOW_SCHEMA_VERSION);
    const schema = database
      .prepare("SELECT version FROM main.workflow_schema WHERE singleton = 1")
      .get();
    if (!schema || schema.version !== WORKFLOW_SCHEMA_VERSION) {
      reject("unsupported_schema_version");
    }

    database
      .prepare(`
        INSERT INTO main.workflow_ledger_head (
          singleton, sequence, event_hash
        )
        SELECT 1, 0, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM main.workflow_ledger_head WHERE singleton = 1
        )
      `)
      .run(ZERO_HASH);

    importLegacyLeads(database, { clock, commandIdGenerator });
    assertHeadMatchesEvents(database);
    assertEveryLeadCovered(database);
  });

  migrate.immediate();
}

module.exports = {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowSchemaError,
  assertEveryLeadCovered,
  assertHeadMatchesEvents,
  assertNoProtectedTempObjects,
  clockTimestamp,
  defaultClock,
  defaultCommandIdGenerator,
  initializeWorkflowSchema,
};
