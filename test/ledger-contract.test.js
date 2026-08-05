"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { sha256Canonical } = require("../workflow/canonical-json");

const {
  ACTION_EVENT_TYPES,
  ALLOWED_TRANSITIONS,
  LedgerContractError,
  ZERO_HASH,
  createLedgerEvent,
  digestWorkflowCommand,
  normalizeWorkflowCommand,
  verifyLedgerEvent,
} = require("../workflow/ledger-contract");

const COMMAND_IDS = Object.freeze({
  create: "cmd_00000000000000000000000000000001",
  import: "cmd_00000000000000000000000000000002",
  claim: "cmd_00000000000000000000000000000003",
  assign: "cmd_00000000000000000000000000000004",
  transition: "cmd_00000000000000000000000000000005",
  convert: "cmd_00000000000000000000000000000006",
});

function createdEventInput(overrides = {}) {
  return {
    actor: { id: null, role: "public" },
    aggregate: { id: 17, type: "lead", version: 0 },
    command: {
      action: "lead.create",
      command_id: COMMAND_IDS.create,
      lead_id: 17,
    },
    event_type: "lead.created",
    occurred_at: "2026-08-05T00:00:00.000Z",
    payload: { assigned_to: null, status: "new" },
    previous_hash: ZERO_HASH,
    schema: "orta.workflow-event.v1",
    sequence: 1,
    ...overrides,
  };
}

function claimEventInput(previousHash, overrides = {}) {
  return {
    actor: { id: 4, role: "sales" },
    aggregate: { id: 17, type: "lead", version: 1 },
    command: {
      action: "lead.claim",
      actor_id: 4,
      command_id: COMMAND_IDS.claim,
      expected_version: 0,
      lead_id: 17,
    },
    event_type: "lead.claimed",
    occurred_at: "2026-08-05T00:00:01.000Z",
    payload: {
      from_assigned_to: null,
      status: "new",
      to_assigned_to: 4,
    },
    previous_hash: previousHash,
    schema: "orta.workflow-event.v1",
    sequence: 2,
    ...overrides,
  };
}

test("a lead-created event has one deterministic immutable identity", () => {
  const first = createLedgerEvent(createdEventInput());
  const second = createLedgerEvent({
    ...createdEventInput(),
    payload: { status: "new", assigned_to: null },
  });

  assert.deepEqual(first, second);
  assert.equal(
    first.command_digest,
    "e6343221042db12e170dd6a352f4b9005824e087608265538389552e5ec38e5c",
  );
  assert.equal(
    first.event_hash,
    "c5cf00e980efd143a51ad8787ea5b6fce6dbec3d7d96149cf73f256f7748f369",
  );
  assert.equal(verifyLedgerEvent(first).event_hash, first.event_hash);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.actor), true);
  assert.equal(Object.isFrozen(first.aggregate), true);
  assert.equal(Object.isFrozen(first.command), true);
  assert.equal(Object.isFrozen(first.payload), true);
  assert.throws(() => {
    first.payload.status = "rejected";
  }, TypeError);
});

