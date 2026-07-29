"use strict";

function formatStartupMessage() {
  return [
    "ORTA Study API is ready.",
    "See README.md for local endpoints and optional synthetic demo setup.",
  ].join("\n");
}

module.exports = {
  formatStartupMessage,
};
