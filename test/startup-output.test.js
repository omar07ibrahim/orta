"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { formatStartupMessage } = require("../startup-output");

const emailPattern =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const credentialLabelPattern =
  /\b(?:password|passwd|credential|secret|token)\b|парол/iu;
const identityRolePattern =
  /\b(?:admin|administrator|sales|student)\b|админ|продаж|студент/iu;
const slashDelimitedCredentialPairPattern = /\S+\s+\/\s+\S+/u;

test("startup output is neutral and contains no identity or credential hints", () => {
  const output = formatStartupMessage();

  assert.equal(
    output,
    [
      "ORTA Study API is ready.",
      "See README.md for local endpoints and optional synthetic demo setup.",
    ].join("\n"),
  );
  assert.doesNotMatch(output, emailPattern);
  assert.doesNotMatch(output, credentialLabelPattern);
  assert.doesNotMatch(output, identityRolePattern);
  assert.doesNotMatch(output, slashDelimitedCredentialPairPattern);
});

test("the server entrypoint delegates its only startup log to the formatter", () => {
  const entrypoint = readFileSync(
    path.join(__dirname, "..", "index.js"),
    "utf8",
  );
  const startupLogs = entrypoint.match(/console\.log\s*\([^;]*\);/gu) || [];

  assert.deepEqual(startupLogs, ["console.log(formatStartupMessage());"]);
  assert.doesNotMatch(entrypoint, emailPattern);
  assert.doesNotMatch(entrypoint, slashDelimitedCredentialPairPattern);
});
