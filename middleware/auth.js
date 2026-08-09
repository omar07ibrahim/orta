"use strict";

const jwt = require("jsonwebtoken");

const { readJwtSecret } = require("../config");
const database = require("../database");

const JWT_SECRET = readJwtSecret(process.env);
const TOKEN_ROLES = new Set(["admin", "sales", "student"]);
const TOKEN_PATTERN =
  /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;

const findCurrentUser = database.prepare(
  "SELECT id, email, role, auth_version FROM main.users WHERE id = ?",
);

function authenticationFailure(res, code) {
  return res.status(401).json({ error: code });
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function authenticateToken(req, res, next) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") {
    return authenticationFailure(res, "access_token_required");
  }

  const match = TOKEN_PATTERN.exec(authorization);
  if (!match) {
    return authenticationFailure(res, "invalid_authorization_header");
  }

  let claims;
  try {
    claims = jwt.verify(match[1], JWT_SECRET, {
      algorithms: ["HS256"],
    });
  } catch {
    return authenticationFailure(res, "token_invalid_or_expired");
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
    return authenticationFailure(res, "token_claims_invalid");
  }

  const user = findCurrentUser.get(claims.id);
  if (
    !user ||
    user.email !== claims.email ||
    user.role !== claims.role ||
    user.auth_version !== claims.auth_version
  ) {
    return authenticationFailure(res, "token_stale");
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
      return authenticationFailure(res, "authentication_required");
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