test("event verification rejects hash, command, schema, field, and payload drift", () => {
  const event = createLedgerEvent(createdEventInput());
  const hiddenField = { ...event };
  Object.defineProperty(hiddenField, "private_note", {
    enumerable: false,
    value: "not allowed",
  });
  const symbolField = { ...event };
  symbolField[Symbol("private")] = "not allowed";
  const accessorField = { ...event };
  Object.defineProperty(accessorField, "event_type", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const proxiedRecord = new Proxy({ ...event }, {});
  const revokedRecord = Proxy.revocable({ ...event }, {});
  revokedRecord.revoke();
  const mutations = [
    { ...event, event_hash: "f".repeat(64) },
    { ...event, command_digest: "f".repeat(64) },
    {
      ...event,
      command: { ...event.command, command_id: COMMAND_IDS.import },
    },
    { ...event, schema: "orta.workflow-event.v2" },
    { ...event, private_note: "not allowed" },
    { ...event, payload: { ...event.payload, email: "hidden@example.invalid" } },
    { ...event, actor: { id: 1, role: "public" } },
    { ...event, aggregate: { ...event.aggregate, version: 1 } },
    hiddenField,
    symbolField,
    accessorField,
    proxiedRecord,
    revokedRecord.proxy,
  ];

  for (const mutation of mutations) {
    assert.throws(() => verifyLedgerEvent(mutation), LedgerContractError);
  }
});

test("creation and import events have exclusive, non-operator actors", () => {
  assert.throws(
    () =>
      createLedgerEvent(
        createdEventInput({ actor: { id: 1, role: "admin" } }),
      ),
    /creation_requires_public_actor/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        ...createdEventInput(),
        actor: { id: null, role: "public" },
        aggregate: { id: 18, type: "lead", version: 0 },
        command: {
          action: "lead.import",
          assigned_role: null,
          assigned_to: null,
          command_id: COMMAND_IDS.import,
          lead_id: 18,
          status: "new",
        },
        event_type: "lead.imported",
        payload: { assigned_role: null, assigned_to: null, status: "new" },
      }),
    /import_requires_system_actor/u,
  );

  const imported = createLedgerEvent({
    ...createdEventInput(),
    actor: { id: null, role: "system" },
    aggregate: { id: 18, type: "lead", version: 0 },
    command: {
      action: "lead.import",
      assigned_role: "sales",
      assigned_to: 4,
      command_id: COMMAND_IDS.import,
      lead_id: 18,
      status: "contacted",
    },
    event_type: "lead.imported",
    payload: {
      assigned_role: "sales",
      assigned_to: 4,
      status: "contacted",
    },
  });
  assert.equal(imported.actor.role, "system");
  assert.equal(imported.payload.assigned_role, "sales");

  assert.throws(
    () =>
      createLedgerEvent({
        ...createdEventInput(),
        actor: { id: null, role: "system" },
        aggregate: { id: 18, type: "lead", version: 0 },
        command: {
          ...imported.command,
          assigned_to: 5,
        },
        event_type: "lead.imported",
        payload: imported.payload,
      }),
    /command_import_mismatch/u,
  );
  assert.throws(
    () =>
      normalizeWorkflowCommand({
        action: "lead.import",
        assigned_role: null,
        assigned_to: null,
        command_id: COMMAND_IDS.import,
        lead_id: 18,
        status: "contacted",
      }),
    /invalid_import_command_state/u,
  );
});

