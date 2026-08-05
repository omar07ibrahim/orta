"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");

const { configureDatabase, openDatabase } = require("../database-core");
const { canonicalJsonBytes } = require("../workflow/canonical-json");
const {
  EVENT_SCHEMA,
  ZERO_HASH,
  createLedgerEvent,
} = require("../workflow/ledger-contract");
const {
  MINIMUM_WAL_RESET_SAFE_SQLITE_VERSION,
  WAL_RESET_SAFE_SQLITE_BACKPORTS,
  WorkflowSchemaError,
  assertWalResetSafeSQLiteRuntime,
  initializeWorkflowSchema,
  isWalResetSafeSQLiteVersion,
} = require("../workflow/ledger-schema");
const {
  WorkflowStoreError,
  createWorkflowStore,
} = require("../workflow/ledger-store");

function commandId(index) {
  return `cmd_${index.toString(16).padStart(32, "0")}`;
}

function advancingClock(start = Date.UTC(2026, 7, 5, 1, 0, 0)) {
  let offset = 0;
  return () => {
    const value = new Date(start + offset * 1_000);
    offset += 1;
    return value;
  };
}

function createFixture(context, storeOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-store-"));
  const filename = path.join(directory, "workflow.sqlite");
  const database = openDatabase({
    enableWorkflowLedger: true,
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
  });
  context.after(() => {
    if (database.open) {
      database.close();
    }
    rmSync(directory, { force: true, recursive: true });
  });

  const insertUser = database.prepare(`
    INSERT INTO users (email, password, role, name, phone)
    VALUES (?, 'unused-test-hash', ?, ?, NULL)
  `);
  const users = {
    admin: Number(
      insertUser.run("admin-ledger@example.com", "admin", "Ledger Admin")
        .lastInsertRowid,
    ),
    salesA: Number(
      insertUser.run("sales-a-ledger@example.com", "sales", "Sales A")
        .lastInsertRowid,
    ),
    salesB: Number(
      insertUser.run("sales-b-ledger@example.com", "sales", "Sales B")
        .lastInsertRowid,
    ),
    student: Number(
      insertUser.run("student-ledger@example.com", "student", "Student")
        .lastInsertRowid,
    ),
  };
  const store = createWorkflowStore(database, {
    clock: advancingClock(),
    ...storeOptions,
  });
  return { database, directory, filename, store, users };
}

function contact(overrides = {}) {
  return {
    email: "candidate@example.com",
    message: "Please contact me about the programme.",
    name: "Synthetic Candidate",
    phone: "+1-555-0100",
    ...overrides,
  };
}

function count(database, tableName) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
    .count;
}

