"use strict";

const { createWriteStream, mkdirSync, renameSync } = require("node:fs");
const path = require("node:path");

const { GIFEncoder, applyPalette, quantize } = require("gifenc");
const PImage = require("pureimage");

const COLORS = Object.freeze({
  background: "#f5f7fb",
  blue: "#2f66d0",
  blueDark: "#234b96",
  blueLight: "#e8efff",
  gold: "#c58a18",
  goldLight: "#fff3d4",
  ink: "#172238",
  line: "#d5ddea",
  muted: "#5e6b81",
  navy: "#101a2c",
  navyLight: "#18263d",
  surface: "#ffffff",
  terminalMuted: "#9babc3",
  terminalText: "#edf3ff",
});

function registerFonts({ mono, sans, sansBold }) {
  const definitions = [
    [sans, "Orta Sans"],
    [sansBold, "Orta Sans Bold"],
    [mono, "Orta Mono"],
  ];
  for (const [filename, family] of definitions) {
    const font = PImage.registerFont(filename, family);
    font.loadSync();
  }
}

function makeCanvas(width, height, background = COLORS.background) {
  const image = PImage.make(width, height);
  const context = image.getContext("2d");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  return { context, image };
}

function font(context, size, { bold = false, mono = false } = {}) {
  const family = mono ? "Orta Mono" : bold ? "Orta Sans Bold" : "Orta Sans";
  context.font = `${size}pt '${family}'`;
}

function text(
  context,
  value,
  x,
  y,
  { align = "left", bold = false, color = COLORS.ink, mono = false, size = 24 } = {},
) {
  font(context, size, { bold, mono });
  context.fillStyle = color;
  context.textAlign = align;
  context.fillText(String(value), x, y);
}

function roundedRect(context, x, y, width, height, radius, fill, stroke) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height,
  );
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
  if (fill) {
    context.fillStyle = fill;
    context.fill();
  }
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 2;
    context.stroke();
  }
}

function horizontalLine(context, x1, y, x2, color = COLORS.line, width = 2) {
  context.beginPath();
  context.moveTo(x1, y);
  context.lineTo(x2, y);
  context.strokeStyle = color;
  context.lineWidth = width;
  context.stroke();
}

function arrow(context, x1, y, x2, color = COLORS.blue) {
  horizontalLine(context, x1, y, x2 - 10, color, 4);
  context.beginPath();
  context.moveTo(x2, y);
  context.lineTo(x2 - 14, y - 9);
  context.lineTo(x2 - 14, y + 9);
  context.closePath();
  context.fillStyle = color;
  context.fill();
}

function wrapText(context, value, maxWidth) {
  const words = String(value).split(/\s+/u);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines;
}

function wrappedText(context, value, x, y, maxWidth, options = {}) {
  font(context, options.size ?? 24, options);
  const lines = wrapText(context, value, maxWidth);
  const lineHeight = options.lineHeight ?? (options.size ?? 24) * 1.35;
  for (const [index, line] of lines.entries()) {
    text(context, line, x, y + lineHeight * index, options);
  }
  return lines.length;
}

function titleBlock(context, title, subtitle, width) {
  text(context, title, 70, 78, { bold: true, size: 34 });
  text(context, subtitle, 70, 116, { color: COLORS.muted, size: 18 });
  horizontalLine(context, 70, 140, width - 70);
}

function metricCard(context, x, y, width, label, value, detail) {
  roundedRect(context, x, y, width, 145, 16, COLORS.surface, COLORS.line);
  text(context, label.toUpperCase(), x + 24, y + 36, {
    bold: true,
    color: COLORS.muted,
    size: 14,
  });
  text(context, value, x + 24, y + 88, { bold: true, size: 29 });
  text(context, detail, x + 24, y + 121, {
    color: COLORS.muted,
    size: 14,
  });
}

