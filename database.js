"use strict";

const { openDatabase } = require("./database-core");

module.exports = openDatabase({ enableWorkflowLedger: true });
