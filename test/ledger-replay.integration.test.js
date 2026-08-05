"use strict";

const assert = require("node:assert/strict");
const { copyFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");

const { openDatabase } = require("../database-core");
const {
  MAX_CANONICAL_BYTES,
  canonicalJsonBytes,
} = require("../workflow/canonical-json");
const { createLedgerEvent } = require("../workflow/ledger-contract");
const {
  WorkflowReplayError,
  replayWorkflowLedger,
} = require("../workflow/ledger-replay");
const { createWorkflowStore } = require("../workflow/ledger-store");

const ZERO_HASH = "0".repeat(64);

function commandId(index) {
  return `cmd_${index.toString(16).padStart(32, "0")}`;
}

function advancingClock(start = Date.UTC(2026, 7, 5, 4, 0, 0)) {
  let offset = 0;
  return () => {
    const value = new Date(start + offset * 1_000);
    offset += 1;
    return value;
  };
}

function syntheticContact(index) {
  return {
    email: `applicant-${index}@example.invalid`,
    message: `Synthetic programme enquiry ${index}.`,
    name: `Synthetic Applicant ${index}`,
    phone: `+1-202-555-${(100 + index).toString().padStart(4, "0")}`,
  };
}

function createManagedFixture(context) {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-replay-"));
  const filename = path.join(directory, "source.sqlite");
  const connections = new Set();
  const database = openDatabase({
    enableWorkflowLedger: true,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
    filename,
  });
  connections.add(database);
  context.after(() => {
    for (const connection of connections) {
      if (connection.open) {
        connection.close();
      }
    }
    rmSync(directory, { force: true, recursive: true });
  });

  const insertUser = database.prepare(`
    INSERT INTO main.users (email, password, role, name, phone)
    VALUES (?, 'test-only-non-secret', ?, ?, NULL)
  `);
  const users = {
    admin: Number(
      insertUser.run(
        "replay-admin@example.invalid",
        "admin",
        "Synthetic Replay Admin",
      ).lastInsertRowid,
    ),
    salesA: Number(
      insertUser.run(
        "replay-sales-a@example.invalid",
        "sales",
        "Synthetic Replay Sales A",
      ).lastInsertRowid,
    ),
    salesB: Number(
      insertUser.run(
        "replay-sales-b@example.invalid",
        "sales",
        "Synthetic Replay Sales B",
      ).lastInsertRowid,
    ),
  };
  const store = createWorkflowStore(database, { clock: advancingClock() });

  return {
    connections,
    database,
    directory,
    filename,
    store,
    users,
  };
}

function populateLifecycle(fixture) {
  const first = fixture.store.createLead({
    commandId: commandId(1),
    contact: syntheticContact(1),
  });
  fixture.store.claimLead({
    actorAuthVersion: 1,
    actorId: fixture.users.salesA,
    commandId: commandId(2),
    expectedVersion: 0,
    leadId: first.current_projection.id,
  });
  fixture.store.assignLead({
    actorAuthVersion: 1,
    actorId: fixture.users.admin,
    commandId: commandId(3),
    expectedVersion: 1,
    leadId: first.current_projection.id,
    toAssignedTo: fixture.users.salesB,
  });
  fixture.store.transitionLead({
    actorAuthVersion: 1,
    actorId: fixture.users.salesB,
    commandId: commandId(4),
    expectedVersion: 2,
    leadId: first.current_projection.id,
    toStatus: "contacted",
  });
  fixture.store.transitionLead({
    actorAuthVersion: 1,
    actorId: fixture.users.admin,
    commandId: commandId(5),
    expectedVersion: 3,
    leadId: first.current_projection.id,
    toStatus: "converted",
  });

  const second = fixture.store.createLead({
    commandId: commandId(6),
    contact: syntheticContact(2),
  });
  fixture.store.assignLead({
    actorAuthVersion: 1,
    actorId: fixture.users.admin,
    commandId: commandId(7),
    expectedVersion: 0,
    leadId: second.current_projection.id,
    toAssignedTo: fixture.users.salesA,
  });
  fixture.store.transitionLead({
    actorAuthVersion: 1,
    actorId: fixture.users.salesA,
    commandId: commandId(8),
    expectedVersion: 1,
    leadId: second.current_projection.id,
    toStatus: "rejected",
  });

  return {
    firstLeadId: first.current_projection.id,
    secondLeadId: second.current_projection.id,
  };
}

function assertDeepFrozen(value) {
  if (value !== null && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) {
      assertDeepFrozen(child);
    }
  }
}

function expectedSummary(database, aggregateCount, eventCount) {
  return {
    aggregate_count: aggregateCount,
    event_count: eventCount,
    head: database
      .prepare(`
        SELECT event_hash, sequence
        FROM main.workflow_ledger_head
        WHERE singleton = 1
      `)
      .get(),
    schema_version: 1,
  };
}

