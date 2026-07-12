"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCloudPriceModelCandidates,
  extractBenchmarkCodingScore,
  fetchCodingScore,
  mapProviderToCloudPriceIds,
  fetchModelPricing,
  pickCurrentPricingOption,
} = require("../lib/cloudprice-client");

test("normalizeCloudPriceModelCandidates strips date and -free suffixes", () => {
  const candidates = normalizeCloudPriceModelCandidates("provider/deepseek-v4-pro-free-20260101");
  assert.ok(candidates.includes("provider/deepseek-v4-pro-free-20260101"));
  assert.ok(candidates.includes("deepseek-v4-pro-free"));
  assert.ok(candidates.includes("deepseek-v4-pro"));
});

test("normalizeCloudPriceModelCandidates returns empty array for blank model", () => {
  assert.deepEqual(normalizeCloudPriceModelCandidates(""), []);
  assert.deepEqual(normalizeCloudPriceModelCandidates(null), []);
});

test("extractBenchmarkCodingScore finds coding_index metric across sources", () => {
  const payload = { data: { sources: [{ scores: [{ metric: "reasoning_index", value: 10 }] }, { scores: [{ metric: "coding_index", value: 59.4 }] }] } };
  assert.equal(extractBenchmarkCodingScore(payload), 59.4);
});

test("extractBenchmarkCodingScore returns null when no coding_index present", () => {
  assert.equal(extractBenchmarkCodingScore({ data: { sources: [] } }), null);
  assert.equal(extractBenchmarkCodingScore(null), null);
});

test("fetchCodingScore fetches from cloudprice.net and caches by model", async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    assert.match(url, /ai\.cloudprice\.net\/api\/v1\/models\/deepseek-v4-pro\/benchmarks/);
    return {
      ok: true,
      json: async () => ({ data: { sources: [{ scores: [{ metric: "coding_index", value: 59.4 }] }] } }),
    };
  };
  const cache = new Map();
  const score1 = await fetchCodingScore("deepseek-v4-pro", fetchFn, cache);
  const score2 = await fetchCodingScore("deepseek-v4-pro", fetchFn, cache);
  assert.equal(score1, 59.4);
  assert.equal(score2, 59.4);
  assert.equal(calls, 1, "second call must hit the cache, not fetch again");
});

test("fetchCodingScore returns null when all candidates 404", async () => {
  const fetchFn = async () => ({ ok: false });
  const score = await fetchCodingScore("unknown-model", fetchFn, new Map());
  assert.equal(score, null);
});

test("mapProviderToCloudPriceIds maps known provider kinds", () => {
  assert.deepEqual(mapProviderToCloudPriceIds({ provider: "kimi" }), ["moonshot", "moonshot_ai", "moonshotai", "kimi"]);
  assert.deepEqual(mapProviderToCloudPriceIds({ provider: "unknownkind" }), ["unknownkind"]);
});

test("fetchModelPricing returns payload.data when options or result present", async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ data: { options: [{ provider_id: "deepseek", tier: "standard", total_cost: 1.5 }], result: { total_cost: 1.2 } } }),
  });
  const data = await fetchModelPricing("deepseek-chat", fetchFn, new Map());
  assert.equal(data.options[0].provider_id, "deepseek");
});

test("pickCurrentPricingOption filters by provider id and standard tier, sorts by total_cost", () => {
  const options = [
    { provider_id: "deepseek", tier: "standard", total_cost: 3 },
    { provider_id: "deepseek", tier: "standard", total_cost: 1 },
    { provider_id: "openrouter", tier: "standard", total_cost: 0.5 },
  ];
  const picked = pickCurrentPricingOption(options, { provider: "deepseek" });
  assert.equal(picked.total_cost, 1);
});

test("pickCurrentPricingOption returns null when no match", () => {
  assert.equal(pickCurrentPricingOption([], { provider: "deepseek" }), null);
  assert.equal(pickCurrentPricingOption(null, { provider: "deepseek" }), null);
});
