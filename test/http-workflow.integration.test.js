"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const temporary = mkdtempSync(path.join(tmpdir(), "orta-http-workflow-"));
process.env.JWT_SECRET =
  "http-workflow-test-secret-with-more-than-thirty-two-bytes";
process.env.ORTA_DB_PATH = path.join(temporary, "workflow.sqlite");
process.env.ORTA_ALLOWED_ORIGINS = "https://app.example.com";
process.env.ORTA_SEED_DEMO_USERS = "true";
process.env.ORTA_DEMO_ADMIN_PASSWORD = "AdminPassphrase-2026!";
process.env.ORTA_DEMO_SALES_PASSWORD = "SalesPassphrase-2026!";

const { app, database } = require("../index");

let baseUrl;
let server;
let admin;
let sales;

async function request(
  route,
  { authorization, body, commandId, method = "GET", origin, token } = {},
) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (commandId) {
    headers["idempotency-key"] = commandId;
  }
  if (origin) {
    headers.origin = origin;
  }
  if (authorization !== undefined) {
    headers.authorization = authorization;
  } else if (token) {
    headers.authorization = "Bearer " + token;
  }
  const response = await fetch(baseUrl + route, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
  return {
    body: await response.json(),
    headers: response.headers,
    status: response.status,
  };
}

async function login(email, password) {
  const response = await request("/api/auth/login", {
    body: { email, password },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(typeof response.body.token, "string");
  return response.body;
}

test.before(async () => {
  server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1");
    candidate.once("error", reject);
    candidate.once("listening", () => resolve(candidate));
  });
  const address = server.address();
  baseUrl = "http://127.0.0.1:" + address.port;
  admin = await login("admin@example.com", process.env.ORTA_DEMO_ADMIN_PASSWORD);
  sales = await login("sales@example.com", process.env.ORTA_DEMO_SALES_PASSWORD);
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  database.close();
  rmSync(temporary, { force: true, recursive: true });
});