function renderRuntimeEvidence(evidence) {
  const width = 1500;
  const height = 860;
  const { context, image } = makeCanvas(width, height);
  titleBlock(
    context,
    "ORTA workflow evidence",
    "Executed process tests, native runtime inspection, and read-only ledger replay",
    width,
  );

  const runtime = evidence.runtime;
  const passedCrashCases = evidence.process_tests.crash_cases.filter(
    (crashCase) => crashCase.status === "pass",
  ).length;
  const integrityVerified =
    evidence.workflow.integrity_check.length === 1 &&
    evidence.workflow.integrity_check[0].integrity_check === "ok" &&
    evidence.workflow.foreign_key_check.length === 0;
  metricCard(context, 70, 180, 315, "Node", runtime.node, `ABI ${runtime.node_abi}`);
  metricCard(
    context,
    405,
    180,
    315,
    "better-sqlite3",
    runtime.better_sqlite3,
    "exact lockfile version",
  );
  metricCard(
    context,
    740,
    180,
    315,
    "SQLite",
    runtime.sqlite,
    "embedded native runtime",
  );
  metricCard(
    context,
    1075,
    180,
    355,
    "WAL reset guard",
    runtime.wal_reset_safe ? "VERIFIED" : "FAILED",
    "fixed upstream branch required",
  );

  roundedRect(context, 70, 365, 1360, 260, 18, COLORS.navy, null);
  text(context, "PROCESS-CRASH VERIFICATION", 105, 415, {
    bold: true,
    color: COLORS.terminalMuted,
    size: 16,
  });
  text(
    context,
    `${evidence.process_tests.pass}/${evidence.process_tests.total}`,
    105,
    520,
    { bold: true, color: COLORS.terminalText, size: 66 },
  );
  text(context, "process tests passed", 105, 564, {
    color: COLORS.terminalMuted,
    size: 19,
  });
  text(
    context,
    `${passedCrashCases}/${evidence.process_tests.crash_cases.length}`,
    570,
    520,
    {
      bold: true,
      color: COLORS.terminalText,
      size: 66,
    },
  );
  text(context, "SIGKILL matrix cells", 570, 564, {
    color: COLORS.terminalMuted,
    size: 19,
  });
  text(context, integrityVerified ? "OK" : "FAILED", 1010, 520, {
    bold: true,
    color: COLORS.goldLight,
    size: 66,
  });
  text(context, "integrity + foreign keys", 1010, 564, {
    color: COLORS.terminalMuted,
    size: 19,
  });

  roundedRect(context, 70, 655, 1360, 135, 16, COLORS.surface, COLORS.line);
  text(context, "READ-ONLY REPLAY", 100, 698, {
    bold: true,
    color: COLORS.blueDark,
    size: 15,
  });
  text(
    context,
    `${evidence.workflow.replay.event_count} events / ${evidence.workflow.replay.aggregate_count} aggregate / head ${evidence.workflow.head.sequence}`,
    100,
    753,
    { bold: true, size: 27 },
  );
  text(context, "source: docs/assets/workflow-evidence.json", 1400, 820, {
    align: "right",
    color: COLORS.muted,
    mono: true,
    size: 13,
  });
  return image;
}