test("claim, assignment, and status events enforce actor and state semantics", () => {
  const created = createLedgerEvent(createdEventInput());
  const claim = createLedgerEvent(claimEventInput(created.event_hash));
  const assignment = createLedgerEvent({
    actor: { id: 1, role: "admin" },
    aggregate: { id: 17, type: "lead", version: 2 },
    command: {
      action: "lead.assign",
      actor_id: 1,
      command_id: COMMAND_IDS.assign,
      expected_version: 1,
      lead_id: 17,
      to_assigned_to: 5,
    },
    event_type: "lead.assigned",
    occurred_at: "2026-08-05T00:00:02.000Z",
    payload: {
      from_assigned_to: 4,
      status: "new",
      to_assigned_role: "sales",
      to_assigned_to: 5,
    },
    previous_hash: claim.event_hash,
    schema: "orta.workflow-event.v1",
    sequence: 3,
  });
  const contacted = createLedgerEvent({
    actor: { id: 5, role: "sales" },
    aggregate: { id: 17, type: "lead", version: 3 },
    command: {
      action: "lead.transition",
      actor_id: 5,
      command_id: COMMAND_IDS.transition,
      expected_version: 2,
      lead_id: 17,
      to_status: "contacted",
    },
    event_type: "lead.status_changed",
    occurred_at: "2026-08-05T00:00:03.000Z",
    payload: {
      assigned_to: 5,
      from_status: "new",
      to_status: "contacted",
    },
    previous_hash: assignment.event_hash,
    schema: "orta.workflow-event.v1",
    sequence: 4,
  });
  const converted = createLedgerEvent({
    actor: { id: 1, role: "admin" },
    aggregate: { id: 17, type: "lead", version: 4 },
    command: {
      action: "lead.transition",
      actor_id: 1,
      command_id: COMMAND_IDS.convert,
      expected_version: 3,
      lead_id: 17,
      to_status: "converted",
    },
    event_type: "lead.status_changed",
    occurred_at: "2026-08-05T00:00:04.000Z",
    payload: {
      assigned_to: 5,
      from_status: "contacted",
      to_status: "converted",
    },
    previous_hash: contacted.event_hash,
    schema: "orta.workflow-event.v1",
    sequence: 5,
  });

  assert.equal(claim.payload.to_assigned_to, 4);
  assert.equal(assignment.payload.to_assigned_to, 5);
  assert.equal(contacted.payload.to_status, "contacted");
  assert.equal(converted.payload.to_status, "converted");

  assert.throws(
    () =>
      createLedgerEvent({
        ...claimEventInput(created.event_hash),
        actor: { id: 4, role: "sales" },
        aggregate: { id: 17, type: "lead", version: 2 },
        command: {
          action: "lead.assign",
          actor_id: 4,
          command_id: COMMAND_IDS.assign,
          expected_version: 1,
          lead_id: 17,
          to_assigned_to: 5,
        },
        event_type: "lead.assigned",
        payload: {
          from_assigned_to: 4,
          status: "new",
          to_assigned_role: "sales",
          to_assigned_to: 5,
        },
      }),
    /assignment_requires_admin/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        ...claimEventInput(created.event_hash),
        aggregate: { id: 17, type: "lead", version: 2 },
        command: {
          action: "lead.transition",
          actor_id: 4,
          command_id: COMMAND_IDS.transition,
          expected_version: 1,
          lead_id: 17,
          to_status: "converted",
        },
        event_type: "lead.status_changed",
        payload: {
          assigned_to: 4,
          from_status: "new",
          to_status: "converted",
        },
      }),
    /invalid_status_transition/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        ...claimEventInput(created.event_hash),
        actor: { id: 5, role: "sales" },
        aggregate: { id: 17, type: "lead", version: 2 },
        command: {
          action: "lead.transition",
          actor_id: 5,
          command_id: COMMAND_IDS.transition,
          expected_version: 1,
          lead_id: 17,
          to_status: "contacted",
        },
        event_type: "lead.status_changed",
        payload: {
          assigned_to: 4,
          from_status: "new",
          to_status: "contacted",
        },
      }),
    /sales_actor_not_assigned/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        actor: { id: 1, role: "admin" },
        aggregate: { id: 17, type: "lead", version: 5 },
        command: {
          action: "lead.assign",
          actor_id: 1,
          command_id: COMMAND_IDS.assign,
          expected_version: 4,
          lead_id: 17,
          to_assigned_to: 6,
        },
        event_type: "lead.assigned",
        occurred_at: "2026-08-05T00:00:05.000Z",
        payload: {
          from_assigned_to: 5,
          status: "converted",
          to_assigned_role: "sales",
          to_assigned_to: 6,
        },
        previous_hash: converted.event_hash,
        schema: "orta.workflow-event.v1",
        sequence: 6,
      }),
    /invalid_assignment_transition/u,
  );
});

test("commands are cross-bound to event, aggregate, version, actor, and target", () => {
  const created = createLedgerEvent(createdEventInput());
  const baseClaim = claimEventInput(created.event_hash);
  assert.throws(
    () =>
      createLedgerEvent({
        ...createdEventInput(),
        command_digest: "a".repeat(64),
      }),
    /invalid_event_fields/u,
  );
  const mismatches = [
    {
      ...baseClaim,
      command: {
        action: "lead.transition",
        actor_id: 4,
        command_id: COMMAND_IDS.transition,
        expected_version: 0,
        lead_id: 17,
        to_status: "contacted",
      },
    },
    { ...baseClaim, command: { ...baseClaim.command, lead_id: 18 } },
    { ...baseClaim, command: { ...baseClaim.command, expected_version: 1 } },
    { ...baseClaim, command: { ...baseClaim.command, actor_id: 5 } },
  ];
  for (const mismatch of mismatches) {
    assert.throws(() => createLedgerEvent(mismatch), LedgerContractError);
  }

  assert.throws(
    () =>
      createLedgerEvent({
        actor: { id: 1, role: "admin" },
        aggregate: { id: 17, type: "lead", version: 1 },
        command: {
          action: "lead.assign",
          actor_id: 1,
          command_id: COMMAND_IDS.assign,
          expected_version: 0,
          lead_id: 17,
          to_assigned_to: 5,
        },
        event_type: "lead.assigned",
        occurred_at: "2026-08-05T00:00:01.000Z",
        payload: {
          from_assigned_to: null,
          status: "new",
          to_assigned_role: "sales",
          to_assigned_to: 6,
        },
        previous_hash: created.event_hash,
        schema: "orta.workflow-event.v1",
        sequence: 2,
      }),
    /command_assignment_mismatch/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        ...baseClaim,
        command: {
          action: "lead.transition",
          actor_id: 4,
          command_id: COMMAND_IDS.transition,
          expected_version: 0,
          lead_id: 17,
          to_status: "rejected",
        },
        event_type: "lead.status_changed",
        payload: {
          assigned_to: 4,
          from_status: "new",
          to_status: "contacted",
        },
      }),
    /command_status_mismatch/u,
  );
});

