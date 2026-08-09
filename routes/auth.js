"use strict";

const bcrypt = require("bcryptjs");
const express = require("express");
const jwt = require("jsonwebtoken");

const database = require("../database");
const {
  JWT_SECRET,
  authenticateToken,
} = require("../middleware/auth");

const router = express.Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function exactBody(value, allowedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function boundedString(value, minimumBytes, maximumBytes) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const length = Buffer.byteLength(normalized, "utf8");
  if (length < minimumBytes || length > maximumBytes || normalized.includes("\0")) {
    return null;
  }
  return normalized;
}

function normalizedEmail(value) {
  const email = boundedString(value, 3, 320);
  if (!email || !EMAIL_PATTERN.test(email)) {
    return null;
  }
  return email.toLowerCase();
}

function normalizedPassword(value) {
  if (typeof value !== "string") {
    return null;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  const nonWhitespace = value.replace(/\s/gu, "").length;
  if (bytes > 72 || nonWhitespace < 12) {
    return null;
  }
  return value;
}

function issueToken(user) {
  return jwt.sign(
    {
      auth_version: user.auth_version,
      email: user.email,
      id: user.id,
      role: user.role,
    },
    JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "15m",
    },
  );
}

router.post("/login", (req, res) => {
  if (!exactBody(req.body, ["email", "password"])) {
    return res.status(400).json({ error: "invalid_login_fields" });
  }
  const email = normalizedEmail(req.body.email);
  if (!email || typeof req.body.password !== "string") {
    return res.status(400).json({ error: "invalid_login_fields" });
  }

  try {
    const user = database
      .prepare(
        "SELECT id, email, password, role, name, phone, auth_version, created_at " +
          "FROM main.users WHERE email = ?",
      )
      .get(email);
    if (!user || !bcrypt.compareSync(req.body.password, user.password)) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const { password, ...publicUser } = user;
    void password;
    return res.json({
      token: issueToken(publicUser),
      user: publicUser,
    });
  } catch (error) {
    console.error("Login failure:", error && error.name);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

router.post("/register", (req, res) => {
  if (!exactBody(req.body, ["email", "name", "password", "phone"])) {
    return res.status(400).json({ error: "invalid_registration_fields" });
  }
  const email = normalizedEmail(req.body.email);
  const name = boundedString(req.body.name, 1, 200);
  const password = normalizedPassword(req.body.password);
  const phone =
    req.body.phone === undefined || req.body.phone === null || req.body.phone === ""
      ? null
      : boundedString(req.body.phone, 1, 64);
  if (!email || !name || !password || (req.body.phone && !phone)) {
    return res.status(400).json({ error: "invalid_registration_fields" });
  }

  try {
    const result = database
      .prepare(
        "INSERT INTO main.users (email, password, role, name, phone) " +
          "VALUES (?, ?, 'student', ?, ?)",
      )
      .run(email, bcrypt.hashSync(password, 12), name, phone);
    const user = database
      .prepare(
        "SELECT id, email, role, name, phone, auth_version, created_at " +
          "FROM main.users WHERE id = ?",
      )
      .get(result.lastInsertRowid);
    return res.status(201).json({
      token: issueToken(user),
      user,
    });
  } catch (error) {
    if (error && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "email_already_registered" });
    }
    console.error("Registration failure:", error && error.name);
    return res.status(500).json({ error: "internal_server_error" });
  }
});

router.get("/me", authenticateToken, (req, res) => {
  const user = database
    .prepare(
      "SELECT id, email, role, name, phone, auth_version, created_at " +
        "FROM main.users WHERE id = ?",
    )
    .get(req.user.id);
  if (!user) {
    return res.status(401).json({ error: "token_stale" });
  }
  return res.json(user);
});

module.exports = router;
