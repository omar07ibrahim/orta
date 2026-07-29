"use strict";

const jwt = require("jsonwebtoken");

const { readJwtSecret } = require("../config");

const JWT_SECRET = readJwtSecret(process.env);

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token is required" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(403).json({ error: "Token is invalid or expired" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication is required" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    return next();
  };
}

module.exports = {
  authenticateToken,
  requireRole,
  JWT_SECRET,
};
