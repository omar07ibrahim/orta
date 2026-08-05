"use strict";

const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const databaseDependenciesAvailable = ["better-sqlite3", "bcryptjs"].every(
  (dependency) => {
    try {
      require.resolve(dependency);
      return true;
    } catch (error) {
      return false;
    }
  },
);

test(
  "database initialization uses only a temporary file and creates no users by default",
  { skip: !databaseDependenciesAvailable },
  (context) => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "orta-db-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");

    const { openDatabase } = require("../database-core");
    const database = openDatabase({
      filename: databasePath,
      environment: { ORTA_SEED_DEMO_USERS: "false" },
    });
    context.after(() => {
      database.close();
      rmSync(temporaryDirectory, { recursive: true });
    });

    const userCount = database
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get().count;

    assert.equal(userCount, 0);
    assert.equal(existsSync(databasePath), true);
    assert.equal(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_events'",
        )
        .get(),
      undefined,
    );
  },
);

test(
  "synthetic demo seeding is explicit, reserved-domain only, and idempotent",
  { skip: !databaseDependenciesAvailable },
  (context) => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "orta-db-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");

    const environment = {
      ORTA_SEED_DEMO_USERS: "true",
      ORTA_DEMO_ADMIN_PASSWORD: "a".repeat(16),
      ORTA_DEMO_SALES_PASSWORD: "b".repeat(16),
    };
    const { openDatabase, seedSyntheticDemoUsers } = require("../database-core");
    const { readDemoSeedConfig } = require("../config");
    const database = openDatabase({ filename: databasePath, environment });
    context.after(() => {
      database.close();
      rmSync(temporaryDirectory, { recursive: true });
    });

    const users = database
      .prepare("SELECT email, role, phone, password FROM users ORDER BY email")
      .all();

    assert.equal(users.length, 2);
    assert.ok(users.every((user) => user.email.endsWith("@example.com")));
    assert.ok(users.every((user) => user.phone === null));
    assert.ok(
      users.every(
        (user) =>
          user.password !== environment.ORTA_DEMO_ADMIN_PASSWORD &&
          user.password !== environment.ORTA_DEMO_SALES_PASSWORD,
      ),
    );
    assert.equal(
      seedSyntheticDemoUsers(database, readDemoSeedConfig(environment)),
      0,
    );
  },
);

test(
  "invalid seed configuration is rejected before a database file is opened",
  { skip: !databaseDependenciesAvailable },
  () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "orta-db-"));
    const databasePath = path.join(temporaryDirectory, "must-not-exist.sqlite");

    try {
      const { openDatabase } = require("../database-core");
      assert.throws(
        () =>
          openDatabase({
            filename: databasePath,
            environment: { ORTA_SEED_DEMO_USERS: "true" },
          }),
        /ORTA_DEMO_ADMIN_PASSWORD/,
      );
      assert.equal(existsSync(databasePath), false);
    } finally {
      rmSync(temporaryDirectory, { recursive: true });
    }
  },
);