test("chain origins bind sequence one to the zero hash only", () => {
  assert.throws(
    () =>
      createLedgerEvent(
        createdEventInput({ previous_hash: "a".repeat(64) }),
      ),
    /invalid_chain_origin/u,
  );
  assert.throws(
    () =>
      createLedgerEvent(
        createdEventInput({ sequence: 2, previous_hash: ZERO_HASH }),
      ),
    /invalid_chain_origin/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        ...claimEventInput(ZERO_HASH),
        sequence: 1,
      }),
    /invalid_chain_origin/u,
  );
  assert.throws(
    () =>
      createLedgerEvent({
        ...claimEventInput("a".repeat(64)),
        aggregate: { id: 17, type: "lead", version: 2 },
        command: {
          ...claimEventInput("a".repeat(64)).command,
          expected_version: 1,
        },
      }),
    /event_sequence_mismatch/u,
  );
});

test("the state machine is closed and terminal states cannot transition", () => {
  assert.deepEqual(ALLOWED_TRANSITIONS, {
    new: ["contacted", "rejected"],
    contacted: ["converted", "rejected"],
    converted: [],
    rejected: [],
  });
  assert.deepEqual(ACTION_EVENT_TYPES, {
    "lead.create": "lead.created",
    "lead.import": "lead.imported",
    "lead.claim": "lead.claimed",
    "lead.assign": "lead.assigned",
    "lead.transition": "lead.status_changed",
  });
  assert.equal(Object.isFrozen(ALLOWED_TRANSITIONS), true);
  assert.equal(Object.isFrozen(ALLOWED_TRANSITIONS.new), true);
  assert.equal(Object.isFrozen(ACTION_EVENT_TYPES), true);
});

test("commands exclude direct contact content and reject hostile objects", () => {
  const command = {
    action: "lead.claim",
    actor_id: 4,
    command_id: COMMAND_IDS.claim,
    expected_version: 0,
    lead_id: 17,
  };
  const hidden = { ...command };
  Object.defineProperty(hidden, "email", {
    enumerable: false,
    value: "hidden@example.invalid",
  });
  const symbol = { ...command };
  symbol[Symbol("phone")] = "+000000000";
  const accessor = { ...command };
  Object.defineProperty(accessor, "action", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const revokedCommand = Proxy.revocable({ ...command }, {});
  revokedCommand.revoke();
  const invalidCommands = [
    { ...command, email: "hidden@example.invalid" },
    { ...command, phone: "+000000000" },
    { ...command, message: "private" },
    { ...command, command_id: "cmd_claim_omar" },
    hidden,
    symbol,
    accessor,
    new Proxy(command, {}),
    revokedCommand.proxy,
  ];

  assert.deepEqual(normalizeWorkflowCommand(command), command);
  for (const invalid of invalidCommands) {
    assert.throws(() => normalizeWorkflowCommand(invalid), LedgerContractError);
  }
});

test("semantic mismatches fail even after an attacker recomputes both hashes", () => {
  const event = createLedgerEvent(createdEventInput());
  const command = { ...event.command, lead_id: 18 };
  const commandDigest = digestWorkflowCommand(command);
  const { event_hash: ignoredHash, ...originalBody } = event;
  const forgedBody = {
    ...originalBody,
    command,
    command_digest: commandDigest,
  };
  const forged = {
    ...forgedBody,
    event_hash: sha256Canonical("orta.workflow-event.v1", forgedBody),
  };

  assert.equal(typeof ignoredHash, "string");
  assert.throws(
    () => verifyLedgerEvent(forged),
    /command_aggregate_mismatch/u,
  );
});

test("command digests bind domain and every canonical command field", () => {
  const command = {
    action: "lead.claim",
    actor_id: 4,
    command_id: COMMAND_IDS.claim,
    expected_version: 0,
    lead_id: 17,
  };
  const digest = digestWorkflowCommand(command);

  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.notEqual(
    digest,
    digestWorkflowCommand({ ...command, expected_version: 1 }),
  );
  assert.notEqual(
    digest,
    digestWorkflowCommand({ ...command, actor_id: 5 }),
  );
  assert.notEqual(
    digest,
    digestWorkflowCommand({ ...command, command_id: COMMAND_IDS.assign }),
  );
});
