"use strict";

const cors = require("cors");
const express = require("express");
const path = require("path");
require("dotenv").config();

const { readJwtSecret } = require("./config");
const { formatStartupMessage } = require("./startup-output");

readJwtSecret(process.env);
const database = require("./database");

const aiRoutes = require("./routes/ai");
const authRoutes = require("./routes/auth");
const leadsRoutes = require("./routes/leads");
const usersRoutes = require("./routes/users");

const app = express();
const PORT = process.env.PORT || 5000;

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "16kb", strict: true }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/ai", aiRoutes);

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../dist")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../dist/index.html"));
  });
}

app.use((error, req, res, next) => {
  void req;
  void next;
  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ error: "request_body_too_large" });
  }
  if (error instanceof SyntaxError && error && error.status === 400) {
    return res.status(400).json({ error: "invalid_json" });
  }
  console.error("Unhandled request failure:", error && error.name);
  return res.status(500).json({ error: "internal_server_error" });
});

function start() {
  return app.listen(PORT, () => {
    console.log(formatStartupMessage());
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  app,
  database,
  start,
};
