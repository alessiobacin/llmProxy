"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
} = require("../lib/provider-reordering");

test("parseReorderingCriteria returns empty array for unset/blank value", () => {
  assert.deepEqual(parseReorderingCriteria(undefined), []);
  assert.deepEqual(parseReorderingCriteria(""), []);
  assert.deepEqual(parseReorderingCriteria("   "), []);
});

test("parseReorderingCriteria parses a full ordered list", () => {
  assert.deepEqual(parseReorderingCriteria("price-speed-power"), ["price", "speed", "power"]);
});

test("parseReorderingCriteria accepts a subset", () => {
  assert.deepEqual(parseReorderingCriteria("price"), ["price"]);
  assert.deepEqual(parseReorderingCriteria("power-speed"), ["power", "speed"]);
});

test("parseReorderingCriteria is case-insensitive and trims whitespace", () => {
  assert.deepEqual(parseReorderingCriteria(" PRICE - Speed "), ["price", "speed"]);
});

test("parseReorderingCriteria throws on unknown token", () => {
  assert.throws(() => parseReorderingCriteria("price-quality"), /criterio non valido/i);
});

test("parseReorderingCriteria throws on duplicate token", () => {
  assert.throws(() => parseReorderingCriteria("price-price"), /duplicato/i);
});

test("resolveReorderingCriteria reads LLMPROXY_REORDERING from the given env source", () => {
  assert.deepEqual(resolveReorderingCriteria({ LLMPROXY_REORDERING: "speed-price" }), ["speed", "price"]);
  assert.deepEqual(resolveReorderingCriteria({}), []);
});

test("resolveReorderingMinutes defaults to 5 when criteria are set but minutes are missing", () => {
  assert.equal(resolveReorderingMinutes(null, { LLMPROXY_REORDERING: "price" }), 5);
});

test("resolveReorderingMinutes uses the configured value when valid", () => {
  assert.equal(resolveReorderingMinutes(null, { LLMPROXY_REORDERING: "price", LLMPROXY_REORDERING_MINUTES: "15" }), 15);
});

test("resolveReorderingMinutes ignores LLMPROXY_REORDERING_MINUTES when criteria are absent", () => {
  assert.equal(resolveReorderingMinutes(null, { LLMPROXY_REORDERING_MINUTES: "15" }), 0);
});

test("resolveReorderingMinutes honors a numeric override regardless of env", () => {
  assert.equal(resolveReorderingMinutes(3, { LLMPROXY_REORDERING: "price" }), 3);
});
