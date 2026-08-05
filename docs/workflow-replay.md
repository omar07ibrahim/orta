# Independent workflow replay

The replay verifier is an offline, operator-facing integrity check for the
workflow ledger and its current lead projections. It is independent from the
write store and legacy HTTP routes: it reconstructs workflow state from the
stored events, compares that state with the database, and returns a compact
summary. It does not serve requests, authorize users, or make the default
workflow ledger active.

## Read-only API

`workflow/ledger-replay.js` exports:

```js
const {
  WorkflowReplayError,
  replayWorkflowLedger,
} = require("./workflow/ledger-replay");
```

`replayWorkflowLedger(database)` requires an idle `better-sqlite3` connection.
It executes the complete check in one read-only transaction, so every table,
event, projection, and ledger-head read belongs to the same SQLite snapshot.
It rejects a connection that is already inside a transaction instead of
silently inheriting a caller-owned snapshot.

The connection must retain SQLite's native one-argument `typeof` and `length`
functions. Replay rejects connection-local one-argument or variadic overrides
of either function before any integrity or bounded-value read; otherwise an
override could falsify storage-class checks, managed constraints, or transfer
limits. Unrelated overloads with a different fixed arity are permitted. Replay
also fails closed when `PRAGMA ignore_check_constraints` is enabled, because
SQLite's own integrity pass would otherwise omit managed `CHECK` constraints.
It likewise rejects `PRAGMA writable_schema`, which can make SQLite ignore
malformed schema records during parsing and integrity checks. With that flag
disabled, replay issues SQLite's documented
[`writable_schema=RESET`](https://www.sqlite.org/pragma.html#pragma_writable_schema)
to invalidate the connection's parsed-schema cache before discovery; this is a
connection-local reparse, not a database-file write, and exposes earlier
hidden `sqlite_master` tampering.

Replay supports SQLite's three native database encodings: UTF-8, UTF-16LE, and
UTF-16BE. Stored event text is read through a native-encoding byte cap and a
fatal decoder. The decoded document must then re-encode to the exact canonical
UTF-8 event bytes used by the hash contract. This keeps one event identity
across database encodings without materializing unbounded copied values.

For an operator check, open the existing file without write access:

```js
const Database = require("better-sqlite3");
const { replayWorkflowLedger } = require("./workflow/ledger-replay");

const database = new Database("path/to/orta-study.db", {
  fileMustExist: true,
  readonly: true,
});

try {
  console.log(replayWorkflowLedger(database));
} finally {
  database.close();
}
```

The verifier issues no schema installation, migration, repair, event append,
projection update, or activation statement. A database without the opted-in
workflow schema fails with `workflow_not_enabled`; replay never creates the
missing objects.

## Verification pass

Within the snapshot, replay:

1. requires ordinary main-schema tables and stored (not generated) columns
   using [`table_xinfo`](https://www.sqlite.org/pragma.html#pragma_table_xinfo),
   bounds schema metadata, then checks SQLite integrity, declared foreign keys,
   and exactly one integer user identity for each current lead assignee;
2. validates the workflow schema marker and singleton ledger head;
3. scans events in global sequence order;
4. validates each stored row, canonical event contract, command and event
   hashes, duplicated identities, contiguous sequence, and previous-hash link;
5. independently reduces each lead aggregate, requiring an origin at version
   zero, contiguous aggregate versions, and valid claim, assignment, and status
   transitions;
6. scans lead projections once and compares workflow state, version, archive
   marker, and the event-backed timestamp fields with the reduced state; and
7. proves that the event count and final hash agree with the stored ledger
   head.

With the managed primary keys and indexes, the ledger reduction and projection
reconciliation take `O(events + leads)` time. SQLite's preceding integrity and
foreign-key checks additionally scan the applicable database pages and tables.
A copied schema with removed keys or indexes is still checked semantically,
but SQLite may need an additional sort for ordered scans. Replay keeps only
validation sets and the latest reduced state for each aggregate; it does not
perform a query per event or per lead. Workflow row text and would-be integer
fields are type-checked or byte-capped in SQLite before crossing into the Node
process. Schema names and definitions are capped before SQLite's native,
single-result integrity and foreign-key diagnostics are read.

## Legacy timestamp boundary

A native `lead.created` origin binds both `created_at` and `updated_at` to the
origin event's `occurred_at`. Every later workflow event binds `updated_at` to
that aggregate's latest event timestamp.

A `lead.imported` origin deliberately does not claim knowledge of the legacy
row's earlier timestamps. Its `created_at` remains outside schema version 1
permanently, and its `updated_at` is unbound while import is the aggregate's
only event. After the first post-import workflow event, `updated_at` becomes
event-backed and must equal the latest event's `occurred_at`. Replay still
requires every projection's `archived_at` to be null because version 1 has no
archive event.

Names, email addresses, phone numbers, messages, and legacy creation timestamps
are not copied into events and are not reconstructed by replay.

## Result and failures

Success returns this exact deep-frozen, PII-free shape:

```js
{
  aggregate_count,
  event_count,
  head: {
    event_hash,
    sequence,
  },
  schema_version,
}
```

The summary contains counts and ledger anchors only. It never includes lead
names, contact fields, messages, user records, or raw event JSON.

Failures throw `WorkflowReplayError`. Its `code` is one of this closed
vocabulary:

```text
replay_requires_idle_connection
workflow_not_enabled
database_integrity_failed
foreign_key_violation
invalid_schema_marker
invalid_ledger_head
event_storage_invalid
event_contract_invalid
event_column_mismatch
global_sequence_mismatch
previous_hash_mismatch
duplicate_command_id
duplicate_event_hash
aggregate_version_mismatch
state_transition_mismatch
projection_mismatch
ledger_head_mismatch
```

Error details are restricted to safe structural coordinates such as a
sequence, aggregate ID, field, or reason. They do not echo raw rows, event JSON,
or contact content.

## Threat model and non-claims

Replay detects a broken chain, invalid event contract, inconsistent projection,
bad head, missing or invalid required workflow tables or marker, and many forms
of accidental or partial database tampering. It is a deterministic integrity
check of one SQLite snapshot, not a signature or an external trust anchor.

In particular, replay does not:

- repair, migrate, activate, or write to the checked database;
- validate the exact managed trigger or index definitions; opted-in startup
  owns that schema-definition check, while replay validates stored semantics;
- make the legacy HTTP routes audited or bind the current JWT to
  `auth_version`;
- prove historical actor roles or assignment-target roles from the mutable
  current `users` table;
- authenticate a complete rewrite by an attacker who can recompute every
  unsigned hash, projection, and the local head;
- verify contact fields that the privacy-preserving event format intentionally
  excludes;
- prove multi-process race behavior, durability outside SQLite's guarantees,
  distributed consensus, backup authenticity, or the identity of the database
  file supplied by the operator.

The operator must trust the verifier code and independently protect or publish
an external signed checkpoint if detection of a fully recomputed history is
required.