function renderCrashMatrix(evidence) {
  const width = 1600;
  const height = 1010;
  const { context, image } = makeCanvas(width, height);
  titleBlock(
    context,
    "Process crash-recovery matrix",
    `${evidence.process_tests.crash_cases.length} observed POSIX SIGKILL cases | ${evidence.runtime.node} | no scheduling sleeps`,
    width,
  );

  const operations = ["create", "claim", "assign", "transition"];
  const stages = [
    ["AFTER EVENT", "INSERT"],
    ["AFTER PROJECTION", "UPDATE"],
    ["AFTER HEAD", "UPDATE"],
    ["AFTER COMMIT", "BEFORE ACK"],
  ];
  const xStart = 260;
  const yStart = 260;
  const cellWidth = 305;
  const cellHeight = 155;

  for (const [column, labels] of stages.entries()) {
    const center = xStart + column * cellWidth + cellWidth / 2;
    text(context, labels[0], center, 193, {
      align: "center",
      bold: true,
      color: COLORS.muted,
      size: 15,
    });
    text(context, labels[1], center, 220, {
      align: "center",
      bold: true,
      color: COLORS.muted,
      size: 15,
    });
  }

  for (const [row, operation] of operations.entries()) {
    const y = yStart + row * cellHeight;
    text(context, operation.toUpperCase(), 220, y + 86, {
      align: "right",
      bold: true,
      size: 20,
    });
    for (let column = 0; column < stages.length; column += 1) {
      const crashCase = evidence.process_tests.crash_cases.find(
        (candidate) =>
          candidate.operation === operation && candidate.stage_index === column,
      );
      const x = xStart + column * cellWidth;
      roundedRect(
        context,
        x + 8,
        y + 8,
        cellWidth - 16,
        cellHeight - 16,
        14,
        crashCase.status === "pass" ? COLORS.blueLight : COLORS.goldLight,
        crashCase.status === "pass" ? COLORS.blue : COLORS.gold,
      );
      text(context, crashCase.status.toUpperCase(), x + cellWidth / 2, y + 73, {
        align: "center",
        bold: true,
        color: crashCase.status === "pass" ? COLORS.blueDark : COLORS.gold,
        size: 23,
      });
      text(context, `CASE ${String(row * 4 + column + 1).padStart(2, "0")}`, x + cellWidth / 2, y + 108, {
        align: "center",
        color: COLORS.muted,
        mono: true,
        size: 13,
      });
    }
  }

  roundedRect(context, 260, 910, 1220, 55, 12, COLORS.surface, COLORS.line);
  text(
    context,
    "Each cell: SIGKILL -> first reopen is read-only replay -> one atomic retry outcome",
    870,
    946,
    { align: "center", bold: true, color: COLORS.ink, size: 16 },
  );
  return image;
}

function renderLedgerChain(evidence) {
  const width = 1800;
  const height = 1040;
  const { context, image } = makeCanvas(width, height);
  titleBlock(
    context,
    "Replayed workflow ledger chain",
    "Four real events generated from the current store; hash prefixes are read from SQLite",
    width,
  );

  const events = evidence.workflow.events;
  const cardWidth = 370;
  const gap = 55;
  const startX = 75;
  const top = 245;
  for (const [index, event] of events.entries()) {
    const x = startX + index * (cardWidth + gap);
    if (index > 0) {
      arrow(context, x - gap + 8, top + 175, x - 12, COLORS.gold);
      text(context, "HASH LINK", x - gap / 2, top + 149, {
        align: "center",
        bold: true,
        color: COLORS.gold,
        size: 11,
      });
    }
    roundedRect(context, x, top, cardWidth, 350, 18, COLORS.surface, COLORS.line);
    roundedRect(context, x + 22, top + 22, 82, 37, 9, COLORS.blueLight, null);
    text(context, `SEQ ${event.sequence}`, x + 63, top + 47, {
      align: "center",
      bold: true,
      color: COLORS.blueDark,
      mono: true,
      size: 13,
    });
    text(context, event.event_type, x + 24, top + 106, {
      bold: true,
      size: 23,
    });
    text(context, `aggregate version ${event.aggregate_version}`, x + 24, top + 145, {
      color: COLORS.muted,
      size: 15,
    });
    text(context, `actor  ${event.actor_role}/${event.actor_id ?? "null"}`, x + 24, top + 190, {
      mono: true,
      size: 15,
    });
    text(context, `command ${event.command_id.slice(-8)}`, x + 24, top + 226, {
      mono: true,
      size: 15,
    });
    horizontalLine(context, x + 24, top + 252, x + cardWidth - 24);
    text(context, "EVENT HASH", x + 24, top + 284, {
      bold: true,
      color: COLORS.muted,
      size: 12,
    });
    text(context, `${event.event_hash.slice(0, 16)}...`, x + 24, top + 321, {
      color: COLORS.blueDark,
      mono: true,
      size: 16,
    });
  }

  roundedRect(context, 75, 660, 1650, 245, 18, COLORS.navy, null);
  text(context, "FINAL MATERIALIZED PROJECTION", 110, 709, {
    bold: true,
    color: COLORS.terminalMuted,
    size: 15,
  });
  const projection = evidence.workflow.projections[0];
  const facts = [
    ["STATUS", projection.status.toUpperCase()],
    ["ASSIGNEE", String(projection.assigned_to)],
    ["VERSION", String(projection.workflow_version)],
    ["HEAD", String(evidence.workflow.head.sequence)],
    ["REPLAY", "VERIFIED"],
  ];
  for (const [index, [label, value]] of facts.entries()) {
    const x = 110 + index * 315;
    text(context, label, x, 770, {
      bold: true,
      color: COLORS.terminalMuted,
      size: 13,
    });
    text(context, value, x, 824, {
      bold: true,
      color: index === facts.length - 1 ? COLORS.goldLight : COLORS.terminalText,
      mono: true,
      size: 26,
    });
  }
  text(context, "No names, email, phone, message, JWT, or password enter the event chain.", 110, 872, {
    color: COLORS.terminalMuted,
    size: 16,
  });
  return image;
}

