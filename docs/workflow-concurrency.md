# Multi-process and crash-recovery evidence

The workflow ledger is exercised through real, independent Node.js processes
against one SQLite WAL file. This layer verifies the behavior promised by the
[event contract](workflow-ledger-contract.md) and
[storage design](workflow-storage.md); it does not replace either proof with a
mock or an in-memory database.

## What is executed

`test/ledger-process.integration.test.js` launches
`test/fixtures/workflow-process-worker.js` with `child_process.fork()`. Each
worker independently loads the pinned native SQLite driver, opens the existing
file, applies the normal connection policy, and constructs its own workflow
store. It never re-runs schema installation or migration.

The parent gives a child only `NODE_ENV=test` and `TZ=UTC`, not the parent's
environment. Requests use a closed operation map and validated fields. A
create request carries a bounded synthetic seed; the child constructs its
reserved-domain contact locally. Receipts return only workflow IDs, versions,
roles, hashes, timestamps, and status. Contact content, database paths, error
messages, stacks, and environment values do not cross IPC.

```text
                         one WAL database
                    ┌────────────────────────┐
                    │ events + projection +  │
                    │ compare-and-swap head  │
                    └───────────┬────────────┘
                                │ BEGIN IMMEDIATE
              ┌─────────────────┴─────────────────┐
              │                                   │
      ┌───────▼────────┐                  ┌───────▼────────┐
      │ Node worker A  │                  │ Node worker B  │
      │ own connection │                  │ own connection │
      └───────┬────────┘                  └───────┬────────┘
              │ fd4 marker / fd5 release          │
              └─────────────────┬─────────────────┘
                                ▼
                         parent verifier
```

## Deterministic contention

The contention scenario uses two long-lived workers and no scheduling sleeps.
The winning writer pauses inside its open transaction at one of the store's
three real checkpoints:

1. after the event insert;
2. after the materialized projection update;
3. after the ledger-head compare-and-swap.

The worker writes one bounded JSON marker to inherited file descriptor 4 and
blocks on a one-byte release from descriptor 5. Only then does the parent run
the competing command. A 25 ms SQLite busy timeout bounds the losing attempt;
the test checks the `ledger_busy` outcome, never elapsed wall-clock time.

The scenario commits two lead creations and then alternates the winner for a
claim, administrator assignment, and sales status transition. At every
operator version, a distinct losing command first observes contention and,
after the winner commits, deterministically observes `version_conflict`.
Finally the verifier proves all of the following in a read-only snapshot:

- exactly five committed events with sequences `1..5`;
- the three losing command IDs are absent;
- each `previous_hash` equals the preceding event hash;
- the singleton head equals event 5;
- two exact projections agree with independent replay;
- `PRAGMA integrity_check` is `ok` and `foreign_key_check` is empty;
- an observer opened during the first uncommitted transaction sees the exact
  empty baseline, never a partial event, lead, or head.

The same command ID is retried from the other process with a different
synthetic contact seed. It replays the first event hash rather than creating a
second lead, demonstrating convergence when a caller repeats a public-create
request after an uncertain first attempt. A direct operational-row assertion
also proves that the retry does not replace the first synthetic contact.

## SIGKILL matrix

The process-crash suite covers every workflow command at every meaningful
boundary:

| command | after event | after projection | after head | after commit, before ACK |
| --- | ---: | ---: | ---: | ---: |
| create | `SIGKILL` | `SIGKILL` | `SIGKILL` | `SIGKILL` |
| claim | `SIGKILL` | `SIGKILL` | `SIGKILL` | `SIGKILL` |
| assign | `SIGKILL` | `SIGKILL` | `SIGKILL` | `SIGKILL` |
| transition | `SIGKILL` | `SIGKILL` | `SIGKILL` | `SIGKILL` |

For the first three columns, the marker is emitted while the SQLite
transaction is still open. The parent sends the operating-system `SIGKILL`
signal and waits for an exit whose signal is exactly `SIGKILL`. Its first
post-crash action is to open the file read-only and run independent replay,
without initialization, migration, repair, or a writable pragma. The complete
snapshot must be field-for-field equivalent at the selected safe fields to its
pre-command baseline, and the target command must be absent.

For the last column, the worker emits its marker only after the store call has
returned—therefore after the SQLite commit—but before sending the IPC result.
The first read-only replay must already contain exactly one target event. This
models a lost acknowledgement: retrying the same command returns
`replayed=true`, the same sequence and event hash, and does not move the head.

Every rolled-back case is then reopened as a normal writer and retried. The
first retry commits exactly one event; the second retry replays that event.
All 16 cases finish with a contiguous chain, the exact expected projection,
successful independent replay, a valid database-page scan, and no foreign-key
violations.

## Reproduce the evidence

Install the locked dependencies and run only the process layer:

```bash
npm ci
node --test test/ledger-process.integration.test.js
```

The focused run contains 17 tests: one multi-process contention scenario and
the 16-cell crash matrix. `npm run check` includes the same file in the full
offline quality gate. The process cases skip explicitly on Windows because
this harness requires POSIX `SIGKILL` semantics and inherited extra file
descriptors; the rest of the suite remains portable.

## Exact claim boundary

This evidence establishes serialization and process-crash recovery for the
pinned Node.js/native-driver/SQLite runtime, on a local filesystem, for one
database file. The tests use `synchronous=FULL`, but they do **not** simulate or
claim durability across power loss, kernel panic, torn sectors, faulty storage
hardware, network filesystems, or a malicious database administrator. SQLite
WAL is also not distributed consensus, multi-primary replication, or an
external integrity anchor.