function insertRawEvent(database, event) {
  database
    .prepare(`
      INSERT INTO main.workflow_events (
        sequence, event_hash, previous_hash, command_id, command_digest,
        event_type, aggregate_id, aggregate_version, actor_id, actor_role,
        occurred_at, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
}

test("the workflow boundary accepts only WAL-reset-safe SQLite branches", () => {
  for (const version of [
    "3.44.6",
    "3.44.7",
    "3.50.7",
    "3.50.8",
    "3.51.3",
    "3.53.4",
    "4.0.0",
  ]) {
    assert.equal(isWalResetSafeSQLiteVersion(version), true, version);
  }
  for (const version of [
    null,
    3.53,
    "",
    "3.44.5",
    "3.45.3",
    "3.50.6",
    "3.51.2",
    "3.51.3.0",
    `3.51.${"3".repeat(40)}`,
  ]) {
    assert.equal(isWalResetSafeSQLiteVersion(version), false, String(version));
  }
});

test("the installed SQLite runtime carries the WAL-reset fix", (context) => {
  const database = new Database(":memory:");
  context.after(() => database.close());

  const detected = database
    .prepare("SELECT sqlite_version() AS version")
    .get().version;
  assert.equal(isWalResetSafeSQLiteVersion(detected), true);
  assert.equal(assertWalResetSafeSQLiteRuntime(database), detected);
});

test("workflow activation rejects an affected runtime before schema mutation", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-runtime-"));
  const filename = path.join(directory, "workflow.sqlite");
  const database = openDatabase({
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
  });
  context.after(() => {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  });
  database.function("sqlite_version", { deterministic: true }, () => "3.45.3");

  assert.throws(
    () => initializeWorkflowSchema(database),
    (error) => {
      assert.equal(error instanceof WorkflowSchemaError, true);
      assert.equal(error.code, "sqlite_wal_reset_fix_required");
      assert.deepEqual(error.details, {
        minimum_version: MINIMUM_WAL_RESET_SAFE_SQLITE_VERSION,
        safe_backports: WAL_RESET_SAFE_SQLITE_BACKPORTS,
        sqlite_version: "3.45.3",
      });
      return true;
    },
  );
  assert.equal(
    database
      .prepare(`
        SELECT name
        FROM main.sqlite_master
        WHERE type = 'table' AND name = 'workflow_events'
      `)
      .get(),
    undefined,
  );
});

test("writer construction rechecks the SQLite runtime", (context) => {
  const fixture = createFixture(context);
  fixture.database.function(
    "sqlite_version",
    { deterministic: true },
    () => "3.51.2",
  );

  assert.throws(
    () => createWorkflowStore(fixture.database),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "sqlite_wal_reset_fix_required",
  );
});

test("file databases enforce WAL/FULL settings and atomic create idempotency", (context) => {
  const { database, store } = createFixture(context);

  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(database.pragma("synchronous", { simple: true }), 2);
  assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(database.pragma("busy_timeout", { simple: true }), 5_000);

  const created = store.createLead({
    commandId: commandId(1),
    contact: contact(),
  });
  assert.equal(created.replayed, false);
  assert.equal(created.event.event_type, "lead.created");
  assert.equal(created.event.aggregate.version, 0);
  assert.deepEqual(created.current_projection, {
    id: created.event.aggregate.id,
    status: "new",
    workflow_version: 0,
  });

  const storedJson = database
    .prepare("SELECT event_json FROM workflow_events WHERE sequence = 1")
    .get().event_json;
  assert.equal(storedJson.endsWith("\n"), true);
  for (const directContactValue of Object.values(contact())) {
    assert.equal(storedJson.includes(directContactValue), false);
  }

  const replay = store.createLead({
    commandId: commandId(1),
    contact: contact({
      email: "different@example.com",
      message: "A retry body is deliberately ignored.",
    }),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.event_hash, created.event.event_hash);
  assert.deepEqual(replay.current_projection, created.current_projection);
  assert.equal("email" in replay.current_projection, false);
  assert.equal(
    database.prepare("SELECT email FROM leads WHERE id = ?").get(created.event.aggregate.id)
      .email,
    "candidate@example.com",
  );
  assert.equal(count(database, "leads"), 1);
  assert.equal(count(database, "workflow_events"), 1);
  assert.deepEqual(
    database
      .prepare(
        "SELECT sequence, event_hash FROM workflow_ledger_head WHERE singleton = 1",
      )
      .get(),
    { event_hash: created.event.event_hash, sequence: 1 },
  );

  assert.throws(
    () =>
      store.createLead({
        commandId: commandId(2),
        contact: contact({ name: "Malformed\ud800Name" }),
      }),
    (error) =>
      error instanceof WorkflowStoreError &&
      error.code === "invalid_contact_name",
  );
  assert.equal(count(database, "leads"), 1);
});

test("event rows and the ledger head are guarded against independent mutation", (context) => {
  const { database, filename, store } = createFixture(context);
  store.createLead({ commandId: commandId(10), contact: contact() });
  const row = database.prepare("SELECT * FROM workflow_events").get();

  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE workflow_events SET actor_role = actor_role WHERE sequence = 1",
        )
        .run(),
    /workflow_events_append_only/u,
  );
  assert.throws(
    () => database.prepare("DELETE FROM workflow_events WHERE sequence = 1").run(),
    /workflow_events_append_only/u,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE workflow_ledger_head SET sequence = 2 WHERE singleton = 1",
        )
        .run(),
    /workflow_head_not_next/u,
  );
  assert.throws(
    () => database.prepare("DELETE FROM workflow_ledger_head").run(),
    /workflow_head_required/u,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE leads SET status = 'contacted' WHERE id = ?",
        )
        .run(row.aggregate_id),
    /workflow_projection_event_required/u,
  );
  assert.throws(
    () =>
      database
        .prepare("INSERT INTO leads (name, phone) VALUES ('Bypass', '+1-555-0111')")
        .run(),
    /workflow_projection_event_required/u,
  );
  assert.throws(
    () => database.prepare("DELETE FROM leads WHERE id = ?").run(row.aggregate_id),
    /workflow_projection_delete_unsupported/u,
  );
  const outsideConnection = new Database(filename);
  try {
    assert.throws(
      () =>
        outsideConnection
          .prepare("UPDATE leads SET status = 'contacted' WHERE id = ?")
          .run(row.aggregate_id),
      /workflow_projection_event_required/u,
    );
  } finally {
    outsideConnection.close();
  }
  database.exec(`
    CREATE TRIGGER late_projection_side_effect
    AFTER INSERT ON leads
    BEGIN
      UPDATE leads SET status = 'contacted' WHERE id = NEW.id;
    END;
  `);
  assert.throws(
    () =>
      store.createLead({
        commandId: commandId(12),
        contact: contact({ phone: "+1-555-0112" }),
      }),
    /workflow_projection_event_required/u,
  );
  assert.equal(count(database, "workflow_events"), 1);
  assert.equal(count(database, "leads"), 1);
  database.exec("DROP TRIGGER late_projection_side_effect");

  assert.throws(
    () =>
      database
        .prepare(`
          INSERT INTO workflow_events (
            sequence, event_hash, previous_hash, command_id, command_digest,
            event_type, aggregate_id, aggregate_version, actor_id, actor_role,
            occurred_at, event_json
          ) VALUES (2, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
        `)
        .run(
          "a".repeat(64),
          "b".repeat(64),
          commandId(11),
          "c".repeat(64),
          row.event_type,
          row.aggregate_id,
          row.actor_role,
          row.occurred_at,
          row.event_json,
        ),
    /workflow_event_not_next/u,
  );
});

test("origin projections reject archive and timestamp drift", (context) => {
  const { database } = createFixture(context);
  const occurredAt = "2026-08-05T02:00:00.000Z";

  function attemptProjection({ archivedAt, createdAt, identifier, updatedAt }) {
    const leadId = 900 + identifier;
    const event = createLedgerEvent({
      actor: { id: null, role: "public" },
      aggregate: { id: leadId, type: "lead", version: 0 },
      command: {
        action: "lead.create",
        command_id: commandId(identifier),
        lead_id: leadId,
      },
      event_type: "lead.created",
      occurred_at: occurredAt,
      payload: { assigned_to: null, status: "new" },
      previous_hash: ZERO_HASH,
      schema: EVENT_SCHEMA,
      sequence: 1,
    });

    assert.throws(
      () =>
        database
          .transaction(() => {
            insertRawEvent(database, event);
            database
              .prepare(`
                INSERT INTO main.leads (
                  id, name, email, phone, message, status, assigned_to,
                  workflow_version, archived_at, created_at, updated_at
                ) VALUES (?, 'Guard Probe', NULL, '+1-555-0188', NULL, 'new',
                  NULL, 0, ?, ?, ?)
              `)
              .run(leadId, archivedAt, createdAt, updatedAt);
          })
          .immediate(),
      /workflow_projection_event_required/u,
    );
  }

  attemptProjection({
    archivedAt: "2026-08-05T02:01:00.000Z",
    createdAt: occurredAt,
    identifier: 13,
    updatedAt: occurredAt,
  });
  attemptProjection({
    archivedAt: null,
    createdAt: "2026-08-05T01:59:00.000Z",
    identifier: 14,
    updatedAt: occurredAt,
  });
  attemptProjection({
    archivedAt: null,
    createdAt: occurredAt,
    identifier: 15,
    updatedAt: "2026-08-05T02:01:00.000Z",
  });

  assert.equal(count(database, "workflow_events"), 0);
  assert.equal(count(database, "leads"), 0);
  assert.deepEqual(
    database
      .prepare(
        "SELECT sequence, event_hash FROM workflow_ledger_head WHERE singleton = 1",
      )
      .get(),
    { event_hash: ZERO_HASH, sequence: 0 },
  );
});

test("protected TEMP objects cannot shadow workflow storage", (context) => {
  const { database, store, users } = createFixture(context);
  database.exec("CREATE TEMP TABLE leads AS SELECT * FROM main.leads");

  assert.throws(
    () => createWorkflowStore(database),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "protected_temp_shadow",
  );
  assert.throws(
    () =>
      store.createLead({
        commandId: commandId(16),
        contact: contact(),
      }),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "protected_temp_shadow",
  );
  assert.equal(count(database, "main.leads"), 0);
  assert.equal(count(database, "main.workflow_events"), 0);
  assert.deepEqual(
    database
      .prepare(
        "SELECT sequence, event_hash FROM main.workflow_ledger_head WHERE singleton = 1",
      )
      .get(),
    { event_hash: ZERO_HASH, sequence: 0 },
  );

  database.exec("DROP TABLE temp.leads");
  const created = store.createLead({
    commandId: commandId(17),
    contact: contact(),
  });
  assert.equal(created.current_projection.id, 1);
  assert.equal(count(database, "main.leads"), 1);

  database.exec(`
    CREATE TEMP TRIGGER shadow_projection_side_effect
    BEFORE UPDATE ON main.leads
    BEGIN
      SELECT RAISE(ABORT, 'temp_projection_side_effect');
    END
  `);
  assert.throws(
    () =>
      store.claimLead({
        actorAuthVersion: 1,
        actorId: users.salesA,
        commandId: commandId(18),
        expectedVersion: 0,
        leadId: created.current_projection.id,
      }),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "protected_temp_shadow",
  );
  assert.equal(count(database, "main.workflow_events"), 1);
  assert.equal(
    database
      .prepare("SELECT assigned_to FROM main.leads WHERE id = 1")
      .get().assigned_to,
    null,
  );

  database.exec("DROP TRIGGER temp.shadow_projection_side_effect");
  const claimed = store.claimLead({
    actorAuthVersion: 1,
    actorId: users.salesA,
    commandId: commandId(18),
    expectedVersion: 0,
    leadId: created.current_projection.id,
  });
  assert.equal(claimed.current_projection.assigned_to, users.salesA);
  assert.equal(count(database, "main.workflow_events"), 2);
});

test("claim, assignment, and transitions commit one projection and event chain", (context) => {
  const { database, store, users } = createFixture(context);
  const created = store.createLead({
    commandId: commandId(20),
    contact: contact(),
  });
  const claimed = store.claimLead({
    actorAuthVersion: 1,
    actorId: users.salesA,
    commandId: commandId(21),
    expectedVersion: 0,
    leadId: created.current_projection.id,
  });
  const assigned = store.assignLead({
    actorAuthVersion: 1,
    actorId: users.admin,
    commandId: commandId(22),
    expectedVersion: 1,
    leadId: created.current_projection.id,
    toAssignedTo: users.salesB,
  });
  const contacted = store.transitionLead({
    actorAuthVersion: 1,
    actorId: users.salesB,
    commandId: commandId(23),
    expectedVersion: 2,
    leadId: created.current_projection.id,
    toStatus: "contacted",
  });
  const converted = store.transitionLead({
    actorAuthVersion: 1,
    actorId: users.admin,
    commandId: commandId(24),
    expectedVersion: 3,
    leadId: created.current_projection.id,
    toStatus: "converted",
  });

  assert.equal(claimed.event.sequence, 2);
  assert.equal(assigned.event.sequence, 3);
  assert.equal(contacted.event.sequence, 4);
  assert.equal(converted.event.sequence, 5);
  assert.equal(converted.current_projection.workflow_version, 4);
  assert.equal(converted.current_projection.status, "converted");
  assert.equal(converted.current_projection.assigned_to, users.salesB);
  assert.equal(count(database, "workflow_events"), 5);
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);

  const replay = store.transitionLead({
    actorAuthVersion: 1,
    actorId: users.admin,
    commandId: commandId(24),
    expectedVersion: 3,
    leadId: created.current_projection.id,
    toStatus: "converted",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.event_hash, converted.event.event_hash);
  assert.equal(count(database, "workflow_events"), 5);

  assert.throws(
    () =>
      store.claimLead({
        actorAuthVersion: 1,
        actorId: users.salesA,
        commandId: commandId(25),
        expectedVersion: 0,
        leadId: created.current_projection.id,
      }),
    (error) =>
      error instanceof WorkflowStoreError && error.code === "version_conflict",
  );
  assert.throws(
    () =>
      store.transitionLead({
        actorAuthVersion: 1,
        actorId: users.admin,
        commandId: commandId(24),
        expectedVersion: 3,
        leadId: created.current_projection.id,
        toStatus: "rejected",
      }),
    (error) =>
      error instanceof WorkflowStoreError &&
      error.code === "idempotency_conflict",
  );
});

test("write authorization is resolved from current role and auth version", (context) => {
  const { database, store, users } = createFixture(context);
  const first = store.createLead({
    commandId: commandId(30),
    contact: contact(),
  });
  const second = store.createLead({
    commandId: commandId(31),
    contact: contact({ phone: "+1-555-0101" }),
  });

  database
    .prepare("UPDATE users SET auth_version = auth_version + 1 WHERE id = ?")
    .run(users.admin);
  assert.throws(
    () =>
      store.assignLead({
        actorAuthVersion: 1,
        actorId: users.admin,
        commandId: commandId(32),
        expectedVersion: 0,
        leadId: first.current_projection.id,
        toAssignedTo: users.salesA,
      }),
    (error) =>
      error instanceof WorkflowStoreError &&
      error.code === "auth_version_conflict",
  );
  const assigned = store.assignLead({
    actorAuthVersion: 2,
    actorId: users.admin,
    commandId: commandId(32),
    expectedVersion: 0,
    leadId: first.current_projection.id,
    toAssignedTo: users.salesA,
  });
  assert.equal(assigned.current_projection.assigned_to, users.salesA);

  assert.throws(
    () =>
      store.assignLead({
        actorAuthVersion: 2,
        actorId: users.admin,
        commandId: commandId(33),
        expectedVersion: 0,
        leadId: second.current_projection.id,
        toAssignedTo: users.student,
      }),
    (error) =>
      error instanceof WorkflowStoreError &&
      error.code === "assignment_target_not_sales",
  );

  database
    .prepare(
      "UPDATE users SET role = 'student', auth_version = auth_version + 1 WHERE id = ?",
    )
    .run(users.salesB);
  assert.throws(
    () =>
      store.claimLead({
        actorAuthVersion: 1,
        actorId: users.salesB,
        commandId: commandId(34),
        expectedVersion: 0,
        leadId: second.current_projection.id,
      }),
    (error) =>
      error instanceof WorkflowStoreError &&
      error.code === "auth_version_conflict",
  );
  assert.equal(count(database, "workflow_events"), 3);
});

for (const stage of [
  "after_projection_update",
  "after_event_insert",
  "after_head_update",
]) {
  test(`a ${stage} failure rolls projection, event, and head back together`, (context) => {
    let armed = true;
    const fixture = createFixture(context, {
      faultInjector(currentStage) {
        if (armed && currentStage === stage) {
          armed = false;
          throw new Error(`injected:${stage}`);
        }
      },
    });

    assert.throws(
      () =>
        fixture.store.createLead({
          commandId: commandId(40),
          contact: contact(),
        }),
      new RegExp(`injected:${stage}`, "u"),
    );
    assert.equal(fixture.database.inTransaction, false);
    assert.equal(count(fixture.database, "leads"), 0);
    assert.equal(count(fixture.database, "workflow_events"), 0);
    assert.deepEqual(
      fixture.database
        .prepare(
          "SELECT sequence, event_hash FROM workflow_ledger_head WHERE singleton = 1",
        )
        .get(),
      { event_hash: "0".repeat(64), sequence: 0 },
    );
    assert.equal(
      fixture.database
        .prepare(
          "SELECT sequence FROM main.workflow_events WHERE command_id = ?",
        )
        .get(commandId(40)),
      undefined,
    );

    const retried = fixture.store.createLead({
      commandId: commandId(40),
      contact: contact(),
    });
    assert.equal(retried.replayed, false);
    assert.equal(count(fixture.database, "workflow_events"), 1);
  });
}

function createLegacyDatabase(filename, { assignmentRole = "sales", status = "new" }) {
  const database = new Database(filename);
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
  const user = database
    .prepare(`
      INSERT INTO users (email, password, role, name)
      VALUES ('legacy@example.com', 'unused-test-hash', ?, 'Legacy Assignee')
    `)
    .run(assignmentRole);
  database
    .prepare(`
      INSERT INTO leads (name, email, phone, message, status, assigned_to)
      VALUES ('Legacy Synthetic', NULL, '+1-555-0199', NULL, ?, ?)
    `)
    .run(status, status === "new" ? null : user.lastInsertRowid);
  database.close();
}

test("legacy leads migrate once without direct contact content in events", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-legacy-"));
  const filename = path.join(directory, "legacy.sqlite");
  createLegacyDatabase(filename, { status: "contacted" });
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  let identifier = 100;
  const workflowOptions = {
    clock: advancingClock(),
    commandIdGenerator: () => commandId(identifier++),
  };
  const database = openDatabase({
    enableWorkflowLedger: true,
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
    workflowOptions,
  });
  const event = database.prepare("SELECT * FROM workflow_events").get();
  assert.equal(event.event_type, "lead.imported");
  assert.equal(event.actor_role, "system");
  assert.equal(event.aggregate_version, 0);
  assert.equal(event.event_json.includes("Legacy Synthetic"), false);
  assert.equal(event.event_json.includes("+1-555-0199"), false);
  assert.equal(count(database, "workflow_events"), 1);
  database.close();

  const reopened = openDatabase({
    enableWorkflowLedger: true,
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
    workflowOptions,
  });
  assert.equal(count(reopened, "workflow_events"), 1);
  reopened.close();
});

test("an invalid legacy state fails without partially installing workflow schema", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-invalid-"));
  const filename = path.join(directory, "legacy.sqlite");
  createLegacyDatabase(filename, { status: "contacted" });
  const raw = new Database(filename);
  raw.prepare("UPDATE leads SET assigned_to = NULL").run();
  raw.close();
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  assert.throws(
    () =>
      openDatabase({
        enableWorkflowLedger: true,
        filename,
        environment: { ORTA_SEED_DEMO_USERS: "false" },
      }),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "legacy_unassigned_state",
  );

  const inspection = new Database(filename, { readonly: true });
  const leadColumns = inspection
    .prepare("PRAGMA table_info(leads)")
    .all()
    .map((column) => column.name);
  const workflowTable = inspection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_events'",
    )
    .get();
  inspection.close();
  assert.equal(leadColumns.includes("workflow_version"), false);
  assert.equal(workflowTable, undefined);
});

test("activation rejects legacy archive state without installing a ledger", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-archive-"));
  const filename = path.join(directory, "archive.sqlite");
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const base = openDatabase({
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
  });
  base
    .prepare(`
      INSERT INTO main.leads (
        name, phone, status, workflow_version, archived_at
      ) VALUES ('Archived Legacy', '+1-555-0187', 'new', 0, ?)
    `)
    .run("2026-08-05T03:00:00.000Z");
  base.close();

  assert.throws(
    () =>
      openDatabase({
        enableWorkflowLedger: true,
        filename,
        environment: { ORTA_SEED_DEMO_USERS: "false" },
      }),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "legacy_archive_unsupported",
  );

  const inspection = new Database(filename, { readonly: true });
  const workflowTable = inspection
    .prepare(`
      SELECT name
      FROM main.sqlite_master
      WHERE type = 'table' AND name = 'workflow_events'
    `)
    .get();
  const archivedAt = inspection
    .prepare("SELECT archived_at FROM main.leads")
    .get().archived_at;
  inspection.close();
  assert.equal(workflowTable, undefined);
  assert.equal(archivedAt, "2026-08-05T03:00:00.000Z");
});

test("pre-existing weak workflow tables are never adopted by column name", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-weak-"));
  const filename = path.join(directory, "weak.sqlite");
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const base = openDatabase({
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
  });
  base.exec(`
    CREATE TABLE workflow_schema (singleton INTEGER, version INTEGER);
    INSERT INTO workflow_schema VALUES (1, 1);
    CREATE TABLE workflow_ledger_head (
      singleton INTEGER,
      sequence INTEGER,
      event_hash TEXT
    );
    INSERT INTO workflow_ledger_head VALUES (1, 0, '${"0".repeat(64)}');
    CREATE TABLE workflow_events (
      sequence INTEGER,
      event_hash TEXT,
      previous_hash TEXT,
      command_id TEXT,
      command_digest TEXT,
      event_type TEXT,
      aggregate_id INTEGER,
      aggregate_version INTEGER,
      actor_id INTEGER,
      actor_role TEXT,
      occurred_at TEXT,
      event_json TEXT
    );
    CREATE TRIGGER workflow_events_no_update
    BEFORE UPDATE ON workflow_events
    BEGIN
      SELECT 1;
    END;
  `);
  base.close();

  const candidate = new Database(filename);
  configureDatabase(candidate);
  try {
    assert.throws(
      () => initializeWorkflowSchema(candidate),
      (error) =>
        error instanceof WorkflowSchemaError &&
        error.code === "unsupported_schema_definition",
    );
    assert.equal(
      candidate
        .prepare(
          "SELECT strict FROM pragma_table_list WHERE name = 'workflow_events'",
        )
        .get().strict,
      0,
    );
  } finally {
    candidate.close();
  }
});

test("pre-existing workflow columns must keep the required affinity and checks", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-column-"));
  const filename = path.join(directory, "column.sqlite");
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  createLegacyDatabase(filename, { status: "new" });
  const database = new Database(filename);
  configureDatabase(database);
  database.exec(`
    ALTER TABLE users ADD COLUMN auth_version TEXT NOT NULL DEFAULT '1';
    ALTER TABLE leads ADD COLUMN workflow_version TEXT NOT NULL DEFAULT '0';
  `);
  try {
    assert.throws(
      () => initializeWorkflowSchema(database),
      (error) =>
        error instanceof WorkflowSchemaError &&
        error.code === "unsupported_base_column",
    );
  } finally {
    database.close();
  }
});

test("SQL comments cannot impersonate required base constraints", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-check-"));
  const filename = path.join(directory, "check.sqlite");
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  createLegacyDatabase(filename, { status: "new" });
  const database = new Database(filename);
  configureDatabase(database);
  database.exec(`
    ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1
      /* CHECK(auth_version > 0) */;
    ALTER TABLE leads ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 0
      /* CHECK(workflow_version >= 0) */;
  `);
  try {
    assert.throws(
      () => initializeWorkflowSchema(database),
      (error) =>
        error instanceof WorkflowSchemaError &&
        error.code === "unsupported_base_constraint",
    );
  } finally {
    database.close();
  }
});

test("unexpected lead triggers cannot piggyback on a workflow write", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-ledger-trigger-"));
  const filename = path.join(directory, "trigger.sqlite");
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = openDatabase({
    filename,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
  });
  database.exec(`
    CREATE TRIGGER legacy_lead_side_effect
    AFTER INSERT ON leads
    BEGIN
      UPDATE leads SET status = 'contacted' WHERE id = NEW.id;
    END;
  `);
  try {
    assert.throws(
      () => initializeWorkflowSchema(database),
      (error) =>
        error instanceof WorkflowSchemaError &&
        error.code === "unexpected_workflow_trigger",
    );
  } finally {
    database.close();
  }
});

test("a populated ledger without its schema marker is never adopted", (context) => {
  const fixture = createFixture(context);
  fixture.store.createLead({ commandId: commandId(200), contact: contact() });
  fixture.database.prepare("DELETE FROM workflow_schema").run();
  fixture.database.close();

  assert.throws(
    () =>
      openDatabase({
        enableWorkflowLedger: true,
        filename: fixture.filename,
        environment: { ORTA_SEED_DEMO_USERS: "false" },
      }),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "unmanaged_workflow_schema",
  );
});

test("schema initialization refuses a projection inserted outside the ledger", (context) => {
  const fixture = createFixture(context);
  fixture.store.createLead({ commandId: commandId(210), contact: contact() });
  fixture.database.exec("DROP TRIGGER workflow_leads_insert_guard");
  fixture.database
    .prepare("INSERT INTO leads (name, phone) VALUES ('Orphan', '+1-555-0198')")
    .run();

  assert.throws(
    () => initializeWorkflowSchema(fixture.database),
    (error) =>
      error instanceof WorkflowSchemaError &&
      error.code === "lead_projection_not_covered",
  );
});
