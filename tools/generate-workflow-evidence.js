#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");

const Database = require("better-sqlite3");

const { configureDatabase, openDatabase } = require("../database-core");
const { replayWorkflowLedger } = require("../workflow/ledger-replay");
const {
  isWalResetSafeSQLiteVersion,
} = require("../workflow/ledger-schema");
const { createWorkflowStore } = require("../workflow/ledger-store");
const { runHttpEvidence } = require("./http-evidence");
const { renderHttpEvidence } = require("./http-evidence-renderer");
const {
  renderWorkflowEvidence,
} = require("./workflow-evidence-renderer");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIRECTORY = path.join(ROOT, "docs", "assets");
const EVIDENCE_NODE_VERSION = "v22.23.1";
const EXPECTED_FILES = Object.freeze([
  "crash-recovery.gif",
  "evidence-workflow.svg",
  "http-command-flow.svg",
  "http-command-transcript.png",
  "http-route-evidence.json",
  "ledger-chain.png",
  "process-crash-matrix.png",
  "process-tests-cli.png",
  "runtime-evidence.png",
  "visual-manifest.json",
  "workflow-architecture.svg",
  "workflow-evidence.json",
]);
const CRASH_STAGES = Object.freeze([
  "after_event_insert",
  "after_projection_update",
  "after_head_update",
  "after_commit_before_ack",
]);
const OPERATIONS = Object.freeze(["create", "claim", "assign", "transition"]);
const USERS = Object.freeze({ admin: 101, salesA: 201, salesB: 202 });

function parseArguments(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { check: false };
  }
  if (args.length === 1 && args[0] === "--check") {
    return { check: true };
  }
  throw new Error("usage: node tools/generate-workflow-evidence.js [--check]");
}

function assertEvidenceRuntime() {
  if (process.version !== EVIDENCE_NODE_VERSION) {
    throw new Error(
      `workflow evidence requires ${EVIDENCE_NODE_VERSION}, received ${process.version}`,
    );
  }
}

function findFirstFile(candidates, label) {
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error(`missing ${label}; set ORTA_EVIDENCE_FONT_DIR`);
  }
  return resolved;
}

function resolveFonts(environment) {
  const configured = environment.ORTA_EVIDENCE_FONT_DIR;
  const roots = configured
    ? [path.resolve(configured)]
    : [
        "/usr/share/fonts/truetype/dejavu",
        "/usr/local/share/fonts",
        "C:\\Windows\\Fonts",
        "/System/Library/Fonts/Supplemental",
      ];
  return {
    mono: findFirstFile(
      roots.flatMap((root) => [
        path.join(root, "DejaVuSansMono.ttf"),
        path.join(root, "consola.ttf"),
        path.join(root, "Menlo.ttc"),
      ]),
      "monospace evidence font",
    ),
    sans: findFirstFile(
      roots.flatMap((root) => [
        path.join(root, "DejaVuSans.ttf"),
        path.join(root, "arial.ttf"),
        path.join(root, "Arial.ttf"),
      ]),
      "sans-serif evidence font",
    ),
    sansBold: findFirstFile(
      roots.flatMap((root) => [
        path.join(root, "DejaVuSans-Bold.ttf"),
        path.join(root, "arialbd.ttf"),
        path.join(root, "Arial Bold.ttf"),
      ]),
      "bold evidence font",
    ),
  };
}

function commandId(index) {
  return `cmd_${index.toString(16).padStart(32, "0")}`;
}

