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

- Node.js 18 or newer;
- a platform supported by `better-sqlite3` (a native build toolchain may be
  needed when a prebuilt binary is unavailable).

Install the declared dependencies:

```bash
npm install
```

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
without a network call.

## Data and history boundary

The runtime SQLite snapshot formerly tracked by the repository is removed from
the current tip. That deletion does **not** erase prior Git history. Repository
owners should separately review historical data exposure and rotate any
credentials that may ever have been committed. This hygiene change does not
rewrite history and makes no claim that historical objects were purged.

## Known limitations

- There is no production migration strategy, rate limiting, audit trail, or
  encrypted-at-rest storage.
- The AI route is a rule-based placeholder.
- Dependency installation is not yet locked by a committed lockfile.
- API input validation and authorization deserve a dedicated hardening pass
  before any deployment.
