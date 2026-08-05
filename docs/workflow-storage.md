# Transactional workflow storage

The workflow storage module turns the byte-level event contract into one local
SQLite write boundary. It is implemented and integration-tested, but disabled
in the default application database opener while the legacy HTTP routes still
use direct SQL. Tests enable it explicitly. This isolation is intentional: the
repository does not claim that a request is audited until route migration and
end-to-end evidence are complete.

## Write API

`createWorkflowStore(database, options)` exposes four commands:

```text
createLead       public origin -> lead.created
claimLead        sales actor   -> lead.claimed
assignLead       admin actor   -> lead.assigned
transitionLead   admin/sales   -> lead.status_changed
```

Operator commands require an opaque command ID, lead ID, expected workflow
version, actor ID, and actor `auth_version`. This is the contract for a future
trusted route adapter; the current JWT and legacy routes do not provide that
binding yet. The caller never chooses an actor role, event payload, aggregate
version, sequence, previous hash, or event hash. Those values are resolved or
derived inside the transaction.

Every successful call returns:

```js
{
  event,               // verified, immutable workflow record
  current_projection,  // projection at response time
  replayed,            // true only for a previously committed command
}
```

Public creation returns only the projection's assigned integer ID, status, and
version. Contact fields are never disclosed through possession of an
idempotency key. Operator-view receipts include the complete current
projection; a trusted adapter must authorize their disclosure. The projection
can be newer than the original event on a late replay, which is why the field
is named `current_projection`.

## Atomic write order

Every mutation runs through a `BEGIN IMMEDIATE` transaction:

1. Look up the command ID before checking the expected version.
2. Verify any stored event; for an operator retry, compare its canonical
   command digest.
3. Resolve the actor's current role and `auth_version` from `users`.
4. Load the active lead and validate the expected projection version.
5. Resolve an assignment target from the same database snapshot and require
   its current role to be `sales`.
6. Verify the current singleton ledger head.
7. Construct the complete event from the before-state.
8. Insert the canonical event while its lead foreign key is transactionally
   deferred.
9. Update the projection with a version compare-and-swap. A SQL trigger proves
   that the pending event's before/after state matches the row change.
10. Advance the head with a second compare-and-swap and commit.

SQLite's write lock begins before actor and projection resolution, closing the
role/version time-of-check-to-time-of-use window for one database file. Event
first ordering removes any application-visible projection bypass token. A
failure at the event, projection, or head stage rolls the entire transaction
back. The integration suite injects a failure at all three boundaries and then
successfully retries the same command ID.

## Idempotency behavior

For operator commands, the command ID and every normalized command field are
hashed together. A retry with the same digest returns the original event with
`replayed=true`; reuse with a different action, actor, expected version, lead,
or target fails as `idempotency_conflict`. The store still re-resolves the
actor's current role and `auth_version` on every retry; claim and transition
replays also recheck current lead access, so revocation or reassignment can
reject an otherwise matching replay. Idempotency lookup happens before stale
version rejection, so an authorized completed retry cannot be mistaken for a
losing race.

Public creation does not accept a caller-chosen lead ID or contact digest. The
store looks up its command ID before allocating the next sequential integer
lead ID, so the API defines that command ID as first-write wins: a later request
with the same ID returns the original creation result and does not apply a
replacement contact body. Sequential lead IDs are neither secret nor
unpredictable. Callers must generate command IDs from 128 bits of
cryptographically secure randomness and must never encode contact content. The
store validates the fixed-width syntax, but it cannot prove caller-side
entropy.

## Storage guards

File databases are opened with:

```text
foreign_keys = ON
busy_timeout = 5000
journal_mode = WAL
synchronous = FULL
```

Startup verifies that a file database actually entered WAL mode. The ledger
uses a `STRICT` event table with unique sequence, hash, command ID, previous
hash, and `(lead_id, version)` constraints. SQL triggers enforce:

- event rows cannot be updated or deleted;
- the next event must reference the current head and use `head.sequence + 1`;
- a lead insert/update must match that pending event's aggregate version,
  before-state, and after-state;
- the head can advance by exactly one only after that matching event exists;
- the singleton head cannot be deleted or replaced.

Startup validates the exact managed table and index definitions, replaces all
managed triggers from source definitions, rejects unexpected triggers on
protected tables, and behaviorally probes required constraints. Matching
column names or SQL comments cannot impersonate the managed schema. Every
application-issued storage and migration table access explicitly targets
SQLite's `main` schema, and persistent workflow triggers are installed there.
Startup and every write transaction also reject a protected TEMP table, view,
or trigger, so connection-local name shadowing cannot divert a projection
write or attach an unreviewed side effect.

These controls catch ordinary application mistakes. A database administrator
can still drop triggers and rewrite the database; independent replay is the
detection boundary for that threat.

## Legacy migration

Schema installation, new columns, legacy imports, and head creation share one
immediate transaction. The migration reads only workflow fields from legacy
leads: integer IDs, status, assignment, workflow version, and the archive
marker. Names and contact content never enter an import event.

Migration fails without partially installing the workflow schema when it sees:

- an unsafe integer ID or nonzero legacy workflow version;
- a null or unknown status;
- an unassigned lead outside `new`;
- an absent or non-sales assignee;
- a non-null legacy `archived_at`, because schema version 1 has no archive event;
- a populated workflow ledger without its trusted schema marker.

Valid leads receive ordered `lead.imported` origins with random command IDs and
a system actor. Reopening the database is idempotent and does not duplicate
events.

## Current boundary

- Replay currently verifies the latest event before each write; full
  snapshot/reducer replay is the next increment.
- Existing HTTP lead routes still use legacy direct SQL, so the default runtime
  does not install or activate the workflow tables and projection guards.
- `archived_at` is reserved for a future event-backed archive workflow. The
  current event vocabulary has no archive action, so deletion must not be
  represented as an unaudited projection-only change.
- SQLite WAL serializes writers for one database file; this is not a
  distributed consensus or multi-primary design.