function assertReplayError(database, expectedCode, label) {
  assert.throws(
    () => replayWorkflowLedger(database),
    (error) =>
      error instanceof WorkflowReplayError && error.code === expectedCode,
    label,
  );
}

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/u);
  return `"${value}"`;
}

function dropManagedTriggers(database) {
  const triggers = database
    .prepare(`
      SELECT name
      FROM main.sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `)
    .all();
  for (const trigger of triggers) {
    database.exec(`DROP TRIGGER main.${quoteIdentifier(trigger.name)}`);
  }
}

function openTamperedCopy(fixture, label) {
  fixture.database.pragma("wal_checkpoint(TRUNCATE)");
  const filename = path.join(fixture.directory, `${label}.sqlite`);
  copyFileSync(fixture.filename, filename);
  const database = new Database(filename);
  fixture.connections.add(database);
  database.pragma("foreign_keys = OFF");
  dropManagedTriggers(database);
  return database;
}

function storedEvent(database, sequence) {
  return JSON.parse(
    database
      .prepare(
        "SELECT event_json FROM main.workflow_events WHERE sequence = ?",
      )
      .get(sequence).event_json,
  );
}

function rebuildEvent(event, overrides) {
  const { command_digest: _commandDigest, event_hash: _eventHash, ...core } =
    event;
  return createLedgerEvent({ ...core, ...overrides });
}

function replaceStoredEvent(database, oldSequence, event) {
  database
    .prepare(`
      UPDATE main.workflow_events
      SET sequence = ?,
          event_hash = ?,
          previous_hash = ?,
          command_id = ?,
          command_digest = ?,
          event_type = ?,
          aggregate_id = ?,
          aggregate_version = ?,
          actor_id = ?,
          actor_role = ?,
          occurred_at = ?,
          event_json = ?
      WHERE sequence = ?
    `)
    .run(
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
      oldSequence,
    );
}

function relaxCommandIdUniqueness(database) {
  const originalSql = database
    .prepare(
      "SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = 'workflow_events'",
    )
    .get().sql;
  const relaxedSql = originalSql.replace(
    "command_id TEXT NOT NULL UNIQUE",
    "command_id TEXT NOT NULL",
  );
  assert.notEqual(relaxedSql, originalSql);
  database.exec(`
    ALTER TABLE main.workflow_events RENAME TO workflow_events_original;
    ${relaxedSql};
    INSERT INTO main.workflow_events
    SELECT * FROM main.workflow_events_original;
    DROP TABLE main.workflow_events_original;
  `);
}

function relaxEventJsonValidation(database) {
  const originalSql = database
    .prepare(
      "SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = 'workflow_events'",
    )
    .get().sql;
  const relaxedSql = originalSql.replace(
    "event_json TEXT NOT NULL CHECK(json_valid(event_json))",
    "event_json TEXT NOT NULL",
  );
  assert.notEqual(relaxedSql, originalSql);
  database.exec(`
    ALTER TABLE main.workflow_events RENAME TO workflow_events_original;
    ${relaxedSql};
    INSERT INTO main.workflow_events
    SELECT * FROM main.workflow_events_original;
    DROP TABLE main.workflow_events_original;
  `);
}

function relaxLeadAssigneeForeignKey(database) {
  const originalSql = database
    .prepare(
      "SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = 'leads'",
    )
    .get().sql;
  const relaxedSql = originalSql.replace(
    ",\n      FOREIGN KEY (assigned_to) REFERENCES users(id)",
    "",
  );
  assert.notEqual(relaxedSql, originalSql);

  database.pragma("legacy_alter_table = ON");
  try {
    database.exec(`
      ALTER TABLE main.leads RENAME TO leads_original;
      ${relaxedSql};
      INSERT INTO main.leads (
        id, name, email, phone, message, status, assigned_to,
        workflow_version, archived_at, created_at, updated_at
      )
      SELECT
        id, name, email, phone, message, status, assigned_to,
        workflow_version, archived_at, created_at, updated_at
      FROM main.leads_original;
      DROP TABLE main.leads_original;
    `);
  } finally {
    database.pragma("legacy_alter_table = OFF");
  }
}

function rebuildUsersWithIdDefinition(database, idDefinition) {
  assert.ok(["id INTEGER NOT NULL", "id TEXT NOT NULL"].includes(idDefinition));
  const originalSql = database
    .prepare(
      "SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = 'users'",
    )
    .get().sql;
  const relaxedSql = originalSql.replace(
    "id INTEGER PRIMARY KEY AUTOINCREMENT",
    idDefinition,
  );
  assert.notEqual(relaxedSql, originalSql);

  database.pragma("legacy_alter_table = ON");
  try {
    database.exec(`
      ALTER TABLE main.users RENAME TO users_original;
      ${relaxedSql};
      INSERT INTO main.users (
        id, email, password, role, name, phone, auth_version, created_at
      )
      SELECT
        id, email, password, role, name, phone, auth_version, created_at
      FROM main.users_original;
      DROP TABLE main.users_original;
    `);
  } finally {
    database.pragma("legacy_alter_table = OFF");
  }
}

