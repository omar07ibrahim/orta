#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function childEnvironment() {
  return {
    HOME: process.env.HOME || "",
    LANG: "C.UTF-8",
    NODE_ENV: "test",
    PATH: process.env.PATH || "",
    TZ: "UTC",
  };
}

function captureOnce() {
  const result = spawnSync(process.execPath, [__filename, "--worker"], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.schema, "orta.http-route-evidence.v1");
  return evidence;
}

function runHttpEvidence() {
  const first = captureOnce();
  const second = captureOnce();
  assert.deepEqual(second, first);
  const serialized = JSON.stringify(first);
  for (const forbidden of [
    "Route Evidence",
    "@example.com",
    "+1-555",
    "http-evidence-secret",
    "Bearer ",
    ROOT,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  return first;
}

async function request(baseUrl, route, options = {}) {
  const headers = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.commandId) {
    headers["idempotency-key"] = options.commandId;
  }
  if (options.token) {
    headers.authorization = "Bearer " + options.token;
  }
  const response = await fetch(baseUrl + route, {
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method || "GET",
  });
  return {
    body: await response.json(),
    headers: response.headers,
    status: response.status,
  };
}

function commandId(index) {
  return "cmd_" + index.toString(16).padStart(32, "0");
}

function step(name, requestLine, response, result) {
  return {
    name,
    request: requestLine,
    result,
    status: response.status,
  };
}

async function workerMain() {
  const directory = mkdtempSync(path.join(tmpdir(), "orta-http-evidence-"));
  process.env.JWT_SECRET =
    "http-evidence-secret-with-more-than-thirty-two-bytes";
  process.env.ORTA_DB_PATH = path.join(directory, "evidence.sqlite");
  process.env.ORTA_SEED_DEMO_USERS = "true";
  process.env.ORTA_DEMO_ADMIN_PASSWORD = "EvidenceAdminPassphrase-2026!";
  process.env.ORTA_DEMO_SALES_PASSWORD = "EvidenceSalesPassphrase-2026!";

  const { app, database } = require("../index");
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const candidate = app.listen(0, "127.0.0.1");
      candidate.once("error", reject);
      candidate.once("listening", () => resolve(candidate));
    });
    const address = server.address();
    const baseUrl = "http://127.0.0.1:" + address.port;

    const adminLogin = await request(baseUrl, "/api/auth/login", {
      body: {
        email: "admin@example.com",
        password: process.env.ORTA_DEMO_ADMIN_PASSWORD,
      },
      method: "POST",
    });
    const salesLogin = await request(baseUrl, "/api/auth/login", {
      body: {
        email: "sales@example.com",
        password: process.env.ORTA_DEMO_SALES_PASSWORD,
      },
      method: "POST",
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(salesLogin.status, 200);

    const contact = {
      email: "route-evidence@example.com",
      message: "Synthetic route evidence only.",
      name: "Route Evidence",
      phone: "+1-555-0199",
    };
    const create = await request(baseUrl, "/api/leads", {
      body: contact,
      commandId: commandId(1),
      method: "POST",
    });
    const replay = await request(baseUrl, "/api/leads", {
      body: contact,
      commandId: commandId(1),
      method: "POST",
    });
    const conflict = await request(baseUrl, "/api/leads", {
      body: { ...contact, name: "Changed Route Evidence" },
      commandId: commandId(1),
      method: "POST",
    });
    const claim = await request(baseUrl, "/api/leads/1/claim", {
      body: { expected_version: 0 },
      commandId: commandId(2),
      method: "POST",
      token: salesLogin.body.token,
    });
    const staleVersion = await request(baseUrl, "/api/leads/1/claim", {
      body: { expected_version: 0 },
      commandId: commandId(3),
      method: "POST",
      token: salesLogin.body.token,
    });
    const transition = await request(baseUrl, "/api/leads/1/transition", {
      body: { expected_version: 1, status: "contacted" },
      commandId: commandId(4),
      method: "POST",
      token: salesLogin.body.token,
    });
    const directPatch = await request(baseUrl, "/api/leads/1", {
      body: { status: "rejected" },
      method: "PATCH",
      token: adminLogin.body.token,
    });
    const ledgerReplay = await request(
      baseUrl,
      "/api/leads/_workflow/replay",
      { token: adminLogin.body.token },
    );

    database
      .prepare(
        "UPDATE main.users SET auth_version = auth_version + 1 WHERE id = ?",
      )
      .run(salesLogin.body.user.id);
    const staleToken = await request(baseUrl, "/api/leads", {
      token: salesLogin.body.token,
    });

    let remaining = Number(conflict.headers.get("ratelimit-remaining"));
    while (remaining > 0) {
      const consumed = await request(baseUrl, "/api/leads", {
        body: contact,
        method: "POST",
      });
      assert.equal(consumed.status, 400);
      remaining = Number(consumed.headers.get("ratelimit-remaining"));
    }
    const limited = await request(baseUrl, "/api/leads", {
      body: contact,
      commandId: commandId(99),
      method: "POST",
    });

    assert.equal(create.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(conflict.status, 409);
    assert.equal(claim.status, 200);
    assert.equal(staleVersion.status, 409);
    assert.equal(transition.status, 200);
    assert.equal(directPatch.status, 405);
    assert.equal(ledgerReplay.status, 200);
    assert.equal(staleToken.status, 401);
    assert.equal(limited.status, 429);
    assert.equal(JSON.stringify(create.body).includes(contact.name), false);
    assert.equal(JSON.stringify(create.body).includes(contact.phone), false);

    const sqlite = database
      .prepare("SELECT sqlite_version() AS version")
      .get().version;
    const evidence = {
      ledger: {
        aggregate_count: ledgerReplay.body.aggregate_count,
        event_count: ledgerReplay.body.event_count,
        head_sequence: ledgerReplay.body.head.sequence,
        schema_version: ledgerReplay.body.schema_version,
        status: ledgerReplay.body.status,
      },
      proofs: {
        changed_body_conflict: conflict.body.error,
        contact_echoed: false,
        direct_sql_bypass: directPatch.body.error,
        stale_token: staleToken.body.error,
      },
      rate_limit: {
        error: limited.body.error,
        limit: Number(limited.headers.get("ratelimit-limit")),
        status: limited.status,
      },
      runtime: {
        better_sqlite3: require("better-sqlite3/package.json").version,
        node: process.version,
        sqlite,
      },
      schema: "orta.http-route-evidence.v1",
      steps: [
        step(
          "create",
          "POST /api/leads",
          create,
          create.body.event_type + " · v" + create.body.lead.workflow_version,
        ),
        step(
          "exact replay",
          "POST /api/leads",
          replay,
          "same event · replayed=" + replay.body.replayed,
        ),
        step(
          "changed body",
          "POST /api/leads",
          conflict,
          conflict.body.error,
        ),
        step(
          "sales claim",
          "POST /api/leads/1/claim",
          claim,
          claim.body.event_type + " · v" + claim.body.lead.workflow_version,
        ),
        step(
          "stale version",
          "POST /api/leads/1/claim",
          staleVersion,
          staleVersion.body.error,
        ),
        step(
          "transition",
          "POST /api/leads/1/transition",
          transition,
          transition.body.event_type +
            " · v" +
            transition.body.lead.workflow_version,
        ),
        step(
          "direct patch",
          "PATCH /api/leads/1",
          directPatch,
          directPatch.body.error,
        ),
        step(
          "stale token",
          "GET /api/leads",
          staleToken,
          staleToken.body.error,
        ),
        step(
          "rate limit",
          "POST /api/leads",
          limited,
          limited.body.error,
        ),
      ],
    };
    process.stdout.write(JSON.stringify(evidence) + "\n");
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (database && database.open) {
      database.close();
    }
    rmSync(directory, { force: true, recursive: true });
  }
}

if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === "--worker") {
    workerMain().catch((error) => {
      process.stderr.write(String(error.stack || error.message) + "\n");
      process.exitCode = 1;
    });
  } else {
    process.stderr.write("usage: node tools/http-evidence.js --worker\n");
    process.exitCode = 2;
  }
}

module.exports = {
  runHttpEvidence,
};
