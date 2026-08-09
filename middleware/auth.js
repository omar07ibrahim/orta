"use strict";

const jwt = require("jsonwebtoken");

const { readJwtSecret } = require("../config");
const database = require("../database");

const JWT_SECRET = readJwtSecret(process.env);
const TOKEN_ROLES = new Set(["admin", "sales", "student"]);

const findCurrentUser = database.prepare(
  "SELECT id, email, role, auth_version FROM main.users WHERE id = ?",
);

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readBearerToken(value) {
  if (
    typeof value !== "string" ||
    value.length <= 7 ||
    value.length > 4_096 ||
    value.slice(0, 7) !== "Bearer " ||
    value.trim() !== value
  ) {
    return null;
  }
  const token = value.slice(7);
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) {
    return null;
  }
  return token;
}

function authenticateToken(req, res, next) {
  const token = readBearerToken(req.headers.authorization);
  if (token === null) {
    return res.status(401).json({ error: "invalid_authorization_header" });
  }

  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    });
  } catch {
    return res.status(401).json({ error: "token_invalid_or_expired" });
  }

  if (
    claims === null ||
    typeof claims !== "object" ||
    Array.isArray(claims) ||
    !positiveSafeInteger(claims.id) ||
    !positiveSafeInteger(claims.auth_version) ||
    typeof claims.email !== "string" ||
    !TOKEN_ROLES.has(claims.role)
  ) {
    return res.status(401).json({ error: "token_claims_invalid" });
  }

  const user = findCurrentUser.get(claims.id);
  if (
    !user ||
    user.email !== claims.email ||
    user.role !== claims.role ||
    user.auth_version !== claims.auth_version
  ) {
    return res.status(401).json({ error: "token_stale" });
  }

  req.user = Object.freeze({
    auth_version: user.auth_version,
    email: user.email,
    id: user.id,
    role: user.role,
  });
  return next();
}

function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "authentication_required" });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: "insufficient_permissions" });
    }
    return next();
  };
}

module.exports = {
  JWT_SECRET,
  authenticateToken,
  requireRole,
};
