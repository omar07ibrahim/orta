# Reproducible visual evidence

Every image embedded in the root README is generated from executable project
state. The renderers do not download screenshots, call an external AI or chart
service, or substitute hand-written pass/fail values for observed outcomes.

## Generate and verify

Use the exact Node.js 22.23.1 evidence runtime and locked dependency graph:

~~~bash
npm ci
npm run evidence:generate
npm run evidence:check
~~~

Evidence generation now performs four independent steps:

1. executes the 17-test process contention and SIGKILL suite and parses its TAP
   names and outcomes;
2. creates a temporary real SQLite workflow ledger, runs create, claim,
   assignment, and transition commands, then performs independent replay;
3. starts the real Express application on loopback with a fresh SQLite WAL
   database, sends public and authenticated HTTP requests, proves exact replay,
   changed-body conflict, stale-version conflict, stale-token rejection,
   direct-mutation rejection, and the bounded public rate limit;
4. inspects the loaded Node ABI, better-sqlite3, and embedded SQLite versions,
   then renders the checked-in PNG, SVG, and GIF files.

The HTTP capture runs twice in isolated child processes and must produce
identical selected evidence before rendering. It excludes ports, timestamps,
tokens, event hashes, raw request bodies, and rate-window timestamps; those
values are either sensitive or intentionally nondeterministic. The selected
status codes, route names, event types, workflow versions, replay counts, and
failure codes come from actual responses.

Machine sources are docs/assets/workflow-evidence.json and
docs/assets/http-route-evidence.json. SHA-256 and byte counts for every
generated output are in docs/assets/visual-manifest.json.

The check command repeats complete generation in an ignored temporary
directory and byte-compares all twelve committed files. A dedicated hosted job
pins Node.js 22.23.1. Separate Node.js 22.x and 24.x jobs test compatibility
against their latest patches without overwriting evidence explicitly labelled
as a 22.23.1 capture.

## Visual map

| Asset | Question answered | Executed source |
| --- | --- | --- |
| runtime-evidence.png | Which native runtime and proof counts were loaded? | runtime inspection, process suite, replay |
| evidence-workflow.svg | How does a clean checkout regenerate and check evidence? | package scripts and hosted gate |
| workflow-architecture.svg | Where are serialization, storage, and replay boundaries? | workflow store/schema/replay modules |
| ledger-chain.png | What events, versions, actors, hashes, projection, and head were produced? | temporary SQLite workflow execution |
| process-crash-matrix.png | Did every operation survive every process-crash boundary? | 16 observed SIGKILL cases |
| process-tests-cli.png | What did the focused process test command report? | canonicalized executed TAP stream |
| crash-recovery.gif | What is the verified rollback/retry sequence? | animated explanation of one passing matrix path |
| http-command-transcript.png | What did the real HTTP boundary return? | fresh loopback Express and SQLite execution |
| http-command-flow.svg | How do validation, auth freshness, ledger writes, and replay connect? | route source plus captured replay result |
| http-route-evidence.json | Which exact selected route outcomes back the new visuals? | two byte-equivalent isolated captures |

The terminal images deliberately remove nondeterministic durations. Test names,
ordering, summary counts, routes, selected response fields, and outcomes are
parsed from real execution. The GIF is an explanatory animation, not a screen
recording, and is labelled as such.

## Chart contract and QA

The crash matrix is a categorical proof grid: its 16 cells are the complete
operation/boundary matrix, not a sample or magnitude scale. Every cell prints
PASS and a case number, so color is not the only status channel.

The ledger figure represents ordered semantic transitions rather than a time
trend; arrows and displayed hash prefixes encode linkage directly. The HTTP
terminal capture preserves the observed route/status/result sequence while
omitting unstable or sensitive fields. The HTTP flow is a source-and-run-bound
architecture diagram, not a deployment topology claim.

All figures use one blue palette root, a gold focal accent, and neutral ink,
surfaces, and guides. PNGs are inspected at exported resolution, the GIF at its
1200 by 675 frame size, and SVGs include accessible titles and descriptions.
The manifest locks the final files after QA.

## Rendering and privacy boundary

The static renderers use exact dev-only locks for pureimage and gifenc.
Canonical hosted output uses the DejaVu Sans and DejaVu Sans Mono fonts
available on Ubuntu 24.04. ORTA_EVIDENCE_FONT_DIR can point to a directory
containing the three DejaVu files for an offline workstation. Other platform
font fallbacks can generate readable previews, but byte verification requires
the canonical faces.

Synthetic operational rows use reserved example.com identities. Generated JSON
and visuals exclude names, email addresses, phone numbers, messages, passwords,
JWTs, database paths, environment values, ports, raw bodies, and error stacks.
The original workflow evidence retains bounded hashes and integer IDs because
they are the evidence under test; the public HTTP capture intentionally omits
event hashes and contact data.
