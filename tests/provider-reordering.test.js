"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
  computeProviderScores,
  rankProvidersByCriteria,
  createProviderReordering,
  readReorderingStore,
  buildDefaultProbeFn,
} = require("../lib/provider-reordering");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

test("buildDefaultProbeFn aborts a stuck provider probe instead of hanging forever", async () => {
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("probe-timeout")), 10);
    return controller.signal;
  };

  try {
    const probeFn = buildDefaultProbeFn();
    const result = await probeFn({
      provider: {
        provider: "openai",
        access_token: "token",
      },
      model: "gpt-4o-mini",
      fetchFn: (_url, options = {}) => new Promise((_, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(signal.reason || new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(signal.reason || new Error("aborted"));
        }, { once: true });
      }),
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error || ""), /timeout|aborted/i);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
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

test("createProviderReordering.runCycle does nothing when no criteria are configured", async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reorder-")), "store.json");
  let orderCalls = 0;
  const tokenStore = {
    listProviders: () => [{ id: "a", access_token: "t" }],
    setProviderOrder: () => { orderCalls += 1; },
  };
  const reordering = createProviderReordering({ tokenStore, filePath: tmpFile, fetchFn: async () => ({ ok: false }) });
  const result = await reordering.runCycle({});
  assert.equal(result, null);
  assert.equal(orderCalls, 0);
});

test("createProviderReordering.runCycle ranks providers and persists the order into the token store", async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reorder-")), "store.json");
  let persistedOrder = null;
  const tokenStore = {
    listProviders: () => [
      { id: "expensive", access_token: "t", default_model: "m1" },
      { id: "free", access_token: "t", default_model: "m2", free_model: true },
    ],
    setProviderOrder: (order) => { persistedOrder = order; },
  };
  const fetchFn = async () => ({ ok: false }); // price lookup fails for the non-free provider -> treated as worst
  const reordering = createProviderReordering({ tokenStore, filePath: tmpFile, fetchFn });
  const result = await reordering.runCycle({ LLMPROXY_REORDERING: "price" });
  assert.deepEqual(persistedOrder, ["free", "expensive"]);
  assert.deepEqual(result.order, ["free", "expensive"]);
  assert.deepEqual(result.criteria, ["price"]);
});

test("createProviderReordering.runCycle persists scores and timestamp to the JSON store file", async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reorder-")), "store.json");
  const tokenStore = {
    listProviders: () => [{ id: "a", access_token: "t", free_model: true }],
    setProviderOrder: () => {},
  };
  const reordering = createProviderReordering({ tokenStore, filePath: tmpFile, fetchFn: async () => ({ ok: false }) });
  await reordering.runCycle({ LLMPROXY_REORDERING: "price" });
  const stored = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
  assert.equal(stored.scores.a.price, 0);
  assert.ok(typeof stored.lastUpdatedMs === "number" && stored.lastUpdatedMs > 0);
  assert.deepEqual(reordering.getStore().order, ["a"]);
});

test("createProviderReordering.runCycle ignores providers without an access_token", async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reorder-")), "store.json");
  let persistedOrder = null;
  const tokenStore = {
    listProviders: () => [
      { id: "a", access_token: "t", free_model: true },
      { id: "b", free_model: true }, // no access_token
    ],
    setProviderOrder: (order) => { persistedOrder = order; },
  };
  const reordering = createProviderReordering({ tokenStore, filePath: tmpFile, fetchFn: async () => ({ ok: false }) });
  await reordering.runCycle({ LLMPROXY_REORDERING: "price" });
  assert.deepEqual(persistedOrder, ["a"]);
});

test("readReorderingStore returns empty defaults when the file does not exist", () => {
  const missingFile = path.join(os.tmpdir(), `llmproxy-reorder-missing-${Date.now()}.json`);
  const store = readReorderingStore(missingFile);
  assert.deepEqual(store, { criteria: [], order: [], scores: {}, lastUpdatedMs: 0 });
});

test("createProviderReordering.start runs an immediate cycle then stops cleanly", async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reorder-")), "store.json");
  let cycles = 0;
  const tokenStore = {
    listProviders: () => { cycles += 1; return [{ id: "a", access_token: "t", free_model: true }]; },
    setProviderOrder: () => {},
  };
  const reordering = createProviderReordering({ tokenStore, filePath: tmpFile, fetchFn: async () => ({ ok: false }) });
  reordering.start(null, { LLMPROXY_REORDERING: "price", LLMPROXY_REORDERING_MINUTES: "60" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cycles, 1, "start() must run one immediate cycle");
  reordering.stop();
});

test("createProviderReordering.start does nothing when no criteria are configured", async () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-reorder-")), "store.json");
  let cycles = 0;
  const tokenStore = {
    listProviders: () => { cycles += 1; return []; },
    setProviderOrder: () => {},
  };
  const reordering = createProviderReordering({ tokenStore, filePath: tmpFile, fetchFn: async () => ({ ok: false }) });
  reordering.start(null, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cycles, 0);
  reordering.stop();
});

test("buildDefaultProbeFn returns ok:false for a provider with no known probe endpoint", async () => {
  const probeFn = buildDefaultProbeFn();
  const result = await probeFn({ provider: { provider: "totally-unknown-kind" }, model: "m", fetchFn: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
});

test("buildDefaultProbeFn issues a POST to the mapped endpoint for a known provider", async () => {
  const probeFn = buildDefaultProbeFn();
  let calledUrl = null;
  const fetchFn = async (url) => { calledUrl = url; return { ok: true }; };
  const result = await probeFn({ provider: { provider: "deepseek", access_token: "t" }, model: "deepseek-chat", fetchFn });
  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://api.deepseek.com/v1/chat/completions");
});
