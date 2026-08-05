"use strict";

const { createHash } = require("node:crypto");
const { types } = require("node:util");

const MAX_CANONICAL_BYTES = 64 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 2048;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_COLLECTION_ITEMS = 512;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9.-]{1,126}\.v[1-9][0-9]*$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class CanonicalJsonError extends Error {
  constructor(code) {
    super(`Canonical JSON rejected: ${code}`);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}

function reject(code) {
  throw new CanonicalJsonError(code);
}

function validateUnicode(value) {
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    reject("string_too_large");
  }

  if (value.includes("\0")) {
    reject("nul_character");
  }

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        reject("unpaired_surrogate");
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject("unpaired_surrogate");
    }
  }
}

function canonicalJsonString(value) {
  let visitedNodes = 0;
  const ancestors = new Set();

  function encode(current, depth) {
    visitedNodes += 1;
    if (visitedNodes > MAX_NODES) {
      reject("too_many_nodes");
    }
    if (depth > MAX_DEPTH) {
      reject("too_deep");
    }

    if (current === null) {
      return "null";
    }

    if (typeof current === "boolean") {
      return current ? "true" : "false";
    }

    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        reject("invalid_number");
      }
      return String(current);
    }

    if (typeof current === "string") {
      validateUnicode(current);
      return JSON.stringify(current);
    }

    if (typeof current !== "object") {
      reject("unsupported_type");
    }
    if (types.isProxy(current)) {
      reject("proxy");
    }

    if (ancestors.has(current)) {
      reject("cycle");
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          reject("noncanonical_array");
        }
        if (current.length > MAX_COLLECTION_ITEMS) {
          reject("collection_too_large");
        }

        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some((key) => typeof key !== "string")) {
          reject("symbol_key");
        }
        const expectedKeys = new Set([
          "length",
          ...Array.from({ length: current.length }, (_, index) => String(index)),
        ]);
        if (
          ownKeys.length !== expectedKeys.size ||
          ownKeys.some((key) => !expectedKeys.has(key))
        ) {
          reject("noncanonical_array");
        }

        const descriptors = Object.getOwnPropertyDescriptors(current);
        const encodedItems = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            descriptor.enumerable !== true ||
            !("value" in descriptor)
          ) {
            reject("noncanonical_array");
          }
          encodedItems.push(encode(descriptor.value, depth + 1));
        }
        return `[${encodedItems.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        reject("non_plain_object");
      }

      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.length > MAX_COLLECTION_ITEMS) {
        reject("collection_too_large");
      }
      if (ownKeys.some((key) => typeof key !== "string")) {
        reject("symbol_key");
      }

      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = ownKeys.slice().sort();
      const encodedFields = keys.map((key) => {
        validateUnicode(key);
        if (!KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key)) {
          reject("invalid_key");
        }

        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          reject("non_data_property");
        }

        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      });
      return `{${encodedFields.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, "utf8") + 1 > MAX_CANONICAL_BYTES) {
    reject("document_too_large");
  }
  return encoded;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${canonicalJsonString(value)}\n`, "utf8");
}

function sha256Canonical(domain, value) {
  if (typeof domain !== "string" || !DOMAIN_PATTERN.test(domain)) {
    reject("invalid_domain");
  }

  return createHash("sha256")
    .update(domain, "ascii")
    .update(Buffer.from([0]))
    .update(canonicalJsonBytes(value))
    .digest("hex");
}

module.exports = {
  CanonicalJsonError,
  MAX_CANONICAL_BYTES,
  MAX_COLLECTION_ITEMS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_STRING_BYTES,
  canonicalJsonBytes,
  canonicalJsonString,
  sha256Canonical,
};