function replaceEventActorRoleWithGeneratedColumn(database) {
  const originalSql = database
    .prepare(
      "SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = 'workflow_events'",
    )
    .get().sql;
  const generatedSql = originalSql.replace(
    "actor_role TEXT NOT NULL",
    "actor_role TEXT GENERATED ALWAYS AS ('system') VIRTUAL",
  );
  assert.notEqual(generatedSql, originalSql);
  database.exec(`
    DROP TABLE main.workflow_events;
    ${generatedSql};
  `);
}

function createLegacySource(filename, encoding = "UTF-8") {
  assert.ok(["UTF-8", "UTF-16le", "UTF-16be"].includes(encoding));
  const database = new Database(filename);
  database.pragma(`encoding = '${encoding}'`);
  assert.equal(database.pragma("encoding", { simple: true }), encoding);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'student', 'sales')),
      name TEXT NOT NULL,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT NOT NULL,
      message TEXT,
      status TEXT,
      assigned_to INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );
  `);
  const insertUser = database.prepare(`
    INSERT INTO users (email, password, role, name)
    VALUES (?, 'test-only-non-secret', ?, ?)
  `);
  const adminId = Number(
    insertUser.run(
      "legacy-admin@example.invalid",
      "admin",
      "Synthetic Legacy Admin",
    ).lastInsertRowid,
  );
  const salesId = Number(
    insertUser.run(
      "legacy-sales@example.invalid",
      "sales",
      "Synthetic Legacy Sales",
    ).lastInsertRowid,
  );
  database
    .prepare(`
      INSERT INTO leads (
        name, email, phone, message, status, assigned_to,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'contacted', ?, ?, ?)
    `)
    .run(
      "Synthetic Legacy Applicant A",
      "legacy-a@example.invalid",
      "+1-202-555-0191",
      "Synthetic migrated enquiry A.",
      salesId,
      "2021-01-02 03:04:05",
      "2021-02-03 04:05:06",
    );
  database
    .prepare(`
      INSERT INTO leads (
        name, email, phone, message, status, assigned_to,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'new', NULL, ?, ?)
    `)
    .run(
      "Synthetic Legacy Applicant B",
      "legacy-b@example.invalid",
      "+1-202-555-0192",
      "Synthetic migrated enquiry B.",
      "2022-03-04 05:06:07",
      "2022-04-05 06:07:08",
    );
  database.close();
  return { adminId, salesId };
}

test("a complete lifecycle replays to an exact, deeply frozen PII-free summary", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const beforeChanges = fixture.database
    .prepare("SELECT total_changes() AS count")
    .get().count;
  const summary = replayWorkflowLedger(fixture.database);
  assert.deepEqual(summary, expectedSummary(fixture.database, 2, 8));
  assert.deepEqual(Object.keys(summary), [
    "aggregate_count",
    "event_count",
    "head",
    "schema_version",
  ]);
  assert.deepEqual(Object.keys(summary.head), ["event_hash", "sequence"]);
  assertDeepFrozen(summary);
  assert.equal(
    fixture.database.prepare("SELECT total_changes() AS count").get().count,
    beforeChanges,
  );

  const serialized = JSON.stringify(summary);
  for (const contactValue of Object.values(syntheticContact(1))) {
    assert.equal(serialized.includes(contactValue), false);
  }
  assert.doesNotMatch(serialized, /example\.invalid|Synthetic|\+1-202-555/u);

});

test("the same ledger verifies through a read-only SQLite connection", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);
  fixture.database.exec(`
    CREATE TABLE main.pragma_integrity_check (value TEXT);
    CREATE TABLE main.pragma_foreign_key_check (value TEXT);
  `);
  const expected = expectedSummary(fixture.database, 2, 8);
  fixture.database.pragma("wal_checkpoint(TRUNCATE)");
  fixture.database.close();

  const inspection = new Database(fixture.filename, {
    fileMustExist: true,
    readonly: true,
  });
  fixture.connections.add(inspection);
  assert.equal(inspection.readonly, true);
  assert.deepEqual(replayWorkflowLedger(inspection), expected);
  inspection.exec(`
    CREATE TEMP TABLE workflow_events AS
      SELECT * FROM main.workflow_events WHERE 0;
    CREATE TEMP VIEW leads AS
      SELECT * FROM main.leads;
    CREATE TEMP TABLE pragma_integrity_check (integrity_check TEXT);
    CREATE TEMP TABLE pragma_foreign_key_check (violation INTEGER);
  `);
  assert.deepEqual(replayWorkflowLedger(inspection), expected);
});

test("legacy imports replay with their documented timestamp boundary", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-replay-legacy-"));
  const filename = path.join(directory, "legacy.sqlite");
  const { adminId } = createLegacySource(filename);
  let database;
  context.after(() => {
    if (database && database.open) {
      database.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });

  let migrationCommand = 100;
  database = openDatabase({
    enableWorkflowLedger: true,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
    filename,
    workflowOptions: {
      clock: advancingClock(Date.UTC(2026, 7, 5, 5, 0, 0)),
      commandIdGenerator: () => commandId(migrationCommand++),
    },
  });
  assert.deepEqual(replayWorkflowLedger(database), expectedSummary(database, 2, 2));

  const store = createWorkflowStore(database, {
    clock: advancingClock(Date.UTC(2026, 7, 5, 6, 0, 0)),
  });
  store.transitionLead({
    actorAuthVersion: 1,
    actorId: adminId,
    commandId: commandId(110),
    expectedVersion: 0,
    leadId: 1,
    toStatus: "converted",
  });
  assert.deepEqual(replayWorkflowLedger(database), expectedSummary(database, 2, 3));
  assert.equal(
    database.prepare("SELECT created_at FROM main.leads WHERE id = 1").get()
      .created_at,
    "2021-01-02 03:04:05",
  );
  assert.equal(
    database.prepare("SELECT updated_at FROM main.leads WHERE id = 2").get()
      .updated_at,
    "2022-04-05 06:07:08",
  );

  const ignoredLegacyTimestamp = "2".repeat(129);
  dropManagedTriggers(database);
  database
    .prepare(
      "UPDATE main.leads SET created_at = ?, updated_at = ? WHERE id = 2",
    )
    .run(ignoredLegacyTimestamp, ignoredLegacyTimestamp);
  assert.deepEqual(replayWorkflowLedger(database), expectedSummary(database, 2, 3));
});

test("native UTF-16 SQLite ledgers replay with canonical UTF-8 semantics", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-replay-utf16-"));
  const connections = [];
  context.after(() => {
    for (const connection of connections) {
      if (connection.open) {
        connection.close();
      }
    }
    rmSync(directory, { force: true, recursive: true });
  });

  for (const [index, encoding] of ["UTF-16le", "UTF-16be"].entries()) {
    const filename = path.join(directory, `${encoding}.sqlite`);
    createLegacySource(filename, encoding);
    const database = openDatabase({
      enableWorkflowLedger: true,
      environment: { ORTA_SEED_DEMO_USERS: "false" },
      filename,
      workflowOptions: {
        clock: advancingClock(Date.UTC(2026, 7, 5, 7 + index, 0, 0)),
        commandIdGenerator: (() => {
          let next = 200 + index * 10;
          return () => commandId(next++);
        })(),
      },
    });
    connections.push(database);
    const store = createWorkflowStore(database, {
      clock: advancingClock(Date.UTC(2026, 7, 5, 9 + index, 0, 0)),
    });
    store.createLead({
      commandId: commandId(220 + index),
      contact: syntheticContact(20 + index),
    });

    assert.equal(database.pragma("encoding", { simple: true }), encoding);
    assert.deepEqual(
      replayWorkflowLedger(database),
      expectedSummary(database, 3, 3),
    );
  }
});

test("replay fails closed when workflow storage is disabled or the connection is busy", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-replay-disabled-"));
  const disabled = openDatabase({
    enableWorkflowLedger: false,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
    filename: path.join(directory, "disabled.sqlite"),
  });
  context.after(() => {
    if (disabled.open) {
      disabled.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });
  assertReplayError(disabled, "workflow_not_enabled", "disabled workflow");

  const fixture = createManagedFixture(context);
  const missingUsers = openTamperedCopy(fixture, "missing-users");
  missingUsers.exec("DROP TABLE main.users");
  assertReplayError(
    missingUsers,
    "workflow_not_enabled",
    "missing base users table",
  );

  const virtualEvents = openTamperedCopy(fixture, "virtual-events-table");
  virtualEvents.exec("DROP TABLE main.workflow_events");
  virtualEvents.table("synthetic_events", () => ({
    columns: [
      "sequence",
      "event_hash",
      "previous_hash",
      "command_id",
      "command_digest",
      "event_type",
      "aggregate_id",
      "aggregate_version",
      "actor_id",
      "actor_role",
      "occurred_at",
      "event_json",
    ],
    rows: function* rows() {},
  }));
  virtualEvents.exec(
    "CREATE VIRTUAL TABLE main.workflow_events USING synthetic_events()",
  );
  assert.equal(
    virtualEvents
      .prepare(
        "SELECT rootpage FROM main.sqlite_master WHERE name = 'workflow_events'",
      )
      .get().rootpage,
    0,
  );
  assertReplayError(
    virtualEvents,
    "workflow_not_enabled",
    "virtual storage cannot impersonate a durable event table",
  );

  const generatedEvents = openTamperedCopy(fixture, "generated-event-column");
  replaceEventActorRoleWithGeneratedColumn(generatedEvents);
  assert.equal(
    generatedEvents
      .prepare("PRAGMA main.table_xinfo(workflow_events)")
      .all()
      .find((column) => column.name === "actor_role").hidden,
    2,
  );
  assertReplayError(
    generatedEvents,
    "workflow_not_enabled",
    "generated required columns can be reevaluated between guards and reads",
  );

  fixture.database.exec("BEGIN IMMEDIATE");
  try {
    assertReplayError(
      fixture.database,
      "replay_requires_idle_connection",
      "active transaction",
    );
  } finally {
    fixture.database.exec("ROLLBACK");
  }
  assert.deepEqual(replayWorkflowLedger(fixture.database), {
    aggregate_count: 0,
    event_count: 0,
    head: { event_hash: ZERO_HASH, sequence: 0 },
    schema_version: 1,
  });
});

test("schema markers and ledger heads are validated independently", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const marker = openTamperedCopy(fixture, "invalid-marker");
  marker.prepare("UPDATE main.workflow_schema SET version = 99").run();
  assertReplayError(marker, "invalid_schema_marker", "unsupported marker");

  const missingHead = openTamperedCopy(fixture, "missing-head");
  missingHead.prepare("DELETE FROM main.workflow_ledger_head").run();
  assertReplayError(missingHead, "invalid_ledger_head", "missing head");

  const wrongHead = openTamperedCopy(fixture, "wrong-head");
  wrongHead
    .prepare("UPDATE main.workflow_ledger_head SET event_hash = ?")
    .run("f".repeat(64));
  assertReplayError(wrongHead, "ledger_head_mismatch", "wrong final hash");

  assert.deepEqual(
    replayWorkflowLedger(fixture.database),
    expectedSummary(fixture.database, 2, 8),
  );
});

test("event storage rejects non-canonical, oversized, invalid UTF-8, and BLOB values", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const nonCanonical = openTamperedCopy(fixture, "non-canonical-json");
  nonCanonical
    .prepare(
      "UPDATE main.workflow_events SET event_json = ' ' || event_json WHERE sequence = 1",
    )
    .run();
  assertReplayError(
    nonCanonical,
    "event_storage_invalid",
    "non-canonical JSON bytes",
  );

  const leadingBom = openTamperedCopy(fixture, "leading-bom-json");
  relaxEventJsonValidation(leadingBom);
  const originalJson = leadingBom
    .prepare("SELECT event_json FROM main.workflow_events WHERE sequence = 1")
    .get().event_json;
  leadingBom
    .prepare("UPDATE main.workflow_events SET event_json = ? WHERE sequence = 1")
    .run(`\uFEFF${originalJson}`);
  assertReplayError(
    leadingBom,
    "event_storage_invalid",
    "leading byte-order mark is data, not an ignorable transport marker",
  );

  const invalidUtf8 = openTamperedCopy(fixture, "invalid-utf8");
  invalidUtf8
    .prepare(
      "UPDATE main.workflow_events SET event_json = CAST(x'22ff22' AS TEXT) WHERE sequence = 1",
    )
    .run();
  assertReplayError(invalidUtf8, "event_storage_invalid", "invalid UTF-8 text");

  const oversized = openTamperedCopy(fixture, "oversized-event-json");
  oversized
    .prepare(
      "UPDATE main.workflow_events SET event_json = ? WHERE sequence = 1",
    )
    .run(JSON.stringify("x".repeat(MAX_CANONICAL_BYTES)));
  assertReplayError(oversized, "event_storage_invalid", "oversized event JSON");

  const blob = openTamperedCopy(fixture, "blob-event-json");
  const tableSql = blob
    .prepare(
      "SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = 'workflow_events'",
    )
    .get().sql;
  assert.match(tableSql, /\) STRICT\s*$/u);
  const relaxedTableSql = tableSql.replace(/\) STRICT\s*$/u, ")");
  blob.exec(`
    ALTER TABLE main.workflow_events RENAME TO workflow_events_original;
    ${relaxedTableSql};
    INSERT INTO main.workflow_events
    SELECT * FROM main.workflow_events_original;
    DROP TABLE main.workflow_events_original;
  `);
  blob
    .prepare(
      "UPDATE main.workflow_events SET event_json = CAST(event_json AS BLOB) WHERE sequence = 1",
    )
    .run();
  assert.equal(
    blob
      .prepare("SELECT typeof(event_json) AS type FROM main.workflow_events WHERE sequence = 1")
      .get().type,
    "blob",
  );
  assertReplayError(blob, "event_storage_invalid", "BLOB event JSON");

  blob.defaultSafeIntegers(true);
  blob.function("typeof", { deterministic: true }, (_value) => "text");
  blob.function("length", { deterministic: true }, (value) =>
    Buffer.isBuffer(value) ? value.length : String(value).length,
  );
  assert.equal(
    blob
      .prepare("SELECT typeof(event_json) AS type FROM main.workflow_events WHERE sequence = 1")
      .get().type,
    "text",
  );
  assertReplayError(
    blob,
    "event_storage_invalid",
    "overridden storage functions",
  );

  const harmlessOverload = openTamperedCopy(fixture, "two-argument-functions");
  harmlessOverload.function("typeof", { deterministic: true }, (_a, _b) =>
    "text",
  );
  harmlessOverload.function("length", { deterministic: true }, (a, b) =>
    String(a).length + String(b).length,
  );
  assert.deepEqual(
    replayWorkflowLedger(harmlessOverload),
    expectedSummary(harmlessOverload, 2, 8),
  );
});

test("event contracts and mirrored row columns are verified separately", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const invalidContract = openTamperedCopy(fixture, "invalid-contract");
  const event = storedEvent(invalidContract, 1);
  const forged = { ...event, event_hash: "e".repeat(64) };
  invalidContract
    .prepare(`
      UPDATE main.workflow_events
      SET event_hash = ?, event_json = ?
      WHERE sequence = 1
    `)
    .run(forged.event_hash, canonicalJsonBytes(forged).toString("utf8"));
  assertReplayError(
    invalidContract,
    "event_contract_invalid",
    "valid canonical record with a forged hash",
  );

  const columnMismatch = openTamperedCopy(fixture, "column-mismatch");
  columnMismatch
    .prepare(
      "UPDATE main.workflow_events SET actor_role = 'system' WHERE sequence = 1",
    )
    .run();
  assertReplayError(
    columnMismatch,
    "event_column_mismatch",
    "actor role differs from canonical event",
  );

  const oversizedColumn = openTamperedCopy(fixture, "oversized-event-column");
  oversizedColumn
    .prepare("UPDATE main.workflow_events SET actor_role = ? WHERE sequence = 1")
    .run("r".repeat(17));
  assertReplayError(
    oversizedColumn,
    "event_storage_invalid",
    "oversized mirrored event text",
  );
});

test("duplicate command identifiers are detected without relying on a UNIQUE index", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);
  const duplicate = openTamperedCopy(fixture, "duplicate-command-id");
  relaxCommandIdUniqueness(duplicate);

  const firstCommandId = storedEvent(duplicate, 1).command.command_id;
  const second = storedEvent(duplicate, 2);
  const duplicated = rebuildEvent(second, {
    command: { ...second.command, command_id: firstCommandId },
  });
  replaceStoredEvent(duplicate, 2, duplicated);
  assertReplayError(
    duplicate,
    "duplicate_command_id",
    "duplicate survives a relaxed storage schema",
  );
});

test("global sequence continuity and previous-hash linkage are replayed", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const sequenceGap = openTamperedCopy(fixture, "sequence-gap");
  const moved = rebuildEvent(storedEvent(sequenceGap, 2), { sequence: 10 });
  replaceStoredEvent(sequenceGap, 2, moved);
  assertReplayError(
    sequenceGap,
    "global_sequence_mismatch",
    "missing global sequence two",
  );

  const brokenLink = openTamperedCopy(fixture, "broken-link");
  const relinked = rebuildEvent(storedEvent(brokenLink, 2), {
    previous_hash: "a".repeat(64),
  });
  replaceStoredEvent(brokenLink, 2, relinked);
  assertReplayError(
    brokenLink,
    "previous_hash_mismatch",
    "second event does not reference the first",
  );
});

test("aggregate versions and reducer before-state are reconstructed from history", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const versionJump = openTamperedCopy(fixture, "aggregate-version-jump");
  const finalSecondLeadEvent = storedEvent(versionJump, 8);
  const jumped = rebuildEvent(finalSecondLeadEvent, {
    aggregate: { ...finalSecondLeadEvent.aggregate, version: 3 },
    command: { ...finalSecondLeadEvent.command, expected_version: 2 },
  });
  replaceStoredEvent(versionJump, 8, jumped);
  assertReplayError(
    versionJump,
    "aggregate_version_mismatch",
    "aggregate version skips two",
  );

  const beforeState = openTamperedCopy(fixture, "reducer-before-state");
  const assignment = storedEvent(beforeState, 3);
  const forgedAssignment = rebuildEvent(assignment, {
    payload: { ...assignment.payload, from_assigned_to: null },
  });
  replaceStoredEvent(beforeState, 3, forgedAssignment);
  assertReplayError(
    beforeState,
    "state_transition_mismatch",
    "assignment before-state contradicts the claim event",
  );
});

test("materialized projections reject field, extra, archive, and timestamp drift", (context) => {
  const fixture = createManagedFixture(context);
  const { firstLeadId } = populateLifecycle(fixture);

  const status = openTamperedCopy(fixture, "projection-status");
  status
    .prepare("UPDATE main.leads SET status = 'rejected' WHERE id = ?")
    .run(firstLeadId);
  assertReplayError(status, "projection_mismatch", "status drift");

  const extra = openTamperedCopy(fixture, "projection-extra");
  extra
    .prepare(`
      INSERT INTO main.leads (
        id, name, email, phone, message, status, assigned_to,
        workflow_version, archived_at, created_at, updated_at
      ) VALUES (
        999, 'Synthetic Extra Projection', NULL, '+1-202-555-0199', NULL,
        'new', NULL, 0, NULL,
        '2026-08-05T07:00:00.000Z', '2026-08-05T07:00:00.000Z'
      )
    `)
    .run();
  assertReplayError(extra, "projection_mismatch", "extra projection");

  const archived = openTamperedCopy(fixture, "projection-archive");
  archived
    .prepare("UPDATE main.leads SET archived_at = ? WHERE id = ?")
    .run("2026-08-05T07:00:00.000Z", firstLeadId);
  assertReplayError(archived, "projection_mismatch", "unexpected archive");

  const oversizedArchive = openTamperedCopy(
    fixture,
    "projection-oversized-archive",
  );
  oversizedArchive
    .prepare("UPDATE main.leads SET archived_at = ? WHERE id = ?")
    .run("2".repeat(129), firstLeadId);
  assertReplayError(
    oversizedArchive,
    "projection_mismatch",
    "oversized archive timestamp",
  );

  for (const field of ["created_at", "updated_at"]) {
    const timestamps = openTamperedCopy(fixture, `projection-${field}`);
    timestamps
      .prepare(`UPDATE main.leads SET ${field} = ? WHERE id = ?`)
      .run("2026-08-05T09:09:09.999Z", firstLeadId);
    assertReplayError(
      timestamps,
      "projection_mismatch",
      `${field} drift`,
    );
  }
});

test("foreign-key failures and missing projections fail before semantic replay", (context) => {
  const fixture = createManagedFixture(context);
  const { firstLeadId } = populateLifecycle(fixture);

  const invalidAssignee = openTamperedCopy(fixture, "invalid-assignee-fk");
  invalidAssignee
    .prepare("UPDATE main.leads SET assigned_to = 999999 WHERE id = ?")
    .run(firstLeadId);
  assertReplayError(
    invalidAssignee,
    "foreign_key_violation",
    "projection references a missing user",
  );

  const missingCurrentUser = openTamperedCopy(
    fixture,
    "missing-user-with-relaxed-lead-fk",
  );
  relaxLeadAssigneeForeignKey(missingCurrentUser);
  const assignedUser = missingCurrentUser
    .prepare("SELECT assigned_to FROM main.leads WHERE id = ?")
    .get(firstLeadId).assigned_to;
  assert.notEqual(assignedUser, null);
  missingCurrentUser.prepare("DELETE FROM main.users WHERE id = ?").run(assignedUser);
  assert.equal(
    missingCurrentUser.prepare("PRAGMA main.foreign_key_check").get(),
    undefined,
  );
  assertReplayError(
    missingCurrentUser,
    "foreign_key_violation",
    "current assignee is absent after its declaration was removed",
  );

  const duplicateCurrentUser = openTamperedCopy(
    fixture,
    "duplicate-current-user",
  );
  relaxLeadAssigneeForeignKey(duplicateCurrentUser);
  duplicateCurrentUser.exec("DROP TABLE main.ai_chats");
  rebuildUsersWithIdDefinition(duplicateCurrentUser, "id INTEGER NOT NULL");
  const duplicateId = duplicateCurrentUser
    .prepare("SELECT assigned_to FROM main.leads WHERE id = ?")
    .get(firstLeadId).assigned_to;
  duplicateCurrentUser
    .prepare(`
      INSERT INTO main.users (
        id, email, password, role, name, phone, auth_version, created_at
      )
      SELECT
        id, 'duplicate-user@example.invalid', password, role,
        'Synthetic Duplicate User', phone, auth_version, created_at
      FROM main.users
      WHERE id = ?
      LIMIT 1
    `)
    .run(duplicateId);
  assert.equal(
    duplicateCurrentUser
      .prepare("SELECT count(*) AS count FROM main.users WHERE id = ?")
      .get(duplicateId).count,
    2,
  );
  assertReplayError(
    duplicateCurrentUser,
    "foreign_key_violation",
    "current assignee identity is ambiguous without its copied primary key",
  );

  const textCurrentUser = openTamperedCopy(fixture, "text-current-user-id");
  relaxLeadAssigneeForeignKey(textCurrentUser);
  textCurrentUser.exec("DROP TABLE main.ai_chats");
  rebuildUsersWithIdDefinition(textCurrentUser, "id TEXT NOT NULL");
  assert.equal(
    textCurrentUser
      .prepare(
        "SELECT typeof(id) AS type FROM main.users WHERE CAST(id AS INTEGER) = ?",
      )
      .get(duplicateId).type,
    "text",
  );
  assertReplayError(
    textCurrentUser,
    "foreign_key_violation",
    "current assignee identity must remain an integer",
  );

  const missing = openTamperedCopy(fixture, "missing-projection");
  missing.prepare("DELETE FROM main.leads WHERE id = ?").run(firstLeadId);
  assertReplayError(
    missing,
    "foreign_key_violation",
    "events reference a missing projection",
  );
});

test("SQLite integrity failures are normalized without mutating the source", (context) => {
  const fixture = createManagedFixture(context);
  populateLifecycle(fixture);

  const corrupt = openTamperedCopy(fixture, "failed-check-constraint");
  corrupt.pragma("ignore_check_constraints = ON");
  corrupt
    .prepare("UPDATE main.workflow_ledger_head SET sequence = -1")
    .run();
  corrupt.pragma("ignore_check_constraints = OFF");
  assert.notEqual(corrupt.pragma("integrity_check", { simple: true }), "ok");
  assertReplayError(
    corrupt,
    "database_integrity_failed",
    "failed CHECK constraint",
  );

  const ignoredChecks = openTamperedCopy(
    fixture,
    "ignored-check-constraints",
  );
  ignoredChecks.pragma("ignore_check_constraints = ON");
  ignoredChecks.prepare("UPDATE main.users SET auth_version = 0").run();
  assert.equal(
    ignoredChecks.pragma("integrity_check", { simple: true }),
    "ok",
  );
  assertReplayError(
    ignoredChecks,
    "database_integrity_failed",
    "connection suppresses CHECK validation",
  );

  const spoofedIntegrity = openTamperedCopy(fixture, "spoofed-integrity-module");
  spoofedIntegrity.pragma("ignore_check_constraints = ON");
  spoofedIntegrity.prepare("UPDATE main.users SET auth_version = 0").run();
  spoofedIntegrity.pragma("ignore_check_constraints = OFF");
  spoofedIntegrity.table("pragma_integrity_check", {
    columns: ["integrity_check"],
    parameters: ["argument", "schema"],
    rows: function* rows() {
      yield { integrity_check: "ok" };
    },
  });
  assert.equal(
    spoofedIntegrity
      .prepare(
        "SELECT integrity_check FROM main.pragma_integrity_check(1, 'main')",
      )
      .get().integrity_check,
    "ok",
  );
  assert.notEqual(
    spoofedIntegrity.pragma("integrity_check", { simple: true }),
    "ok",
  );
  assertReplayError(
    spoofedIntegrity,
    "database_integrity_failed",
    "application virtual table cannot impersonate native integrity PRAGMA",
  );

  const spoofedForeignKeys = openTamperedCopy(fixture, "spoofed-fk-module");
  const assignedLead = spoofedForeignKeys
    .prepare("SELECT id FROM main.leads WHERE assigned_to IS NOT NULL LIMIT 1")
    .get().id;
  spoofedForeignKeys
    .prepare("UPDATE main.leads SET assigned_to = 999999 WHERE id = ?")
    .run(assignedLead);
  spoofedForeignKeys.table("pragma_foreign_key_check", {
    columns: ["result"],
    parameters: ["argument", "schema"],
    rows: function* rows() {},
  });
  assert.equal(
    spoofedForeignKeys
      .prepare("SELECT 1 FROM main.pragma_foreign_key_check(NULL, 'main')")
      .get(),
    undefined,
  );
  assert.notEqual(
    spoofedForeignKeys.prepare("PRAGMA main.foreign_key_check").get(),
    undefined,
  );
  assertReplayError(
    spoofedForeignKeys,
    "foreign_key_violation",
    "application virtual table cannot impersonate native foreign-key PRAGMA",
  );

  const writableSchema = openTamperedCopy(fixture, "writable-schema");
  writableSchema.exec("CREATE VIEW main.replay_probe AS SELECT 1 AS value");
  writableSchema.unsafeMode(true);
  writableSchema.pragma("writable_schema = ON");
  writableSchema
    .prepare(`
      UPDATE main.sqlite_master
      SET sql = 'CREATE VIE broken'
      WHERE type = 'view' AND name = 'replay_probe'
    `)
    .run();
  const schemaVersion = writableSchema.pragma("schema_version", {
    simple: true,
  });
  writableSchema.pragma(`schema_version = ${schemaVersion + 1}`);
  assert.equal(
    writableSchema.pragma("integrity_check", { simple: true }),
    "ok",
  );
  assertReplayError(
    writableSchema,
    "database_integrity_failed",
    "connection suppresses malformed schema records",
  );

  const staleSchema = openTamperedCopy(fixture, "stale-schema-cache");
  staleSchema.unsafeMode(true);
  staleSchema.pragma("writable_schema = ON");
  staleSchema
    .prepare(`
      UPDATE main.sqlite_master
      SET sql = 'CREATE TABL broken'
      WHERE type = 'table' AND name = 'users'
    `)
    .run();
  staleSchema.pragma("writable_schema = OFF");
  assert.equal(staleSchema.pragma("writable_schema", { simple: true }), 0);
  assert.equal(staleSchema.pragma("integrity_check", { simple: true }), "ok");
  assertReplayError(
    staleSchema,
    "database_integrity_failed",
    "stale parsed schema is reset and reparsed before discovery",
  );

  assert.deepEqual(
    replayWorkflowLedger(fixture.database),
    expectedSummary(fixture.database, 2, 8),
  );
});
