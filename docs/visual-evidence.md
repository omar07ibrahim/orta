# Reproducible visual evidence

Every image embedded in the root README is generated from executable project
state. The renderer does not download screenshots, call an external AI or
chart service, or substitute hand-written pass/fail values for test outcomes.

## Generate and verify

Use the exact Node.js 22.23.1 evidence runtime and locked dependency graph:

```bash
npm ci
npm run evidence:generate
npm run evidence:check
```

`evidence:generate` performs three steps:

1. executes the 17-test process contention and `SIGKILL` suite and parses its
   TAP names and outcomes;
2. creates a temporary real SQLite workflow ledger, runs create, claim,
   assignment, and transition commands, then collects PII-free event metadata,
   the projection, head, integrity scan, foreign-key scan, and independent
   replay result;
3. inspects the actually loaded Node ABI, `better-sqlite3`, and embedded SQLite
   versions, then renders the checked-in PNG, SVG, and GIF files.

The JSON source is
[`workflow-evidence.json`](assets/workflow-evidence.json). SHA-256 and byte
counts for every generated output are in
[`visual-manifest.json`](assets/visual-manifest.json).

`evidence:check` repeats the complete generation in an ignored temporary
directory and byte-compares all nine committed files. A dedicated hosted job
pins Node.js 22.23.1 for this drift check. Separate floating Node.js 22.x and
24.x jobs still test compatibility against their latest patches without
overwriting evidence explicitly labelled as a 22.23.1 capture. Upgrading the
evidence runtime is therefore an intentional code, CI, and asset change rather
than an unexplained image diff.

## Visual map

| Asset | Question answered | Executed source |
| --- | --- | --- |
| `runtime-evidence.png` | Which native runtime and proof counts were loaded? | runtime inspection, process suite, replay |
| `evidence-workflow.svg` | How does a clean checkout regenerate and check evidence? | `package.json` scripts and hosted gate |
| `workflow-architecture.svg` | Where are serialization, storage, replay, and the disabled route boundary? | workflow store/schema/replay modules |
| `ledger-chain.png` | What exact events, versions, actors, hashes, projection, and head were produced? | temporary SQLite workflow execution |
| `process-crash-matrix.png` | Did every operation survive every process-crash boundary? | 16 observed `SIGKILL` cases |
| `process-tests-cli.png` | What did the focused process test command report? | canonicalized executed TAP stream |
| `crash-recovery.gif` | What is the verified rollback/retry sequence? | animated explanation of one passing matrix path |

The terminal image deliberately removes nondeterministic durations; test names,
ordering, summary counts, and outcomes are parsed from the real TAP stream. The
GIF is an explanatory animation, not a screen recording, and is labelled as
such in the image itself.

## Chart contract and QA

The crash matrix asks whether every command/boundary combination recovered to
one atomic outcome. Its 16 cells are the complete intended matrix, not a sample
or a magnitude scale. A categorical grid is therefore more honest than bars or
a continuous heatmap. Every cell prints `PASS` and a case number, so color is
not the only status channel.

The ledger figure asks whether one ordered workflow produced a contiguous
event chain and the exact final projection. Its four points are semantic state
transitions, not a time trend; arrows and displayed hash prefixes encode the
linkage directly. Exact values remain available in the adjacent JSON for
lookup.

All figures use one blue palette root, a gold focal accent, and neutral ink,
surfaces, and guides. Titles are descriptive rather than claim-led. PNGs were
inspected at their exported resolution, the GIF at its 1200×675 frame size, and
SVGs include accessible titles and descriptions. The manifest locks the final
files after that QA pass.

## Rendering boundary

The static renderer uses exact dev-only locks for `pureimage` and `gifenc`.
Canonical hosted output uses the DejaVu Sans and DejaVu Sans Mono fonts
available on Ubuntu 24.04. `ORTA_EVIDENCE_FONT_DIR` can point to a directory
containing those three DejaVu files for an offline workstation. Other platform
font fallbacks can generate readable previews, but byte-for-byte verification
requires the canonical DejaVu faces.

Synthetic operational rows use reserved `example.com` identities. Generated
JSON and visuals exclude names, email addresses, phone numbers, messages,
passwords, tokens, database paths, environment values, error stacks, and raw
request bodies. Hashes and integer workflow IDs remain visible because they are
the evidence being verified.
