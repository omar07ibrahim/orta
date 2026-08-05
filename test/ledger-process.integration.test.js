"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Database = require("better-sqlite3");

const { configureDatabase, openDatabase } = require("../database-core");
const { ZERO_HASH } = require("../workflow/ledger-contract");
const { replayWorkflowLedger } = require("../workflow/ledger-replay");
const { createWorkflowStore } = require("../workflow/ledger-store");

const WORKER_PATH = path.join(
  __dirname,
  "fixtures",
  "workflow-process-worker.js",
);
const CHILD_ENVIRONMENT = Object.freeze({ NODE_ENV: "test", TZ: "UTC" });
const WATCHDOG_MS = 15_000;
const MAX_STDERR_BYTES = 8_192;
const PROCESS_TEST_SKIP =
  process.platform === "win32"
    ? "requires POSIX SIGKILL and inherited file descriptors"
    : false;

const USERS = Object.freeze({
  admin: 101,
  salesA: 201,
  salesB: 202,
  salesC: 203,
});

function commandId(index) {
  return `cmd_${index.toString(16).padStart(32, "0")}`;
}

function withWatchdog(promise, label) {
  let watchdog;
  const timeout = new Promise((resolve, reject) => {
    watchdog = setTimeout(
      () => reject(new Error(`watchdog_timeout:${label}`)),
      WATCHDOG_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(watchdog));
}

function workerError(envelope) {
  const error = new Error(envelope.error.code);
  error.name = envelope.error.name;
  error.code = envelope.error.code;
  return error;
}

class WorkflowProcessWorker {
  constructor(filename, label) {
    this.label = label;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.markers = [];
    this.markerWaiters = [];
    this.stderr = "";
    this.exited = null;
    this.shutdownAcknowledged = null;

    this.child = fork(WORKER_PATH, [filename], {
      env: CHILD_ENVIRONMENT,
      execPath: process.execPath,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc", "pipe", "pipe"],
    });

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exit = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < MAX_STDERR_BYTES) {
        this.stderr = `${this.stderr}${chunk}`.slice(0, MAX_STDERR_BYTES);
      }
    });
    this.child.stdio[4].setEncoding("utf8");
    let markerBuffer = "";
    this.child.stdio[4].on("data", (chunk) => {
      markerBuffer += chunk;
      let newline = markerBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = markerBuffer.slice(0, newline);
        markerBuffer = markerBuffer.slice(newline + 1);
        try {
          this.deliverMarker(JSON.parse(line));
        } catch (error) {
          this.failMarkerWaiters(error);
        }
        newline = markerBuffer.indexOf("\n");
      }
    });
    this.child.on("message", (message) => this.handleMessage(message));
    this.child.once("error", (error) => {
      this.rejectReady(error);
      this.rejectPending(error);
      this.failMarkerWaiters(error);
    });
    this.child.once("exit", (code, signal) => {
      this.exited = { code, signal };
      const error = new Error(
        `worker_exited:${this.label}:${code ?? "null"}:${signal ?? "null"}`,
      );
      error.code = "worker_exited";
      this.rejectReady(error);
      this.rejectPending(error);
      this.failMarkerWaiters(error);
      this.resolveExit(this.exited);
    });
  }

  handleMessage(message) {
    if (message?.type === "ready") {
      this.resolveReady();
      return;
    }
    if (message?.type === "shutdown") {
      if (this.shutdownAcknowledged) {
        this.shutdownAcknowledged();
      }
      return;
    }
    if (
      (message?.type === "result" || message?.type === "error") &&
      this.pending.has(message.requestId)
    ) {
      const pending = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      if (message.type === "result") {
        pending.resolve(message.result);
      } else {
        pending.reject(workerError(message));
      }
      return;
    }
    if (message?.type === "error" && message.requestId === null) {
      this.rejectReady(workerError(message));
    }
  }

  deliverMarker(marker) {
    const waiter = this.markerWaiters.shift();
    if (waiter) {
      waiter.resolve(marker);
    } else {
      this.markers.push(marker);
    }
  }

  failMarkerWaiters(error) {
    for (const waiter of this.markerWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async waitUntilReady() {
    await withWatchdog(this.ready, `${this.label}:ready`);
  }

  execute(request) {
    assert.equal(this.exited, null, `${this.label} already exited`);
    assert.equal(this.pending.size, 0, `${this.label} already has a request`);
    const requestId = `${this.label}:${this.nextRequestId}`;
    this.nextRequestId += 1;

    const response = new Promise((resolve, reject) => {
      this.pending.set(requestId, { reject, resolve });
      this.child.send(
        { ...request, requestId, type: "execute" },
        (error) => {
          if (error && this.pending.has(requestId)) {
            this.pending.delete(requestId);
            reject(error);
          }
        },
      );
    });
    return withWatchdog(response, `${this.label}:${requestId}`);
  }

  nextMarker() {
    if (this.markers.length > 0) {
      return Promise.resolve(this.markers.shift());
    }
    const marker = new Promise((resolve, reject) => {
      this.markerWaiters.push({ reject, resolve });
    });
    return withWatchdog(marker, `${this.label}:marker`);
  }

  release() {
    assert.equal(this.exited, null, `${this.label} already exited`);
    this.child.stdio[5].write(Buffer.from([1]));
  }

  async kill() {
    if (this.exited === null) {
      assert.equal(this.child.kill("SIGKILL"), true);
    }
    return withWatchdog(this.exit, `${this.label}:SIGKILL`);
  }

  async close() {
    if (this.exited !== null) {
      return this.exited;
    }
    const acknowledged = new Promise((resolve) => {
      this.shutdownAcknowledged = resolve;
    });
    this.child.send({ type: "shutdown" });
    await withWatchdog(acknowledged, `${this.label}:shutdown-ack`);
    return withWatchdog(this.exit, `${this.label}:shutdown-exit`);
  }

  async terminate() {
    if (this.exited === null) {
      this.child.kill("SIGKILL");
    }
    return withWatchdog(this.exit, `${this.label}:cleanup`);
  }
}

function insertSyntheticUsers(database) {
  const insert = database.prepare(`
    INSERT INTO main.users (id, email, password, role, name, phone)
    VALUES (?, ?, 'unused-process-test-hash', ?, ?, NULL)
  `);
  const rows = [
    [USERS.admin, "admin-process@example.com", "admin", "Synthetic Admin"],
    [USERS.salesA, "sales-a-process@example.com", "sales", "Synthetic Sales A"],
    [USERS.salesB, "sales-b-process@example.com", "sales", "Synthetic Sales B"],
    [USERS.salesC, "sales-c-process@example.com", "sales", "Synthetic Sales C"],
  ];
  database.transaction(() => {
    for (const row of rows) {
      insert.run(...row);
    }
  })();
}

function syntheticContact(suffix = "baseline") {
  return {
    email: `${suffix}@example.com`,
    message: `Synthetic process fixture ${suffix}.`,
    name: `Synthetic Process Fixture ${suffix}`,
    phone: "+1-555-0100",
  };
}

function workerSyntheticContact(commandIdentifier, syntheticSeed) {
  const suffix = commandIdentifier.slice(-12);
  return {
    email: `process-${syntheticSeed}-${suffix}@example.com`,
    message: `Synthetic child-process integration fixture ${syntheticSeed}.`,
    name: `Synthetic Process Candidate ${syntheticSeed}-${suffix}`,
    phone: "+1-555-0100",
  };
}

function createProcessDatabase(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  const filename = path.join(directory, "workflow.sqlite");
  const database = openDatabase({
    enableWorkflowLedger: true,
    environment: { ORTA_SEED_DEMO_USERS: "false" },
    filename,
  });
  insertSyntheticUsers(database);
  return { database, directory, filename };
}

function checkpointAndClose(database) {
  database.pragma("wal_checkpoint(TRUNCATE)");
  database.close();
}

function openDirectWriter(filename, timestamp) {
  const database = new Database(filename, { fileMustExist: true });
  configureDatabase(database);
  const store = createWorkflowStore(database, {
    clock: () => new Date(timestamp),
  });
  return { database, store };
}

function executeDirect(store, operation, input) {
  const methods = {
    assign: store.assignLead,
    claim: store.claimLead,
    create: store.createLead,
    transition: store.transitionLead,
  };
  if (operation === "create" && !Object.hasOwn(input, "contact")) {
    return methods.create({
      commandId: input.commandId,
      contact: syntheticContact(`retry-${input.syntheticSeed}`),
    });
  }
  return methods[operation](input);
}

function safeSnapshot(database) {
  return {
    events: database
      .prepare(`
        SELECT
          sequence, event_hash, previous_hash, command_id, command_digest,
          event_type, aggregate_id, aggregate_version, actor_id, actor_role,
          occurred_at
        FROM main.workflow_events
        ORDER BY sequence
      `)
      .all(),
    foreign_key_check: database.pragma("foreign_key_check"),
    head: database
      .prepare(`
        SELECT sequence, event_hash
        FROM main.workflow_ledger_head
        WHERE singleton = 1
      `)
      .get(),
    integrity_check: database.pragma("integrity_check"),
    projections: database
      .prepare(`
        SELECT
          id, status, assigned_to, workflow_version, archived_at,
          created_at, updated_at
        FROM main.leads
        ORDER BY id
      `)
      .all(),
    replay: replayWorkflowLedger(database),
  };
}

function readOnlySnapshot(filename) {
  const database = new Database(filename, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    return safeSnapshot(database);
  } finally {
    database.close();
  }
}

function readOperationalContact(filename, leadId) {
  const database = new Database(filename, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    return database
      .prepare(`
        SELECT name, email, phone, message
        FROM main.leads
        WHERE id = ?
      `)
      .get(leadId);
  } finally {
    database.close();
  }
}

function targetCommandCount(snapshot, targetCommandId) {
  return snapshot.events.filter(
    (event) => event.command_id === targetCommandId,
  ).length;
}

function assertHealthySnapshot(snapshot) {
  assert.deepEqual(snapshot.integrity_check, [{ integrity_check: "ok" }]);
  assert.deepEqual(snapshot.foreign_key_check, []);
  assert.equal(snapshot.replay.event_count, snapshot.events.length);
  assert.equal(snapshot.head.sequence, snapshot.events.length);
  assert.deepEqual(snapshot.replay.head, snapshot.head);
  for (const [index, event] of snapshot.events.entries()) {
    assert.equal(event.sequence, index + 1);
    assert.equal(
      event.previous_hash,
      index === 0 ? ZERO_HASH : snapshot.events[index - 1].event_hash,
    );
  }
  assert.equal(
    snapshot.head.event_hash,
    snapshot.events.at(-1)?.event_hash ?? ZERO_HASH,
  );
}

function request(operation, input, now, options = {}) {
  return {
    busyTimeoutMs: options.busyTimeoutMs ?? 25,
    input,
    now,
    operation,
    ...(options.pauseAt ? { pauseAt: options.pauseAt } : {}),
    ...(options.pauseAfterCommit ? { pauseAfterCommit: true } : {}),
  };
}

function assertWorkerError(code) {
  return (error) => error?.code === code;
}

test(
  "two processes serialize every workflow command and converge after contention",
  { concurrency: false, skip: PROCESS_TEST_SKIP, timeout: 45_000 },
  async (context) => {
    const fixture = createProcessDatabase("orta-ledger-contention-");
    checkpointAndClose(fixture.database);
    const workerA = new WorkflowProcessWorker(fixture.filename, "worker-a");
    const workerB = new WorkflowProcessWorker(fixture.filename, "worker-b");
    context.after(async () => {
      await Promise.all([workerA.terminate(), workerB.terminate()]);
      rmSync(fixture.directory, { force: true, recursive: true });
    });
    await workerA.waitUntilReady();
    await workerB.waitUntilReady();

    const createOne = commandId(0x1001);
    const createTwo = commandId(0x1002);
    const winningClaim = commandId(0x1003);
    const losingClaim = commandId(0x2003);
    const winningAssignment = commandId(0x1004);
    const losingAssignment = commandId(0x2004);
    const winningTransition = commandId(0x1005);
    const losingTransition = commandId(0x2005);
    const ipcEvidence = [];

    const firstCreatePromise = workerA.execute(
      request(
        "create",
        { commandId: createOne, syntheticSeed: 1 },
        "2026-08-05T10:00:00.000Z",
        { pauseAt: "after_head_update" },
      ),
    );
    firstCreatePromise.catch(() => {});
    const createMarker = await workerA.nextMarker();
    assert.deepEqual(createMarker, {
      action: "lead.create",
      lead_id: 1,
      operation: "create",
      request_id: "worker-a:1",
      sequence: 1,
      stage: "after_head_update",
      type: "paused",
    });

    const invisible = readOnlySnapshot(fixture.filename);
    assert.deepEqual(invisible.replay, {
      aggregate_count: 0,
      event_count: 0,
      head: { event_hash: ZERO_HASH, sequence: 0 },
      schema_version: 1,
    });
    assert.deepEqual(invisible.projections, []);
    assertHealthySnapshot(invisible);

    await assert.rejects(
      workerB.execute(
        request(
          "create",
          { commandId: createOne, syntheticSeed: 2 },
          "2026-08-05T10:00:00.000Z",
        ),
      ),
      assertWorkerError("ledger_busy"),
    );
    await assert.rejects(
      workerB.execute(
        request(
          "create",
          { commandId: createTwo, syntheticSeed: 2 },
          "2026-08-05T10:00:01.000Z",
        ),
      ),
      assertWorkerError("ledger_busy"),
    );

    workerA.release();
    const firstCreate = await firstCreatePromise;
    ipcEvidence.push(firstCreate, createMarker);
    assert.equal(firstCreate.replayed, false);
    assert.equal(firstCreate.event.sequence, 1);

    const createReplay = await workerB.execute(
      request(
        "create",
        { commandId: createOne, syntheticSeed: 2 },
        "2026-08-05T10:00:00.000Z",
      ),
    );
    ipcEvidence.push(createReplay);
    assert.equal(createReplay.replayed, true);
    assert.equal(createReplay.event.event_hash, firstCreate.event.event_hash);

    const secondCreate = await workerB.execute(
      request(
        "create",
        { commandId: createTwo, syntheticSeed: 2 },
        "2026-08-05T10:00:01.000Z",
      ),
    );
    ipcEvidence.push(secondCreate);
    assert.equal(secondCreate.replayed, false);
    assert.equal(secondCreate.event.sequence, 2);

    const claimInput = {
      actorAuthVersion: 1,
      actorId: USERS.salesA,
      commandId: winningClaim,
      expectedVersion: 0,
      leadId: 1,
    };
    const claimPromise = workerB.execute(
      request("claim", claimInput, "2026-08-05T10:00:02.000Z", {
        pauseAt: "after_event_insert",
      }),
    );
    claimPromise.catch(() => {});
    const claimMarker = await workerB.nextMarker();
    assert.equal(claimMarker.action, "lead.claim");
    assert.equal(claimMarker.lead_id, 1);
    assert.equal(claimMarker.sequence, 3);
    assert.equal(claimMarker.stage, "after_event_insert");
    await assert.rejects(
      workerA.execute(
        request(
          "claim",
          { ...claimInput, actorId: USERS.salesB, commandId: losingClaim },
          "2026-08-05T10:00:02.500Z",
        ),
      ),
      assertWorkerError("ledger_busy"),
    );
    workerB.release();
    const claimed = await claimPromise;
    ipcEvidence.push(claimed, claimMarker);
    assert.equal(claimed.event.sequence, 3);
    await assert.rejects(
      workerA.execute(
        request(
          "claim",
          { ...claimInput, actorId: USERS.salesB, commandId: losingClaim },
          "2026-08-05T10:00:02.500Z",
        ),
      ),
      assertWorkerError("version_conflict"),
    );

    const assignmentInput = {
      actorAuthVersion: 1,
      actorId: USERS.admin,
      commandId: winningAssignment,
      expectedVersion: 1,
      leadId: 1,
      toAssignedTo: USERS.salesB,
    };
    const assignmentPromise = workerA.execute(
      request("assign", assignmentInput, "2026-08-05T10:00:03.000Z", {
        pauseAt: "after_projection_update",
      }),
    );
    assignmentPromise.catch(() => {});
    const assignmentMarker = await workerA.nextMarker();
    assert.equal(assignmentMarker.action, "lead.assign");
    assert.equal(assignmentMarker.lead_id, 1);
    assert.equal(assignmentMarker.sequence, 4);
    assert.equal(assignmentMarker.stage, "after_projection_update");
    await assert.rejects(
      workerB.execute(
        request(
          "assign",
          {
            ...assignmentInput,
            commandId: losingAssignment,
            toAssignedTo: USERS.salesC,
          },
          "2026-08-05T10:00:03.500Z",
        ),
      ),
      assertWorkerError("ledger_busy"),
    );
    workerA.release();
    const assigned = await assignmentPromise;
    ipcEvidence.push(assigned, assignmentMarker);
    assert.equal(assigned.event.sequence, 4);
    await assert.rejects(
      workerB.execute(
        request(
          "assign",
          {
            ...assignmentInput,
            commandId: losingAssignment,
            toAssignedTo: USERS.salesC,
          },
          "2026-08-05T10:00:03.500Z",
        ),
      ),
      assertWorkerError("version_conflict"),
    );

    const transitionInput = {
      actorAuthVersion: 1,
      actorId: USERS.salesB,
      commandId: winningTransition,
      expectedVersion: 2,
      leadId: 1,
      toStatus: "contacted",
    };
    const transitionPromise = workerB.execute(
      request(
        "transition",
        transitionInput,
        "2026-08-05T10:00:04.000Z",
        { pauseAt: "after_head_update" },
      ),
    );
    transitionPromise.catch(() => {});
    const transitionMarker = await workerB.nextMarker();
    assert.equal(transitionMarker.action, "lead.transition");
    assert.equal(transitionMarker.lead_id, 1);
    assert.equal(transitionMarker.sequence, 5);
    assert.equal(transitionMarker.stage, "after_head_update");
    await assert.rejects(
      workerA.execute(
        request(
          "transition",
          {
            ...transitionInput,
            actorId: USERS.admin,
            commandId: losingTransition,
            toStatus: "rejected",
          },
          "2026-08-05T10:00:04.500Z",
        ),
      ),
      assertWorkerError("ledger_busy"),
    );
    workerB.release();
    const transitioned = await transitionPromise;
    ipcEvidence.push(transitioned, transitionMarker);
    assert.equal(transitioned.event.sequence, 5);
    await assert.rejects(
      workerA.execute(
        request(
          "transition",
          {
            ...transitionInput,
            actorId: USERS.admin,
            commandId: losingTransition,
            toStatus: "rejected",
          },
          "2026-08-05T10:00:04.500Z",
        ),
      ),
      assertWorkerError("version_conflict"),
    );

    const finalSnapshot = readOnlySnapshot(fixture.filename);
    assertHealthySnapshot(finalSnapshot);
    assert.deepEqual(
      finalSnapshot.events.map((event) => ({
        actor_id: event.actor_id,
        actor_role: event.actor_role,
        aggregate_id: event.aggregate_id,
        aggregate_version: event.aggregate_version,
        command_id: event.command_id,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        sequence: event.sequence,
      })),
      [
        {
          actor_id: null,
          actor_role: "public",
          aggregate_id: 1,
          aggregate_version: 0,
          command_id: createOne,
          event_type: "lead.created",
          occurred_at: "2026-08-05T10:00:00.000Z",
          sequence: 1,
        },
        {
          actor_id: null,
          actor_role: "public",
          aggregate_id: 2,
          aggregate_version: 0,
          command_id: createTwo,
          event_type: "lead.created",
          occurred_at: "2026-08-05T10:00:01.000Z",
          sequence: 2,
        },
        {
          actor_id: USERS.salesA,
          actor_role: "sales",
          aggregate_id: 1,
          aggregate_version: 1,
          command_id: winningClaim,
          event_type: "lead.claimed",
          occurred_at: "2026-08-05T10:00:02.000Z",
          sequence: 3,
        },
        {
          actor_id: USERS.admin,
          actor_role: "admin",
          aggregate_id: 1,
          aggregate_version: 2,
          command_id: winningAssignment,
          event_type: "lead.assigned",
          occurred_at: "2026-08-05T10:00:03.000Z",
          sequence: 4,
        },
        {
          actor_id: USERS.salesB,
          actor_role: "sales",
          aggregate_id: 1,
          aggregate_version: 3,
          command_id: winningTransition,
          event_type: "lead.status_changed",
          occurred_at: "2026-08-05T10:00:04.000Z",
          sequence: 5,
        },
      ],
    );
    assert.deepEqual(finalSnapshot.projections, [
      {
        archived_at: null,
        assigned_to: USERS.salesB,
        created_at: "2026-08-05T10:00:00.000Z",
        id: 1,
        status: "contacted",
        updated_at: "2026-08-05T10:00:04.000Z",
        workflow_version: 3,
      },
      {
        archived_at: null,
        assigned_to: null,
        created_at: "2026-08-05T10:00:01.000Z",
        id: 2,
        status: "new",
        updated_at: "2026-08-05T10:00:01.000Z",
        workflow_version: 0,
      },
    ]);
    assert.deepEqual(finalSnapshot.replay, {
      aggregate_count: 2,
      event_count: 5,
      head: finalSnapshot.head,
      schema_version: 1,
    });
    assert.deepEqual(
      readOperationalContact(fixture.filename, 1),
      workerSyntheticContact(createOne, 1),
      "a retry with a different seed must not replace the winning contact",
    );
    assert.deepEqual(
      finalSnapshot.events
        .filter((event) =>
          [losingClaim, losingAssignment, losingTransition].includes(
            event.command_id,
          ),
        )
        .map((event) => event.command_id),
      [],
    );
    assert.equal(
      /example\.com|Synthetic Process|\+1-555/u.test(
        JSON.stringify(ipcEvidence),
      ),
      false,
      "IPC evidence must not expose the synthetic contact",
    );

    assert.deepEqual(await workerA.close(), { code: 0, signal: null });
    assert.deepEqual(await workerB.close(), { code: 0, signal: null });
    assert.equal(workerA.stderr, "");
    assert.equal(workerB.stderr, "");
  },
);

const CRASH_CASES = Object.freeze({
  create: {
    baselineSteps: [],
    input: { commandId: commandId(0x9101), syntheticSeed: 11 },
    targetCommandId: commandId(0x9101),
    targetTimestamp: "2026-08-05T12:00:00.000Z",
  },
  claim: {
    baselineSteps: ["create"],
    input: {
      actorAuthVersion: 1,
      actorId: USERS.salesA,
      commandId: commandId(0x9102),
      expectedVersion: 0,
      leadId: 1,
    },
    targetCommandId: commandId(0x9102),
    targetTimestamp: "2026-08-05T12:00:01.000Z",
  },
  assign: {
    baselineSteps: ["create", "claim"],
    input: {
      actorAuthVersion: 1,
      actorId: USERS.admin,
      commandId: commandId(0x9103),
      expectedVersion: 1,
      leadId: 1,
      toAssignedTo: USERS.salesB,
    },
    targetCommandId: commandId(0x9103),
    targetTimestamp: "2026-08-05T12:00:02.000Z",
  },
  transition: {
    baselineSteps: ["create", "claim", "assign"],
    input: {
      actorAuthVersion: 1,
      actorId: USERS.salesB,
      commandId: commandId(0x9104),
      expectedVersion: 2,
      leadId: 1,
      toStatus: "contacted",
    },
    targetCommandId: commandId(0x9104),
    targetTimestamp: "2026-08-05T12:00:03.000Z",
  },
});

const BASELINE_INPUTS = Object.freeze({
  assign: {
    actorAuthVersion: 1,
    actorId: USERS.admin,
    commandId: commandId(0x9003),
    expectedVersion: 1,
    leadId: 1,
    toAssignedTo: USERS.salesB,
  },
  claim: {
    actorAuthVersion: 1,
    actorId: USERS.salesA,
    commandId: commandId(0x9002),
    expectedVersion: 0,
    leadId: 1,
  },
  create: {
    commandId: commandId(0x9001),
    contact: syntheticContact(),
  },
});

const BASELINE_TIMESTAMPS = Object.freeze({
  assign: "2026-08-05T11:00:02.000Z",
  claim: "2026-08-05T11:00:01.000Z",
  create: "2026-08-05T11:00:00.000Z",
});

function prepareCrashCase(operation) {
  const fixture = createProcessDatabase(`orta-ledger-crash-${operation}-`);
  for (const step of CRASH_CASES[operation].baselineSteps) {
    const store = createWorkflowStore(fixture.database, {
      clock: () => new Date(BASELINE_TIMESTAMPS[step]),
    });
    executeDirect(store, step, BASELINE_INPUTS[step]);
  }
  checkpointAndClose(fixture.database);
  return fixture;
}

function assertTargetProjection(snapshot, operation) {
  assert.equal(snapshot.projections.length, 1);
  const projection = snapshot.projections[0];
  const expected = {
    assign: { assigned_to: USERS.salesB, status: "new", workflow_version: 2 },
    claim: { assigned_to: USERS.salesA, status: "new", workflow_version: 1 },
    create: { assigned_to: null, status: "new", workflow_version: 0 },
    transition: {
      assigned_to: USERS.salesB,
      status: "contacted",
      workflow_version: 3,
    },
  }[operation];
  assert.deepEqual(
    {
      assigned_to: projection.assigned_to,
      status: projection.status,
      workflow_version: projection.workflow_version,
    },
    expected,
  );
}

for (const operation of Object.keys(CRASH_CASES)) {
  for (const stage of [
    "after_event_insert",
    "after_projection_update",
    "after_head_update",
    "after_commit_before_ack",
  ]) {
    test(
      `SIGKILL ${operation} at ${stage} preserves one atomic outcome`,
      { concurrency: false, skip: PROCESS_TEST_SKIP, timeout: 45_000 },
      async (context) => {
        const crashCase = CRASH_CASES[operation];
        const fixture = prepareCrashCase(operation);
        const baseline = readOnlySnapshot(fixture.filename);
        assertHealthySnapshot(baseline);
        const worker = new WorkflowProcessWorker(
          fixture.filename,
          `crash-${operation}-${stage}`,
        );
        context.after(async () => {
          await worker.terminate();
          rmSync(fixture.directory, { force: true, recursive: true });
        });
        await worker.waitUntilReady();

        const execution = worker.execute(
          request(
            operation,
            crashCase.input,
            crashCase.targetTimestamp,
            stage === "after_commit_before_ack"
              ? { pauseAfterCommit: true }
              : { pauseAt: stage },
          ),
        );
        execution.catch(() => {});
        const marker = await worker.nextMarker();
        assert.equal(
          marker.stage,
          stage === "after_commit_before_ack" ? "after_commit" : stage,
        );
        assert.equal(marker.operation, operation);
        assert.equal(marker.sequence, baseline.events.length + 1);
        assert.equal(marker.type, "paused");
        if (stage === "after_commit_before_ack") {
          assert.match(marker.event_hash, /^[0-9a-f]{64}$/u);
        } else {
          assert.equal(
            marker.action,
            {
              assign: "lead.assign",
              claim: "lead.claim",
              create: "lead.create",
              transition: "lead.transition",
            }[operation],
          );
          assert.equal(marker.lead_id, 1);
        }

        const exit = await worker.kill();
        assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
        await assert.rejects(execution, assertWorkerError("worker_exited"));
        assert.equal(worker.stderr, "");

        const recovered = readOnlySnapshot(fixture.filename);
        assertHealthySnapshot(recovered);
        if (stage === "after_commit_before_ack") {
          assert.equal(recovered.events.length, baseline.events.length + 1);
          assert.equal(
            targetCommandCount(recovered, crashCase.targetCommandId),
            1,
          );
          assertTargetProjection(recovered, operation);
        } else {
          assert.deepEqual(recovered, baseline);
          assert.equal(
            targetCommandCount(recovered, crashCase.targetCommandId),
            0,
          );
        }

        const direct = openDirectWriter(
          fixture.filename,
          crashCase.targetTimestamp,
        );
        let firstRetry;
        let secondRetry;
        try {
          firstRetry = executeDirect(direct.store, operation, crashCase.input);
          secondRetry = executeDirect(direct.store, operation, crashCase.input);
        } finally {
          direct.database.close();
        }

        assert.equal(
          firstRetry.replayed,
          stage === "after_commit_before_ack",
        );
        assert.equal(secondRetry.replayed, true);
        assert.equal(
          firstRetry.event.event_hash,
          secondRetry.event.event_hash,
        );
        assert.equal(firstRetry.event.sequence, secondRetry.event.sequence);

        const converged = readOnlySnapshot(fixture.filename);
        assertHealthySnapshot(converged);
        assert.equal(converged.events.length, baseline.events.length + 1);
        assert.equal(
          targetCommandCount(converged, crashCase.targetCommandId),
          1,
        );
        assertTargetProjection(converged, operation);
        if (operation === "create") {
          assert.deepEqual(
            readOperationalContact(fixture.filename, 1),
            stage === "after_commit_before_ack"
              ? workerSyntheticContact(
                  crashCase.targetCommandId,
                  crashCase.input.syntheticSeed,
                )
              : syntheticContact(`retry-${crashCase.input.syntheticSeed}`),
          );
        }
      },
    );
  }
}
