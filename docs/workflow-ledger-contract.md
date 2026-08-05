# Workflow ledger contract v1

The workflow ledger is a local integrity and concurrency boundary for lead
state changes. It is designed to make races and post-hoc mutation visible; it
is not a blockchain, distributed consensus system, digital signature, or
external timestamp authority.

## Canonical bytes

Every command and event is encoded as compact JSON with ASCII-sorted field
names and one trailing newline. The encoder accepts only bounded JSON values:

- `null`, booleans, safe integers other than negative zero, and valid Unicode
  strings without NUL;
- dense arrays and plain data-property objects;
- lowercase ASCII field names from the closed `[a-z][a-z0-9_]*` vocabulary;
- at most 16 nested levels, 2,048 nodes, 512 collection items, and 64 KiB of
  canonical UTF-8.

Floating point values, getters, class instances, sparse arrays, symbols,
cycles, unpaired surrogates, hidden properties, and oversized values fail
closed. SHA-256 identities are domain-separated with an ASCII domain, one NUL
byte, and the canonical newline-terminated document.

## Event envelope

`orta.workflow-event.v1` binds:

- one global sequence and previous event hash;
- one complete normalized command, its opaque idempotency ID, and canonical
  digest;
- the lead ID and aggregate version;
- a closed event type and an exact payload without direct contact content;
- a database-resolved actor ID/role;
- one millisecond-precision UTC timestamp.

The public creation event contains only `status=new` and
`assigned_to=null`. Operator events contain integer identities, statuses, and
before/after assignments. Names, email addresses, phone numbers, messages,
JWTs, passwords, and raw request bodies are not ledger fields.

Command IDs use the opaque fixed-width form `cmd_` plus 32 lowercase
hexadecimal digits. The event contract rejects semantic labels and all command
fields outside the action-specific allowlist. It recomputes the command digest
and cross-checks the command action, lead ID, expected version, actor ID, and
assignment or status target against the normalized event. A caller cannot
supply an independent command digest when creating an event.

An import command additionally binds the initial status, nullable assignment,
and resolved assignment role. An unassigned import must be `new`; an assigned
import records `assigned_role=sales`. This keeps idempotency conflict checks
sensitive to every imported workflow outcome instead of only the lead ID.

The closed transition graph is:

```text
new ──> contacted ──> converted
 │          └───────> rejected
 └──────────────────> rejected
```

`converted` and `rejected` are terminal. Claims require an unassigned `new`
lead. Explicit assignment requires an administrator. A status transition
requires an assigned lead and an authenticated administrator or sales actor.
The storage transaction must additionally prove that every assignment target
currently has the `sales` role; the event records that resolved role as part of
the assignment payload.

## What later storage must guarantee

The SQLite implementation must update the lead projection, append exactly one
event, and advance the singleton ledger head in the same `BEGIN IMMEDIATE`
transaction. Commands use an expected aggregate version and a unique
idempotency key. New IDs must come from a cryptographically secure random
source and must never be derived from contact data; the event contract can
validate their shape but cannot prove their entropy or opacity. Two contenders
for one version cannot both commit.

Replay must independently verify canonical payloads, contiguous global
sequences, every previous hash, every event hash, per-lead versions, state
transitions, and agreement between reconstructed state and the materialized
lead projection.

## Explicit limits

- A database administrator who rewrites the full chain and its head can forge
  a new internally consistent history. External anchoring is out of scope for
  v1.
- Event timestamps describe the injected application clock; they are not
  trusted time attestations.
- SQLite serialization covers one database file. It does not provide a
  multi-region or multi-primary protocol.
- Hashes provide integrity detection, not confidentiality. Direct names and
  contact content are excluded, but access to the operational database still
  requires normal data protection.
- Integer actor and lead IDs are pseudonymous application identifiers, not
  anonymous data. They can still be personal data when joined with operational
  tables.
