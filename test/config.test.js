"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SYNTHETIC_DEMO_USERS,
  readDemoSeedConfig,
  readJwtSecret,
} = require("../config");

test("JWT configuration fails closed when the secret is absent or short", () => {
  assert.throws(() => readJwtSecret({}), /JWT_SECRET/);
  assert.throws(
    () => readJwtSecret({ JWT_SECRET: " ".repeat(32) }),
    /JWT_SECRET/,
  );
  assert.throws(
    () => readJwtSecret({ JWT_SECRET: "x".repeat(31) }),
    /JWT_SECRET/,
  );
  assert.equal(readJwtSecret({ JWT_SECRET: "x".repeat(32) }), "x".repeat(32));
});

test("demo users remain disabled unless the opt-in flag is exactly true", () => {
  assert.deepEqual(readDemoSeedConfig({}), { enabled: false, users: [] });
  assert.deepEqual(readDemoSeedConfig({ ORTA_SEED_DEMO_USERS: "false" }), {
    enabled: false,
    users: [],
  });
  assert.throws(
    () => readDemoSeedConfig({ ORTA_SEED_DEMO_USERS: "1" }),
    /ORTA_SEED_DEMO_USERS/,
  );
});

test("opt-in requires two distinct externally supplied passwords", () => {
  const environment = {
    ORTA_SEED_DEMO_USERS: "true",
    ORTA_DEMO_ADMIN_PASSWORD: "a".repeat(16),
    ORTA_DEMO_SALES_PASSWORD: "b".repeat(16),
  };
  const config = readDemoSeedConfig(environment);

  assert.equal(config.enabled, true);
  assert.equal(config.users.length, 2);
  assert.deepEqual(
    config.users.map(({ email, role, name, phone }) => ({
      email,
      role,
      name,
      phone,
    })),
    SYNTHETIC_DEMO_USERS.map(
      ({ email, role, name, phone }) => ({ email, role, name, phone }),
    ),
  );
  assert.ok(config.users.every((user) => user.email.endsWith("@example.com")));
  assert.ok(config.users.every((user) => user.phone === null));

  assert.throws(
    () =>
      readDemoSeedConfig({
        ORTA_SEED_DEMO_USERS: "true",
        ORTA_DEMO_ADMIN_PASSWORD: "a".repeat(16),
      }),
    /ORTA_DEMO_SALES_PASSWORD/,
  );
  assert.throws(
    () =>
      readDemoSeedConfig({
        ORTA_SEED_DEMO_USERS: "true",
        ORTA_DEMO_ADMIN_PASSWORD: "a".repeat(16),
        ORTA_DEMO_SALES_PASSWORD: "a".repeat(16),
      }),
    /distinct/,
  );
});
