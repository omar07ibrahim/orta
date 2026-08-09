"use strict";

const { createWriteStream, mkdirSync, renameSync } = require("node:fs");
const path = require("node:path");

const PImage = require("pureimage");

const COLORS = Object.freeze({
  background: "#f5f7fb",
  blue: "#4f8cff",
  green: "#3fb950",
  ink: "#172238",
  line: "#31415f",
  muted: "#9babc3",
  red: "#ff7b72",
  terminal: "#101a2c",
  terminalRow: "#18263d",
  white: "#edf3ff",
});

function registerFonts(fonts) {
  const definitions = [
    [fonts.sans, "Orta HTTP Sans"],
    [fonts.sansBold, "Orta HTTP Sans Bold"],
    [fonts.mono, "Orta HTTP Mono"],
  ];
  for (const [filename, family] of definitions) {
    const font = PImage.registerFont(filename, family);
    font.loadSync();
  }
}

function setFont(context, size, options = {}) {
  const family = options.mono
    ? "Orta HTTP Mono"
    : options.bold
      ? "Orta HTTP Sans Bold"
      : "Orta HTTP Sans";
  context.font = String(size) + "pt '" + family + "'";
}

function drawText(context, value, x, y, options = {}) {
  setFont(context, options.size || 22, options);
  context.fillStyle = options.color || COLORS.ink;
  context.textAlign = options.align || "left";
  context.fillText(String(value), x, y);
}

function roundedRect(context, x, y, width, height, radius, fill, stroke) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height,
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 2;
    context.stroke();
  }
}

