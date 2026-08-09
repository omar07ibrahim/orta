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

function readCorsOrigins(environment = process.env) {
  const configured = environment.ORTA_ALLOWED_ORIGINS;
  if (configured === undefined || configured === "") {
    return Object.freeze([]);
  }
  if (
    typeof configured !== "string" ||
    Buffer.byteLength(configured, "utf8") > 2_048
  ) {
    throw new Error("ORTA_ALLOWED_ORIGINS is invalid");
  }

  const values = configured.split(",");
  if (values.length > 10) {
    throw new Error("ORTA_ALLOWED_ORIGINS accepts at most 10 origins");
  }
  const origins = values.map((rawValue) => {
    const value = rawValue.trim();
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("ORTA_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== value
    ) {
      throw new Error("ORTA_ALLOWED_ORIGINS must contain exact HTTP origins");
    }
    return value;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error("ORTA_ALLOWED_ORIGINS contains a duplicate origin");
  }
  return Object.freeze(origins);
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
  readCorsOrigins,
  readDemoSeedConfig,
  readJwtSecret,
};