function runProcessTests() {
  const result = spawnSync(
    process.execPath,
    ["--test", "test/ledger-process.integration.test.js"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { NODE_ENV: "test", TZ: "UTC" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    process.stderr.write(result.stdout || "");
    throw new Error(`process evidence tests failed with status ${result.status}`);
  }
  if (result.signal !== null) {
    throw new Error(`process evidence tests ended with signal ${result.signal}`);
  }
  assert.equal(result.stderr, "", "process evidence tests wrote to stderr");

  const passedNames = Array.from(
    result.stdout.matchAll(/^ok \d+ - (.+)$/gmu),
    (match) => match[1],
  );
  const pass = Number(result.stdout.match(/^# pass (\d+)$/mu)?.[1]);
  const fail = Number(result.stdout.match(/^# fail (\d+)$/mu)?.[1]);
  const skipped = Number(result.stdout.match(/^# skipped (\d+)$/mu)?.[1]);
  assert.equal(pass, 17);
  assert.equal(fail, 0);
  assert.equal(skipped, 0);
  assert.equal(passedNames.length, 17);
  assert.equal(
    passedNames[0],
    "two processes serialize every workflow command and converge after contention",
  );

  const crashCases = passedNames.slice(1).map((name) => {
    const match = name.match(
      /^SIGKILL (create|claim|assign|transition) at (after_event_insert|after_projection_update|after_head_update|after_commit_before_ack) preserves one atomic outcome$/u,
    );
    assert.ok(match, `unexpected process test name: ${name}`);
    const operation = match[1];
    const stage = match[2];
    return {
      operation,
      stage,
      stage_index: CRASH_STAGES.indexOf(stage),
      status: "pass",
    };
  });
  assert.deepEqual(
    crashCases.map(({ operation, stage }) => `${operation}:${stage}`),
    OPERATIONS.flatMap((operation) =>
      CRASH_STAGES.map((stage) => `${operation}:${stage}`),
    ),
  );

  return {
    command: "node --test test/ledger-process.integration.test.js",
    contention: "pass",
    crash_cases: crashCases,
    fail,
    pass,
    skipped,
    total: passedNames.length,
  };
}

function insertSyntheticUsers(database) {
  const insert = database.prepare(`
    INSERT INTO main.users (id, email, password, role, name, phone)
    VALUES (?, ?, 'unused-evidence-hash', ?, ?, NULL)
  `);
  database.transaction(() => {
    insert.run(
      USERS.admin,
      "admin-evidence@example.com",
      "admin",
      "Synthetic Evidence Admin",
    );
    insert.run(
      USERS.salesA,
      "sales-a-evidence@example.com",
      "sales",
      "Synthetic Evidence Sales A",
    );
    insert.run(
      USERS.salesB,
      "sales-b-evidence@example.com",
      "sales",
      "Synthetic Evidence Sales B",
    );
  })();
}

function evidenceContact() {
  return {
    email: "workflow-evidence@example.com",
    message: "Synthetic visual evidence fixture.",
    name: "Synthetic Workflow Evidence",
    phone: "+1-555-0100",
  };
}

function eventEvidence(event) {
  return {
    actor_id: event.actor.id,
    actor_role: event.actor.role,
    aggregate_id: event.aggregate.id,
    aggregate_version: event.aggregate.version,
    command_digest: event.command_digest,
    command_id: event.command.command_id,
    event_hash: event.event_hash,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    previous_hash: event.previous_hash,
    sequence: event.sequence,
  };
}

function buildWorkflowEvidence() {
  const temporaryRoot = path.join(ROOT, ".git", "evidence-runtime-");
  const directory = mkdtempSync(temporaryRoot);
  const filename = path.join(directory, "workflow.sqlite");
  let database;
  try {
    database = openDatabase({
      enableWorkflowLedger: true,
      environment: { ORTA_SEED_DEMO_USERS: "false" },
      filename,
    });
    insertSyntheticUsers(database);
    const operations = [
      {
        input: { commandId: commandId(0xe001), contact: evidenceContact() },
        method: "createLead",
        timestamp: "2026-08-05T14:00:00.000Z",
      },
      {
        input: {
          actorAuthVersion: 1,
          actorId: USERS.salesA,
          commandId: commandId(0xe002),
          expectedVersion: 0,
          leadId: 1,
        },
        method: "claimLead",
        timestamp: "2026-08-05T14:00:01.000Z",
      },
      {
        input: {
          actorAuthVersion: 1,
          actorId: USERS.admin,
          commandId: commandId(0xe003),
          expectedVersion: 1,
          leadId: 1,
          toAssignedTo: USERS.salesB,
        },
        method: "assignLead",
        timestamp: "2026-08-05T14:00:02.000Z",
      },
      {
        input: {
          actorAuthVersion: 1,
          actorId: USERS.salesB,
          commandId: commandId(0xe004),
          expectedVersion: 2,
          leadId: 1,
          toStatus: "contacted",
        },
        method: "transitionLead",
        timestamp: "2026-08-05T14:00:03.000Z",
      },
    ];
    const receipts = operations.map(({ input, method, timestamp }) => {
      const store = createWorkflowStore(database, {
        clock: () => new Date(timestamp),
      });
      return store[method](input);
    });
    const replay = replayWorkflowLedger(database);
    const head = database
      .prepare(`
        SELECT sequence, event_hash
        FROM main.workflow_ledger_head
        WHERE singleton = 1
      `)
      .get();
    const projections = database
      .prepare(`
        SELECT
          id, status, assigned_to, workflow_version, archived_at,
          created_at, updated_at
        FROM main.leads
        ORDER BY id
      `)
      .all();
    const integrity = database.pragma("integrity_check");
    const foreignKeys = database.pragma("foreign_key_check");
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
    assert.deepEqual(foreignKeys, []);
    assert.equal(replay.event_count, 4);
    assert.equal(replay.aggregate_count, 1);
    assert.deepEqual(replay.head, head);
    assert.equal(projections.length, 1);
    assert.deepEqual(
      {
        assigned_to: projections[0].assigned_to,
        status: projections[0].status,
        workflow_version: projections[0].workflow_version,
      },
      { assigned_to: USERS.salesB, status: "contacted", workflow_version: 3 },
    );

    return {
      events: receipts.map((receipt) => eventEvidence(receipt.event)),
      foreign_key_check: foreignKeys,
      head,
      integrity_check: integrity,
      projections,
      replay,
    };
  } finally {
    if (database?.open) {
      database.close();
    }
    rmSync(directory, { force: true, recursive: true });
  }
}

function runtimeEvidence() {
  const database = new Database(":memory:");
  try {
    configureDatabase(database);
    const sqlite = database
      .prepare("SELECT sqlite_version() AS version")
      .get().version;
    const walResetSafe = isWalResetSafeSQLiteVersion(sqlite);
    assert.equal(walResetSafe, true);
    return {
      better_sqlite3: require("better-sqlite3/package.json").version,
      node: process.version,
      node_abi: process.versions.modules,
      sqlite,
      wal_reset_safe: walResetSafe,
    };
  } finally {
    database.close();
  }
}

function buildEvidence() {
  const evidence = {
    process_tests: runProcessTests(),
    runtime: runtimeEvidence(),
    schema: "orta.workflow-evidence.v1",
    workflow: buildWorkflowEvidence(),
  };
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    "@example.com",
    "+1-555-0100",
    "Synthetic Evidence",
    "Synthetic Workflow Evidence",
    "unused-evidence-hash",
    ROOT,
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `generated evidence exposed forbidden content: ${forbidden}`,
    );
  }
  return evidence;
}

function writeAtomic(filename, bytes) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, filename);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function buildManifest(directory) {
  const files = readdirSync(directory)
    .filter((name) => name !== "visual-manifest.json")
    .sort()
    .map((name) => {
      const filename = path.join(directory, name);
      const stats = statSync(filename);
      assert.equal(stats.isFile(), true);
      return { bytes: stats.size, path: name, sha256: sha256(filename) };
    });
  return { files, schema: "orta.visual-manifest.v1" };
}

function compareGenerated(expectedDirectory, actualDirectory) {
  const expectedNames = readdirSync(expectedDirectory).sort();
  const actualNames = readdirSync(actualDirectory).sort();
  assert.deepEqual(expectedNames, EXPECTED_FILES);
  assert.deepEqual(actualNames, EXPECTED_FILES);
  const drift = [];
  for (const name of EXPECTED_FILES) {
    const expected = readFileSync(path.join(expectedDirectory, name));
    const actual = readFileSync(path.join(actualDirectory, name));
    if (!expected.equals(actual)) {
      drift.push(name);
    }
  }
  if (drift.length > 0) {
    throw new Error(`workflow evidence drift: ${drift.join(", ")}`);
  }
}

async function generate(directory) {
  const evidence = buildEvidence();
  const httpEvidence = runHttpEvidence();
  const fonts = resolveFonts(process.env);
  writeAtomic(path.join(directory, "workflow-evidence.json"), stableJson(evidence));
  writeAtomic(
    path.join(directory, "http-route-evidence.json"),
    stableJson(httpEvidence),
  );
  await renderWorkflowEvidence({
    evidence,
    fonts,
    outputDirectory: directory,
    writeText: writeAtomic,
  });
  await renderHttpEvidence({
    evidence: httpEvidence,
    fonts,
    outputDirectory: directory,
    writeText: writeAtomic,
  });
  const manifest = buildManifest(directory);
  writeAtomic(path.join(directory, "visual-manifest.json"), stableJson(manifest));
  return manifest;
}

async function main() {
  const options = parseArguments(process.argv);
  assertEvidenceRuntime();
  if (!options.check) {
    const manifest = await generate(OUTPUT_DIRECTORY);
    process.stdout.write(
      stableJson({
        files: manifest.files.length,
        output: path.relative(ROOT, OUTPUT_DIRECTORY),
        status: "generated",
      }),
    );
    return;
  }

  const checkDirectory = mkdtempSync(
    path.join(ROOT, ".git", "evidence-check-"),
  );
  try {
    await generate(checkDirectory);
    compareGenerated(OUTPUT_DIRECTORY, checkDirectory);
    process.stdout.write(
      stableJson({ files: EXPECTED_FILES.length, status: "verified" }),
    );
  } finally {
    rmSync(checkDirectory, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
