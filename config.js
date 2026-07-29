"use strict";

const SYNTHETIC_DEMO_USERS = Object.freeze([
  Object.freeze({
    email: "admin@example.com",
    role: "admin",
    name: "Synthetic Demo Administrator",
    phone: null,
    passwordEnvironmentVariable: "ORTA_DEMO_ADMIN_PASSWORD",
  }),
  Object.freeze({
    email: "sales@example.com",
    role: "sales",
    name: "Synthetic Demo Sales",
    phone: null,
    passwordEnvironmentVariable: "ORTA_DEMO_SALES_PASSWORD",
  }),
]);

function readRequiredValue(environment, name, minimumLength) {
  const value = environment[name];
  const nonWhitespaceLength =
    typeof value === "string" ? value.replace(/\s/g, "").length : 0;

  if (nonWhitespaceLength < minimumLength) {
    throw new Error(
      `${name} is required and must contain at least ${minimumLength} non-whitespace characters`,
    );
  }

  return value;
}

function readBooleanFlag(environment, name) {
  const value = environment[name];

  if (value === undefined || value === "" || value === "false") {
    return false;
  }

  if (value === "true") {
    return true;
  }

  throw new Error(`${name} must be exactly "true" or "false" when set`);
}

function readJwtSecret(environment = process.env) {
  return readRequiredValue(environment, "JWT_SECRET", 32);
}

function readDemoSeedConfig(environment = process.env) {
  const enabled = readBooleanFlag(environment, "ORTA_SEED_DEMO_USERS");

  if (!enabled) {
    return Object.freeze({ enabled: false, users: Object.freeze([]) });
  }

  const users = SYNTHETIC_DEMO_USERS.map((user) =>
    Object.freeze({
      email: user.email,
      role: user.role,
      name: user.name,
      phone: user.phone,
      password: readRequiredValue(
        environment,
        user.passwordEnvironmentVariable,
        12,
      ),
    }),
  );

  if (users[0].password === users[1].password) {
    throw new Error("Demo user passwords must be distinct");
  }

  return Object.freeze({
    enabled: true,
    users: Object.freeze(users),
  });
}

module.exports = {
  SYNTHETIC_DEMO_USERS,
  readDemoSeedConfig,
  readJwtSecret,
};