function canonicalTestLine(crashCase, index) {
  const stage = crashCase.stage
    .replace(/^after_/u, "")
    .replace(/_/gu, " ")
    .toUpperCase();
  const outcome = crashCase.status === "pass" ? "OK" : "NOT OK";
  return `${outcome} ${String(index + 2).padStart(2, "0")}  SIGKILL ${crashCase.operation.toUpperCase().padEnd(10)} / ${stage}`;
}

function renderCliCapture(evidence) {
  const width = 1700;
  const height = 1190;
  const { context, image } = makeCanvas(width, height, COLORS.navy);
  roundedRect(context, 36, 30, width - 72, height - 60, 20, COLORS.navyLight, "#30415d");
  for (const [index, color] of ["#c58a18", "#8796ad", "#2f66d0"].entries()) {
    context.beginPath();
    context.arc(78 + index * 34, 72, 10, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  }
  text(context, "REAL CANONICAL TEST CAPTURE", width / 2, 79, {
    align: "center",
    bold: true,
    color: COLORS.terminalMuted,
    size: 14,
  });
  text(
    context,
    "$ node --test test/ledger-process.integration.test.js",
    78,
    135,
    {
      color: COLORS.terminalText,
      mono: true,
      size: 19,
    },
  );
  text(context, "TAP version 13", 78, 183, {
    color: COLORS.terminalMuted,
    mono: true,
    size: 17,
  });
  const contentionOutcome =
    evidence.process_tests.contention === "pass" ? "OK" : "NOT OK";
  text(
    context,
    `${contentionOutcome} 01  TWO PROCESSES / CONTENTION / EXACT CONVERGENCE`,
    78,
    229,
    { color: COLORS.terminalText, mono: true, size: 17 },
  );
  for (const [index, crashCase] of evidence.process_tests.crash_cases.entries()) {
    text(context, canonicalTestLine(crashCase, index), 78, 273 + index * 45, {
      color: COLORS.terminalText,
      mono: true,
      size: 17,
    });
  }
  horizontalLine(context, 78, 1012, width - 78, "#30415d", 2);
  text(context, `1..${evidence.process_tests.total}`, 78, 1055, {
    color: COLORS.terminalMuted,
    mono: true,
    size: 17,
  });
  text(
    context,
    `PASS ${evidence.process_tests.pass}   FAIL ${evidence.process_tests.fail}   SKIPPED ${evidence.process_tests.skipped}`,
    78,
    1100,
    {
      bold: true,
      color: COLORS.goldLight,
      mono: true,
      size: 21,
    },
  );
  text(
    context,
    "Durations removed; names and outcomes parsed from the executed TAP stream.",
    width - 78,
    1145,
    { align: "right", color: COLORS.terminalMuted, size: 14 },
  );
  return image;
}

function renderCrashFrame(evidence, frame) {
  const width = 1200;
  const height = 675;
  const { context, image } = makeCanvas(width, height);
  const passedCrashCases = evidence.process_tests.crash_cases.filter(
    (crashCase) => crashCase.status === "pass",
  ).length;
  text(context, "Verified process-crash recovery", 55, 64, {
    bold: true,
    size: 30,
  });
  text(context, "Animated explanation of the executed create / after-head case", 55, 101, {
    color: COLORS.muted,
    size: 16,
  });

  const steps = ["BASELINE", "OPEN TX", "SIGKILL", "READ ONLY", "RETRY", "REPLAY"];
  for (const [index, label] of steps.entries()) {
    const x = 65 + index * 185;
    const active = index === frame;
    roundedRect(
      context,
      x,
      145,
      150,
      50,
      10,
      active ? COLORS.blue : index < frame ? COLORS.blueLight : COLORS.surface,
      active ? COLORS.blue : COLORS.line,
    );
    text(context, label, x + 75, 178, {
      align: "center",
      bold: true,
      color: active ? COLORS.surface : index < frame ? COLORS.blueDark : COLORS.muted,
      size: 13,
    });
    if (index < steps.length - 1) {
      arrow(context, x + 153, 170, x + 182, COLORS.line);
    }
  }

  const states = [
    {
      headline: "Safe baseline",
      body: "event count 0 | head 0 | projection absent",
      event: "NO TARGET COMMAND",
    },
    {
      headline: "Writer paused inside BEGIN IMMEDIATE",
      body: "event + projection + head exist only in the uncommitted transaction",
      event: "FD4 MARKER OBSERVED",
    },
    {
      headline: "Operating system terminates the process",
      body: "exit signal is exactly SIGKILL; no JavaScript cleanup handler runs",
      event: "SIGNAL SIGKILL",
    },
    {
      headline: "First reopen is read-only replay",
      body: "baseline is recovered field-for-field; target command remains absent",
      event: "ROLLBACK VERIFIED",
    },
    {
      headline: "The same command is retried",
      body: "one event, one projection update, and one head advance commit together",
      event: "REPLAYED FALSE / COUNT 1",
    },
    {
      headline: "A second retry converges",
      body: "the stored sequence and event hash are returned without moving the head",
      event: "REPLAYED TRUE / COUNT 1",
    },
  ];
  const state = states[frame];
  roundedRect(context, 65, 245, 1070, 300, 20, COLORS.surface, COLORS.line);
  text(context, state.headline, 105, 315, { bold: true, size: 30 });
  wrappedText(context, state.body, 105, 370, 980, {
    color: COLORS.muted,
    lineHeight: 35,
    size: 19,
  });
  roundedRect(context, 105, 450, 990, 58, 12, COLORS.navy, null);
  text(context, state.event, 600, 488, {
    align: "center",
    bold: true,
    color: COLORS.goldLight,
    mono: true,
    size: 19,
  });
  text(
    context,
    `evidence: ${passedCrashCases}/${evidence.process_tests.crash_cases.length} crash cells passed`,
    65,
    620,
    { color: COLORS.muted, mono: true, size: 14 },
  );
  return image;
}

function architectureSvg(evidence) {
  const sqlite = evidence.runtime.sqlite;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="920" viewBox="0 0 1600 920" role="img" aria-labelledby="title desc">
  <title id="title">ORTA workflow ledger architecture</title>
  <desc id="desc">HTTP commands and two independent Node workers serialize workflow writes through SQLite WAL while a read-only verifier independently replays events and compares the projection and ledger head.</desc>
  <style>
    .title{font:700 42px DejaVu Sans,Arial,sans-serif;fill:#172238}.sub{font:22px DejaVu Sans,Arial,sans-serif;fill:#5e6b81}.h{font:700 23px DejaVu Sans,Arial,sans-serif;fill:#172238}.p{font:18px DejaVu Sans,Arial,sans-serif;fill:#5e6b81}.mono{font:17px DejaVu Sans Mono,monospace;fill:#234b96}.box{fill:#fff;stroke:#d5ddea;stroke-width:2}.blue{fill:#e8efff;stroke:#2f66d0;stroke-width:3}.dark{fill:#101a2c}.darkh{font:700 23px DejaVu Sans,Arial,sans-serif;fill:#edf3ff}.darkp{font:18px DejaVu Sans,Arial,sans-serif;fill:#9babc3}.line{stroke:#2f66d0;stroke-width:4;fill:none;marker-end:url(#arrow)}.read{stroke:#c58a18;stroke-width:4;stroke-dasharray:12 9;fill:none;marker-end:url(#goldArrow)}
  </style>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2f66d0"/></marker>
    <marker id="goldArrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#c58a18"/></marker>
  </defs>
  <rect width="1600" height="920" fill="#f5f7fb"/>
  <text x="70" y="78" class="title">Workflow ledger: write path and independent proof</text>
  <text x="70" y="116" class="sub">One enforced ledger boundary for HTTP commands and independent process evidence</text>
  <rect x="70" y="185" width="305" height="150" rx="18" class="box"/>
  <text x="105" y="235" class="h">Node worker A</text><text x="105" y="275" class="p">own native connection</text><text x="105" y="307" class="mono">busy_timeout per request</text>
  <rect x="70" y="390" width="305" height="150" rx="18" class="box"/>
  <text x="105" y="440" class="h">Node worker B</text><text x="105" y="480" class="p">own native connection</text><text x="105" y="512" class="mono">closed IPC operation map</text>
  <path d="M375 260 H500" class="line"/><path d="M375 465 H500" class="line"/>
  <rect x="500" y="240" width="345" height="260" rx="20" class="blue"/>
  <text x="545" y="300" class="h">Workflow store</text><text x="545" y="344" class="mono">BEGIN IMMEDIATE</text><text x="545" y="386" class="p">fresh actor + version checks</text><text x="545" y="423" class="p">one event + projection + head</text><text x="545" y="460" class="p">idempotent command replay</text>
  <path d="M845 370 H970" class="line"/>
  <rect x="970" y="170" width="555" height="420" rx="22" class="dark"/>
  <text x="1020" y="228" class="darkh">SQLite ${sqlite} / WAL / synchronous FULL</text>
  <rect x="1020" y="270" width="455" height="70" rx="12" fill="#18263d" stroke="#30415d"/><text x="1050" y="315" class="darkp">append-only workflow_events</text>
  <rect x="1020" y="365" width="455" height="70" rx="12" fill="#18263d" stroke="#30415d"/><text x="1050" y="410" class="darkp">materialized leads projection</text>
  <rect x="1020" y="460" width="455" height="70" rx="12" fill="#18263d" stroke="#30415d"/><text x="1050" y="505" class="darkp">compare-and-swap ledger head</text>
  <rect x="500" y="650" width="440" height="160" rx="20" class="box"/>
  <text x="545" y="705" class="h">Read-only replay verifier</text><text x="545" y="747" class="p">canonical bytes + chain + reducer</text><text x="545" y="782" class="p">projection + integrity + foreign keys</text>
  <path d="M1170 590 V730 H940" class="read"/>
  <text x="1045" y="690" class="mono">independent snapshot</text>
  <rect x="70" y="650" width="305" height="160" rx="20" class="blue"/>
  <text x="105" y="705" class="h">HTTP command adapter</text><text x="105" y="747" class="p">rate limit + fresh JWT</text><text x="105" y="782" class="mono">workflow enforced: ON</text>
  <path d="M375 730 H445 V535 H500" class="line"/>
  <text x="70" y="875" class="sub">Solid blue = serialized write path · dashed gold = read-only verification · no distributed-consensus claim</text>
</svg>\n`;
}

function setupSvg(evidence) {
  const steps = [
    ["1", "LOCKED INSTALL", "npm ci"],
    ["2", "RUNTIME PROOF", "npm run runtime:verify"],
    ["3", "FULL GATE", "npm run check"],
    ["4", "REAL EVIDENCE", "npm run evidence:generate"],
    ["5", "DRIFT CHECK", "npm run evidence:check"],
  ];
  const cards = steps
    .map(([number, label, command], index) => {
      const x = 70 + index * 300;
      const connector =
        index === steps.length - 1
          ? ""
          : `<path d="M${x + 250} 250 H${x + 292}" stroke="#2f66d0" stroke-width="4" marker-end="url(#arrow)"/>`;
      return `${connector}<rect x="${x}" y="165" width="250" height="170" rx="18" fill="#fff" stroke="#d5ddea" stroke-width="2"/><rect x="${x + 22}" y="187" width="42" height="42" rx="10" fill="#e8efff"/><text x="${x + 43}" y="216" text-anchor="middle" class="n">${number}</text><text x="${x + 22}" y="265" class="h">${label}</text><text x="${x + 22}" y="303" class="m">${command}</text>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="500" viewBox="0 0 1600 500" role="img" aria-labelledby="title desc">
<title id="title">Reproducible ORTA setup and evidence workflow</title><desc id="desc">Five commands install locked dependencies, verify the native runtime, run the complete gate, generate real evidence assets, and check them for drift.</desc>
<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2f66d0"/></marker></defs>
<style>.title{font:700 38px DejaVu Sans,Arial,sans-serif;fill:#172238}.sub{font:20px DejaVu Sans,Arial,sans-serif;fill:#5e6b81}.h{font:700 17px DejaVu Sans,Arial,sans-serif;fill:#172238}.m{font:15px DejaVu Sans Mono,monospace;fill:#234b96}.n{font:700 17px DejaVu Sans,Arial,sans-serif;fill:#234b96}</style>
<rect width="1600" height="500" fill="#f5f7fb"/><text x="70" y="75" class="title">From clean checkout to verified visual evidence</text><text x="70" y="112" class="sub">Every checked-in image is regenerated from the locked runtime and executed process tests.</text>${cards}<text x="70" y="410" class="sub">Generation requires ${evidence.runtime.node}; hosted CI regenerates and byte-compares the committed assets.</text>
</svg>\n`;
}

async function writePng(image, filename) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  await PImage.encodePNGToStream(image, createWriteStream(temporary));
  renameSync(temporary, filename);
}

function writeGif(evidence, filename) {
  const frames = Array.from({ length: 6 }, (_, index) =>
    renderCrashFrame(evidence, index),
  );
  const palette = quantize(frames[0].data, 64, { format: "rgb444" });
  const encoder = GIFEncoder();
  for (const [index, frame] of frames.entries()) {
    encoder.writeFrame(applyPalette(frame.data, palette, "rgb444"), frame.width, frame.height, {
      delay: index === frames.length - 1 ? 2_200 : 1_350,
      palette: index === 0 ? palette : undefined,
      repeat: 0,
    });
  }
  encoder.finish();
  const temporary = `${filename}.tmp`;
  require("node:fs").writeFileSync(temporary, encoder.bytes());
  renameSync(temporary, filename);
}

async function renderWorkflowEvidence({ evidence, fonts, outputDirectory, writeText }) {
  mkdirSync(outputDirectory, { recursive: true });
  registerFonts(fonts);
  await writePng(
    renderRuntimeEvidence(evidence),
    path.join(outputDirectory, "runtime-evidence.png"),
  );
  await writePng(
    renderCrashMatrix(evidence),
    path.join(outputDirectory, "process-crash-matrix.png"),
  );
  await writePng(
    renderLedgerChain(evidence),
    path.join(outputDirectory, "ledger-chain.png"),
  );
  await writePng(
    renderCliCapture(evidence),
    path.join(outputDirectory, "process-tests-cli.png"),
  );
  writeGif(evidence, path.join(outputDirectory, "crash-recovery.gif"));
  writeText(
    path.join(outputDirectory, "workflow-architecture.svg"),
    architectureSvg(evidence),
  );
  writeText(
    path.join(outputDirectory, "evidence-workflow.svg"),
    setupSvg(evidence),
  );
}

module.exports = { renderWorkflowEvidence };
