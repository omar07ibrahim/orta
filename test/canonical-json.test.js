"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CanonicalJsonError,
  MAX_COLLECTION_ITEMS,
  MAX_DEPTH,
  canonicalJsonBytes,
  canonicalJsonString,
  sha256Canonical,
} = require("../workflow/canonical-json");

test("canonical JSON is compact, sorted, newline-terminated, and domain-separated", () => {
  const value = {
    zeta: [3, true, null],
    alpha: { text: "İzmir", count: 2 },
  };

  assert.equal(
    canonicalJsonString(value),
    '{"alpha":{"count":2,"text":"İzmir"},"zeta":[3,true,null]}',
  );
  assert.equal(
    canonicalJsonBytes(value).toString("utf8"),
    '{"alpha":{"count":2,"text":"İzmir"},"zeta":[3,true,null]}\n',
  );
  assert.equal(
    sha256Canonical("orta.test-record.v1", value),
    sha256Canonical("orta.test-record.v1", {
      alpha: { count: 2, text: "İzmir" },
      zeta: [3, true, null],
    }),
  );
  assert.notEqual(
    sha256Canonical("orta.test-record.v1", value),
    sha256Canonical("orta.other-record.v1", value),
  );
});

test("canonical JSON rejects ambiguous numbers, types, objects, and arrays", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const getter = {};
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get() {
      return 1;
    },
  });
  const sparse = [];
  sparse.length = 1;
  const symbolKey = { value: 1 };
  symbolKey[Symbol("private")] = 2;
  const accessorArray = [1];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  class ArraySubclass extends Array {}
  const revokedObject = Proxy.revocable({ value: 1 }, {});
  revokedObject.revoke();
  const revokedArray = Proxy.revocable([1], {});
  revokedArray.revoke();

  const cases = [
    NaN,
    Infinity,
    -0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    1n,
    () => null,
    new Date(0),
    Buffer.from("private"),
    cyclic,
    getter,
    sparse,
    symbolKey,
    accessorArray,
    new ArraySubclass(1),
    new Proxy({ value: 1 }, {}),
    revokedObject.proxy,
    revokedArray.proxy,
  ];

  for (const value of cases) {
    assert.throws(
      () => canonicalJsonString(value),
      CanonicalJsonError,
    );
  }
});

test("canonical JSON enforces key, Unicode, depth, and collection limits", () => {
  assert.throws(
    () => canonicalJsonString({ CamelCase: 1 }),
    /invalid_key/u,
  );
  assert.throws(
    () => canonicalJsonString({ constructor: 1 }),
    /invalid_key/u,
  );
  assert.throws(
    () => canonicalJsonString({ text: "nul\0value" }),
    /nul_character/u,
  );
  assert.throws(
    () => canonicalJsonString({ text: "\ud800" }),
    /unpaired_surrogate/u,
  );

  let nested = null;
  for (let index = 0; index <= MAX_DEPTH; index += 1) {
    nested = [nested];
  }
  assert.throws(() => canonicalJsonString(nested), /too_deep/u);
  assert.throws(
    () => canonicalJsonString(Array(MAX_COLLECTION_ITEMS + 1).fill(null)),
    /collection_too_large/u,
  );
  assert.throws(
    () => sha256Canonical("not a domain", { value: 1 }),
    /invalid_domain/u,
  );
});
