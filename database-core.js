"use strict";

const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const path = require("path");

const { readDemoSeedConfig } = require("./config");

const DEFAULT_DATABASE_PATH = path.join(__dirname, "orta-study.db");

function resolveDatabasePath(environment = process.env) {
  const configuredPath = environment.ORTA_DB_PATH;

  if (typeof configuredPath === "string" && configuredPath.trim() !== "") {
    return path.resolve(configuredPath);
  }

  return DEFAULT_DATABASE_PATH;
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'student', 'sales')),
      name TEXT NOT NULL,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT NOT NULL,
      message TEXT,
      status TEXT DEFAULT 'new'
        CHECK(status IN ('new', 'contacted', 'converted', 'rejected')),
      assigned_to INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON ai_chats(user_id);
  `);
}

function seedSyntheticDemoUsers(database, seedConfig) {
  if (!seedConfig.enabled) {
    return 0;
  }

  const findUser = database.prepare(
    "SELECT id FROM users WHERE email = ?",
  );
  const insertUser = database.prepare(`
    INSERT INTO users (email, password, role, name, phone)
    VALUES (?, ?, ?, ?, ?)
  `);

  const seedTransaction = database.transaction(() => {
    let insertedUsers = 0;

    for (const user of seedConfig.users) {
      if (findUser.get(user.email)) {
        continue;
      }

      insertUser.run(
        user.email,
        bcrypt.hashSync(user.password, 12),
        user.role,
        user.name,
        user.phone,
      );
      insertedUsers += 1;
    }

    return insertedUsers;
  });

  return seedTransaction();
}

function openDatabase({
  filename = resolveDatabasePath(process.env),
  environment = process.env,
} = {}) {
  // Validate the complete opt-in seed configuration before opening or
  // mutating a database file.
  const seedConfig = readDemoSeedConfig(environment);
  const database = new Database(filename);

  try {
    database.pragma("foreign_keys = ON");
    initializeSchema(database);
    seedSyntheticDemoUsers(database, seedConfig);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  initializeSchema,
  openDatabase,
  resolveDatabasePath,
  seedSyntheticDemoUsers,
};