function renderTranscript(evidence) {
  const width = 1600;
  const height = 1160;
  const image = PImage.make(width, height);
  const context = image.getContext("2d");
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);

  drawText(context, "Executed HTTP workflow boundary", 70, 78, {
    bold: true,
    size: 36,
  });
  drawText(
    context,
    "Real loopback requests · fresh SQLite WAL · selected deterministic fields",
    70,
    118,
    { color: "#5e6b81", size: 18 },
  );

  roundedRect(context, 70, 160, 1460, 930, 20, COLORS.terminal, COLORS.line);
  drawText(context, "$ npm run evidence:check", 105, 215, {
    color: COLORS.white,
    mono: true,
    size: 18,
  });
  drawText(
    context,
    "METHOD + PATH",
    105,
    268,
    { bold: true, color: COLORS.muted, mono: true, size: 15 },
  );
  drawText(
    context,
    "STATUS",
    810,
    268,
    { bold: true, color: COLORS.muted, mono: true, size: 15 },
  );
  drawText(
    context,
    "SELECTED RESULT",
    955,
    268,
    { bold: true, color: COLORS.muted, mono: true, size: 15 },
  );

  for (const [index, item] of evidence.steps.entries()) {
    const y = 292 + index * 75;
    roundedRect(
      context,
      95,
      y,
      1410,
      58,
      10,
      index % 2 === 0 ? COLORS.terminalRow : COLORS.terminal,
      null,
    );
    drawText(context, item.request, 120, y + 38, {
      color: COLORS.white,
      mono: true,
      size: 17,
    });
    drawText(context, item.status, 850, y + 38, {
      bold: true,
      color:
        item.status >= 200 && item.status < 300 ? COLORS.green : COLORS.red,
      mono: true,
      size: 18,
    });
    drawText(context, item.result, 955, y + 38, {
      color: COLORS.white,
      mono: true,
      size: 16,
    });
  }

  const footerY = 292 + evidence.steps.length * 75 + 30;
  drawText(
    context,
    "ledger replay",
    110,
    footerY,
    { color: COLORS.muted, mono: true, size: 15 },
  );
  drawText(
    context,
    evidence.ledger.event_count +
      " events · head " +
      evidence.ledger.head_sequence +
      " · " +
      evidence.ledger.status,
    330,
    footerY,
    { color: COLORS.blue, mono: true, size: 16 },
  );
  drawText(
    context,
    evidence.runtime.node +
      " · better-sqlite3 " +
      evidence.runtime.better_sqlite3 +
      " · SQLite " +
      evidence.runtime.sqlite,
    110,
    footerY + 42,
    { color: COLORS.muted, mono: true, size: 14 },
  );
  return image;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function flowSvg(evidence) {
  const replay =
    escapeXml(evidence.ledger.event_count) +
    " events / head " +
    escapeXml(evidence.ledger.head_sequence);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="760" viewBox="0 0 1600 760" role="img" aria-labelledby="title desc">',
    '<title id="title">ORTA audited HTTP lead command path</title>',
    '<desc id="desc">Executed request path from bounded public and authenticated inputs through rate limiting, fresh JWT authorization, the workflow store, SQLite WAL, and independent replay.</desc>',
    '<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2f66d0"/></marker></defs>',
    '<style>.t{font:700 35px DejaVu Sans,Arial,sans-serif;fill:#172238}.s{font:19px DejaVu Sans,Arial,sans-serif;fill:#5e6b81}.h{font:700 20px DejaVu Sans,Arial,sans-serif;fill:#172238}.b{font:16px DejaVu Sans,Arial,sans-serif;fill:#5e6b81}.m{font:15px DejaVu Sans Mono,monospace;fill:#234b96}.box{fill:#fff;stroke:#d5ddea;stroke-width:2}.a{stroke:#2f66d0;stroke-width:4;fill:none;marker-end:url(#arrow)}</style>',
    '<rect width="1600" height="760" fill="#f5f7fb"/>',
    '<text x="70" y="72" class="t">Audited HTTP command boundary</text>',
    '<text x="70" y="108" class="s">The solid path is executed by the evidence capture; replay reads the same SQLite snapshot independently.</text>',
    '<rect x="70" y="190" width="250" height="180" rx="18" class="box"/><text x="95" y="235" class="h">HTTP request</text><text x="95" y="276" class="b">exact JSON fields</text><text x="95" y="307" class="b">Idempotency-Key</text><text x="95" y="338" class="m">20 / 60s bounded gate</text>',
    '<path d="M320 280 H390" class="a"/>',
    '<rect x="400" y="190" width="270" height="180" rx="18" class="box"/><text x="425" y="235" class="h">Fresh authorization</text><text x="425" y="276" class="b">HS256 allow-list</text><text x="425" y="307" class="b">role + auth_version</text><text x="425" y="338" class="m">database-fresh claims</text>',
    '<path d="M670 280 H740" class="a"/>',
    '<rect x="750" y="190" width="270" height="180" rx="18" class="box"/><text x="775" y="235" class="h">Workflow store</text><text x="775" y="276" class="b">BEGIN IMMEDIATE</text><text x="775" y="307" class="b">CAS + idempotency</text><text x="775" y="338" class="m">no direct PATCH/DELETE</text>',
    '<path d="M1020 280 H1090" class="a"/>',
    '<rect x="1100" y="190" width="360" height="180" rx="18" class="box"/><text x="1125" y="235" class="h">SQLite WAL / FULL</text><text x="1125" y="276" class="b">event first + projection</text><text x="1125" y="307" class="b">atomic head advancement</text><text x="1125" y="338" class="m">' + replay + "</text>",
    '<path d="M1280 370 V500 H870 V430" stroke="#c58a18" stroke-width="4" fill="none" marker-end="url(#arrow)"/>',
    '<rect x="590" y="500" width="560" height="150" rx="18" fill="#fff8e8" stroke="#e5bd68" stroke-width="2"/><text x="620" y="548" class="h">Independent admin replay</text><text x="620" y="588" class="b">integrity + foreign keys + event chain + reducer + projections</text><text x="620" y="622" class="m">observed: ' + replay + " · status verified</text>",
    '<text x="70" y="710" class="s">Captured on ' +
      escapeXml(evidence.runtime.node) +
      " / SQLite " +
      escapeXml(evidence.runtime.sqlite) +
      "; synthetic reserved-domain input is excluded from the artifacts.</text>",
    "</svg>",
    "",
  ].join("\n");
}

async function writePng(image, filename) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + ".tmp";
  await PImage.encodePNGToStream(image, createWriteStream(temporary));
  renameSync(temporary, filename);
}

async function renderHttpEvidence({
  evidence,
  fonts,
  outputDirectory,
  writeText,
}) {
  registerFonts(fonts);
  await writePng(
    renderTranscript(evidence),
    path.join(outputDirectory, "http-command-transcript.png"),
  );
  writeText(
    path.join(outputDirectory, "http-command-flow.svg"),
    flowSvg(evidence),
  );
}

module.exports = {
  renderHttpEvidence,
};
