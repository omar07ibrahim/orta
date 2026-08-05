# ORTA Study API

ORTA Study API is a small local Express and SQLite prototype for user, lead,
and chat workflows. The chat route currently returns deterministic,
keyword-based responses; it does not call an external AI provider.

This repository is an early backend prototype, not a production service. The
current security boundary is intentionally strict:

- no user is created automatically;
- demo users require an exact opt-in flag and two externally supplied,
  distinct passwords;
- demo identities use reserved `example.com` addresses and no phone numbers;
- `JWT_SECRET` has no fallback and must contain at least 32 non-whitespace
  characters;
- runtime databases, SQLite sidecars, dependencies, and local environment
  files are ignored by Git.

## Local setup

Requirements:

- Node.js 22 or 24;
- a bundled `better-sqlite3` N-API target: Linux (glibc or musl), macOS, or
  Windows on x64 or arm64.

Install the exact locked dependencies:

```bash
npm ci
```

Project npm configuration disables dependency install scripts. The pinned
`better-sqlite3` release includes its reviewed N-API binaries, so supported
platforms do not need a download or native compilation hook during install.
Any future dependency that requires an install script must be reviewed and
enabled deliberately rather than executing implicitly.

Create a local configuration file:

```bash
cp .env.example .env
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Copy the generated value into the ignored `.env` file as `JWT_SECRET`. Do not
commit that value. The default database path in `.env.example` is local and
ignored.

Start the API:

```bash
npm start
```

Startup fails before a database file is opened or the server begins listening
if `JWT_SECRET` is missing or too short. Invalid demo-seed configuration also
fails before a database file is opened.

## Integrity design in progress

The repository now defines and tests the byte-level contract, transactional
SQLite storage, and independent offline replay for an auditable lead workflow:
bounded canonical JSON, domain-separated command and event hashes, closed
envelopes without direct contact content, opaque idempotency IDs,
database-fresh role, auth-version, and assignment-target checks, version
compare-and-swap, guarded append-only history, and complete chain plus
workflow-projection verification. Read the
[event contract](docs/workflow-ledger-contract.md) and
[storage design](docs/workflow-storage.md), then the
[replay design](docs/workflow-replay.md), for the exact guarantees and explicit
non-claims.

The opted-in workflow boundary fails closed on SQLite runtimes affected by the
WAL-reset corruption defect. The pinned driver embeds SQLite 3.53.4; activation
and writer construction independently require a fixed runtime before touching
workflow state.

This boundary is explicitly disabled in the default database opener and is not
wired into the HTTP routes yet. Replay is an operator-invoked, read-only check;
it does not activate the workflow or repair a database. The next increments add
multi-process concurrency tests, route-level authorization, and reproducible
evidence before the API can claim an operational audit trail.

## Explicit synthetic demo users

Demo accounts are off by default. To create the two reserved-domain identities
in a disposable local database, provide both passwords through the process
environment:

```bash
export ORTA_SEED_DEMO_USERS=true
read -rsp 'Synthetic admin password: ' ORTA_DEMO_ADMIN_PASSWORD
export ORTA_DEMO_ADMIN_PASSWORD
read -rsp 'Synthetic sales password: ' ORTA_DEMO_SALES_PASSWORD
export ORTA_DEMO_SALES_PASSWORD
npm start
```

Each password must contain at least 12 non-whitespace characters, and the two
values must be different. Passwords are hashed before insertion and are never
logged. Repeated startup is idempotent: existing synthetic identities are not
overwritten.

## Verification

Run the offline syntax and test suite:

```bash
npm run check
```

Configuration tests use only Node's built-in test runner. Database integration
tests use a fresh directory under the operating system's temporary directory
and remove it afterward. They skip cleanly when the application dependencies
have not yet been installed; after `npm install`, they exercise schema
initialization, opt-in seeding, idempotence, and fail-before-open behavior
without a network call. The workflow contract tests additionally lock canonical
bytes, golden hashes, command/event correlation, actor policy, transition
policy, and hostile JavaScript object rejection.

Storage integration tests additionally exercise WAL/FULL configuration,
idempotent create and operator commands, fresh roles and auth versions, guarded
head/event updates, all-or-nothing legacy migration, and rollback at each write
boundary.

Replay integration tests independently rebuild every aggregate from an idle,
read-only SQLite snapshot, compare workflow projections and ledger anchors,
exercise UTF-8/UTF-16 storage and the legacy timestamp boundary, bound hostile
copied values before driver transfer, and reject chain, event, projection, and
database-integrity corruption without exposing contact content.

## Data and history boundary

The runtime SQLite snapshot formerly tracked by the repository is removed from
the current tip. That deletion does **not** erase prior Git history. Repository
owners should separately review historical data exposure and rotate any
credentials that may ever have been committed. This hygiene change does not
rewrite history and makes no claim that historical objects were purged.

## Known limitations

- HTTP routes do not yet use workflow storage, and there is no rate limiting or
  encrypted-at-rest storage.
- The AI route is a rule-based placeholder.
- API input validation and authorization deserve a dedicated hardening pass
  before any deployment.