test("HTTP commands preserve authorization, idempotency, and replay", async () => {
  const contact = {
    email: "trace@example.com",
    message: "Synthetic route-boundary evidence.",
    name: "Trace User",
    phone: "+1-555-0100",
  };
  const createCommand = "cmd_" + "01".padStart(32, "0");

  const deniedOrigin = await request("/api/leads", {
    origin: "https://untrusted.example",
    token: admin.token,
  });
  assert.equal(deniedOrigin.status, 403);
  assert.equal(deniedOrigin.body.error, "origin_not_allowed");

  const allowedOrigin = await request("/api/leads", {
    origin: "https://app.example.com",
    token: admin.token,
  });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(
    allowedOrigin.headers.get("access-control-allow-origin"),
    "https://app.example.com",
  );

  const malformedBearer = await request("/api/leads", {
    authorization: "Bearer a.b.c ",
  });
  assert.equal(malformedBearer.status, 401);
  assert.equal(
    malformedBearer.body.error,
    "invalid_authorization_header",
  );

  const longInvalidEmail = await request("/api/auth/register", {
    body: {
      email: "a@" + "a.".repeat(159),
      name: "Synthetic Registration",
      password: "RegistrationPassphrase-2026!",
    },
    method: "POST",
  });
  assert.equal(longInvalidEmail.status, 400);
  assert.equal(
    longInvalidEmail.body.error,
    "invalid_registration_fields",
  );

  const missingKey = await request("/api/leads", {
    body: contact,
    method: "POST",
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.error, "invalid_idempotency_key");

  const created = await request("/api/leads", {
    body: contact,
    commandId: createCommand,
    method: "POST",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.event_type, "lead.created");
  assert.equal(created.body.lead.status, "new");
  assert.equal(created.body.lead.workflow_version, 0);
  assert.equal(created.body.replayed, false);
  assert.equal(created.headers.get("location"), "/api/leads/1");
  assert.equal(JSON.stringify(created.body).includes(contact.name), false);
  assert.equal(JSON.stringify(created.body).includes(contact.phone), false);

  const replayedCreate = await request("/api/leads", {
    body: contact,
    commandId: createCommand,
    method: "POST",
  });
  assert.equal(replayedCreate.status, 200);
  assert.equal(replayedCreate.body.replayed, true);
  assert.equal(replayedCreate.body.event_hash, created.body.event_hash);

  const conflictingCreate = await request("/api/leads", {
    body: { ...contact, name: "Changed Contact" },
    commandId: createCommand,
    method: "POST",
  });
  assert.equal(conflictingCreate.status, 409);
  assert.equal(conflictingCreate.body.error, "idempotency_conflict");

  const visible = await request("/api/leads?limit=10", {
    token: sales.token,
  });
  assert.equal(visible.status, 200);
  assert.equal(visible.body.length, 1);
  assert.equal(visible.body[0].workflow_version, 0);

  const claimCommand = "cmd_" + "02".padStart(32, "0");
  const claimed = await request("/api/leads/1/claim", {
    body: { expected_version: 0 },
    commandId: claimCommand,
    method: "POST",
    token: sales.token,
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.lead.assigned_to, sales.user.id);
  assert.equal(claimed.body.lead.workflow_version, 1);
  assert.equal(claimed.body.replayed, false);

  const replayedClaim = await request("/api/leads/1/claim", {
    body: { expected_version: 0 },
    commandId: claimCommand,
    method: "POST",
    token: sales.token,
  });
  assert.equal(replayedClaim.status, 200);
  assert.equal(replayedClaim.body.replayed, true);
  assert.equal(replayedClaim.body.event_hash, claimed.body.event_hash);

  const staleClaim = await request("/api/leads/1/claim", {
    body: { expected_version: 0 },
    commandId: "cmd_" + "03".padStart(32, "0"),
    method: "POST",
    token: sales.token,
  });
  assert.equal(staleClaim.status, 409);
  assert.equal(staleClaim.body.error, "version_conflict");
  assert.deepEqual(staleClaim.body.details, {
    actual_version: 1,
    expected_version: 0,
    lead_id: 1,
  });

  const contacted = await request("/api/leads/1/transition", {
    body: { expected_version: 1, status: "contacted" },
    commandId: "cmd_" + "04".padStart(32, "0"),
    method: "POST",
    token: sales.token,
  });
  assert.equal(contacted.status, 200);
  assert.equal(contacted.body.lead.status, "contacted");
  assert.equal(contacted.body.lead.workflow_version, 2);

  const forbiddenAssignment = await request("/api/leads/1/assign", {
    body: { assigned_to: sales.user.id, expected_version: 2 },
    commandId: "cmd_" + "05".padStart(32, "0"),
    method: "POST",
    token: sales.token,
  });
  assert.equal(forbiddenAssignment.status, 403);

  const converted = await request("/api/leads/1/transition", {
    body: { expected_version: 2, status: "converted" },
    commandId: "cmd_" + "06".padStart(32, "0"),
    method: "POST",
    token: admin.token,
  });
  assert.equal(converted.status, 200);
  assert.equal(converted.body.lead.status, "converted");
  assert.equal(converted.body.lead.workflow_version, 3);

  const directPatch = await request("/api/leads/1", {
    body: { status: "rejected" },
    method: "PATCH",
    token: admin.token,
  });
  assert.equal(directPatch.status, 405);
  assert.equal(directPatch.body.error, "direct_lead_mutation_disabled");

  const replay = await request("/api/leads/_workflow/replay", {
    token: admin.token,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, "verified");
  assert.equal(replay.body.aggregate_count, 1);
  assert.equal(replay.body.event_count, 4);
  assert.equal(replay.body.head.sequence, 4);

  database
    .prepare(
      "UPDATE main.users SET auth_version = auth_version + 1 WHERE id = ?",
    )
    .run(sales.user.id);
  const staleToken = await request("/api/leads", { token: sales.token });
  assert.equal(staleToken.status, 401);
  assert.equal(staleToken.body.error, "token_stale");

  sales = await login(
    "sales@example.com",
    process.env.ORTA_DEMO_SALES_PASSWORD,
  );
  assert.equal(sales.user.auth_version, 2);
  const refreshedToken = await request("/api/leads", { token: sales.token });
  assert.equal(refreshedToken.status, 200);

  let remaining = Number(conflictingCreate.headers.get("ratelimit-remaining"));
  assert.equal(Number.isSafeInteger(remaining), true);
  let commandNumber = 100;
  while (remaining > 0) {
    const response = await request("/api/leads", {
      body: {
        email: null,
        message: null,
        name: "Bounded Synthetic Lead " + commandNumber,
        phone: "+1-555-" + String(commandNumber).padStart(4, "0"),
      },
      commandId: "cmd_" + commandNumber.toString(16).padStart(32, "0"),
      method: "POST",
    });
    assert.equal(response.status, 201);
    remaining = Number(response.headers.get("ratelimit-remaining"));
    commandNumber += 1;
  }
  const limited = await request("/api/leads", {
    body: contact,
    commandId: "cmd_" + commandNumber.toString(16).padStart(32, "0"),
    method: "POST",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "public_lead_rate_limited");
  assert.equal(limited.headers.get("retry-after") !== null, true);
});
