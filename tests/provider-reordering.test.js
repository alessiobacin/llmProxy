"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
  computeProviderScores,
  rankProvidersByCriteria,
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

test("computeProviderScores fetches only the requested criteria", async () => {
  let priceCalls = 0;
  let powerCalls = 0;
  let probeCalls = 0;
  const fetchFn = async (url) => {
    if (url.includes("/pricing/calculate")) {
      priceCalls += 1;
      return { ok: true, json: async () => ({ data: { options: [{ provider_id: "deepseek", tier: "standard", total_cost: 2 }] } }) };
    }
    if (url.includes("/benchmarks")) {
      powerCalls += 1;
      return { ok: true, json: async () => ({ data: { sources: [{ scores: [{ metric: "coding_index", value: 59.4 }] }] } }) };
    }
    return { ok: false };
  };
  const probeFn = async () => { probeCalls += 1; return { ok: true }; };
  const providers = [{ id: "p1", provider: "deepseek", default_model: "deepseek-chat" }];

  await computeProviderScores(providers, ["price"], { fetchFn, probeFn });
  assert.equal(priceCalls, 1);
  assert.equal(powerCalls, 0);
  assert.equal(probeCalls, 0);
});

test("computeProviderScores: price is 0 for free_model providers without a network call", async () => {
  let priceCalls = 0;
  const fetchFn = async () => { priceCalls += 1; return { ok: false }; };
  const providers = [{ id: "p1", provider: "deepseek", default_model: "deepseek-chat", free_model: true }];
  const scores = await computeProviderScores(providers, ["price"], { fetchFn });
  assert.equal(scores.get("p1").price, 0);
  assert.equal(priceCalls, 0);
});

test("computeProviderScores: power reads coding_index from cloudprice benchmarks", async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { sources: [{ scores: [{ metric: "coding_index", value: 59.4 }] }] } }) });
  const providers = [{ id: "p1", provider: "deepseek", default_model: "deepseek-chat" }];
  const scores = await computeProviderScores(providers, ["power"], { fetchFn });
  assert.equal(scores.get("p1").power, 59.4);
});

test("computeProviderScores: speed measures real probe latency in ms", async () => {
  const probeFn = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true };
  };
  const providers = [{ id: "p1", provider: "deepseek", default_model: "deepseek-chat" }];
  const scores = await computeProviderScores(providers, ["speed"], { probeFn });
  assert.ok(typeof scores.get("p1").speed === "number" && scores.get("p1").speed >= 5);
});

test("computeProviderScores: missing data becomes null (worst) for that criterion only", async () => {
  const fetchFn = async () => ({ ok: false });
  const probeFn = async () => ({ ok: false });
  const providers = [{ id: "p1", provider: "deepseek", default_model: "deepseek-chat" }];
  const scores = await computeProviderScores(providers, ["price", "power", "speed"], { fetchFn, probeFn });
  assert.equal(scores.get("p1").price, null);
  assert.equal(scores.get("p1").power, null);
  assert.equal(scores.get("p1").speed, null);
});

test("computeProviderScores: provider with no model and no probeFn yields null speed, not a throw", async () => {
  const providers = [{ id: "p1", provider: "deepseek", default_model: "deepseek-chat" }];
  const scores = await computeProviderScores(providers, ["speed"], {});
  assert.equal(scores.get("p1").speed, null);
});

test("rankProvidersByCriteria sorts by price ascending (cheaper wins)", () => {
  const providers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const scores = new Map([
    ["a", { price: 3 }],
    ["b", { price: 1 }],
    ["c", { price: 2 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["price"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "c", "a"]);
});

test("rankProvidersByCriteria sorts by power descending (higher coding score wins)", () => {
  const providers = [{ id: "a" }, { id: "b" }];
  const scores = new Map([
    ["a", { power: 40 }],
    ["b", { power: 80 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["power"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "a"]);
});

test("rankProvidersByCriteria sorts by speed ascending (lower latency wins)", () => {
  const providers = [{ id: "a" }, { id: "b" }];
  const scores = new Map([
    ["a", { speed: 900 }],
    ["b", { speed: 300 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["speed"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "a"]);
});

test("rankProvidersByCriteria breaks price ties using the second criterion", () => {
  const providers = [{ id: "a" }, { id: "b" }];
  const scores = new Map([
    ["a", { price: 0, power: 40 }],
    ["b", { price: 0, power: 80 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["price", "power"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "a"]);
});

test("rankProvidersByCriteria falls through to a third criterion on double tie", () => {
  const providers = [{ id: "a" }, { id: "b" }];
  const scores = new Map([
    ["a", { price: 0, power: 50, speed: 500 }],
    ["b", { price: 0, power: 50, speed: 200 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["price", "power", "speed"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "a"]);
});

test("rankProvidersByCriteria treats missing data as worst on that criterion, ranking still proceeds", () => {
  const providers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const scores = new Map([
    ["a", { price: 5 }],
    ["b", { price: null }],
    ["c", { price: 1 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["price"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["c", "a", "b"]);
});

test("rankProvidersByCriteria preserves original relative order on a full tie (stable stabilizer)", () => {
  const providers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const scores = new Map([
    ["a", { price: 1 }],
    ["b", { price: 1 }],
    ["c", { price: 1 }],
  ]);
  const ranked = rankProvidersByCriteria(providers, ["price"], scores);
  assert.deepEqual(ranked.map((p) => p.id), ["a", "b", "c"]);
});

test("rankProvidersByCriteria returns providers unchanged when criteria list is empty", () => {
  const providers = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(rankProvidersByCriteria(providers, [], new Map()).map((p) => p.id), ["a", "b"]);
});
