"use strict";

const Database = require("better-sqlite3");

const {
  isWalResetSafeSQLiteVersion,
} = require("../workflow/ledger-schema");

const EXPECTED_BETTER_SQLITE3_VERSION = "13.0.2";
const EXPECTED_SQLITE_VERSION = "3.53.4";
const SUPPORTED_NODE_MAJORS = Object.freeze([22, 24]);

const database = new Database(":memory:");
let sqliteVersion;
try {
  sqliteVersion = database
    .prepare("SELECT sqlite_version() AS version")
    .get().version;
} finally {
  database.close();
}

const evidence = Object.freeze({
  better_sqlite3: require("better-sqlite3/package.json").version,
  node: process.version,
  node_abi: process.versions.modules,
  sqlite: sqliteVersion,
  wal_reset_safe: isWalResetSafeSQLiteVersion(sqliteVersion),
});
const nodeMajor = Number(process.versions.node.split(".", 1)[0]);
const mismatches = [];
if (!SUPPORTED_NODE_MAJORS.includes(nodeMajor)) {
  mismatches.push({
    actual: nodeMajor,
    expected: SUPPORTED_NODE_MAJORS,
    field: "node_major",
  });
}
if (evidence.better_sqlite3 !== EXPECTED_BETTER_SQLITE3_VERSION) {
  mismatches.push({
    actual: evidence.better_sqlite3,
    expected: EXPECTED_BETTER_SQLITE3_VERSION,
    field: "better_sqlite3",
  });
}
if (evidence.sqlite !== EXPECTED_SQLITE_VERSION) {
  mismatches.push({
    actual: evidence.sqlite,
    expected: EXPECTED_SQLITE_VERSION,
    field: "sqlite",
  });
}
if (!evidence.wal_reset_safe) {
  mismatches.push({ actual: false, expected: true, field: "wal_reset_safe" });
}

if (mismatches.length > 0) {
  console.error(JSON.stringify({ evidence, mismatches, status: "rejected" }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ evidence, status: "verified" }, null, 2));
}
