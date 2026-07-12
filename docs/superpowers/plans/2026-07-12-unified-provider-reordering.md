# Unified Provider Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four disconnected provider-routing mechanisms (`LLMPROXY_AUTO_ESCALATE`, `LLMPROXY_PRICE_PERFORMANCE_ROUTING`/`TIEBREAKER`, `LLMPROXY_PROVIDER_BENCHMARK_MINUTES`) plus dead "smart router" code with one mechanism — `LLMPROXY_REORDERING` / `LLMPROXY_REORDERING_MINUTES` — that periodically ranks providers by live price/power/speed data and persists the result into the shared token-store order.

**Architecture:** A new `lib/provider-reordering.js` module owns criteria parsing, live scoring (price + power from `ai.cloudprice.net`, speed from a real inference-latency probe), stable multi-key ranking, and a `setInterval` cycle that persists the ranked order into `token-store` via `setProviderOrder`. A new `lib/cloudprice-client.js` extracts the raw CloudPrice HTTP calls so both `lib/cli.js` (display) and `lib/provider-reordering.js` (ranking) share one implementation. `lib/copilot-proxy.js` stops computing any order at request time — it just reads `tokenStore.listProviders()`.

**Tech Stack:** Node.js (CommonJS in `lib/`, TypeScript in `src/gateway/`), `node:test` + `node:assert/strict`, no new dependencies.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-12-unified-provider-reordering-design.md` — every task below implements a section of it.
- Per `CLAUDE.md`: the `llmproxy` package version MUST be bumped before the final commit that will be pushed (Task 15).
- No TypeScript `any`, no `@ts-ignore` in `src/gateway/services/llm-transport.ts` edits (Task 11).
- Tests run with `node --test tests/*.test.js` (per `package.json`); TypeScript changes need `npm run build:ts` before tests that exercise the compiled `lib/ts-build/` output.
- `LLMPROXY_REORDERING` / `LLMPROXY_REORDERING_MINUTES` are **service-scope** (read once from process env, not per-project `.claude/settings.json`) — see design doc's "Scope: global only, not per-project" section.
- Old vars are removed everywhere and silently ignored if still present in a user's environment — no deprecation warnings.

---

## Task 1: Extract shared CloudPrice client

**Files:**
- Create: `lib/cloudprice-client.js`
- Create: `tests/cloudprice-client.test.js`
- Modify: `lib/cli.js:1493-1525` (`fetchProviderCodingInfo`), `lib/cli.js:1609-1621` (`normalizeCloudPriceModelCandidates`, delete — now imported), `lib/cli.js:1663-1775` (`pickCloudPriceCurrentOption`, `fetchCloudPriceModelPricing`, `fetchProviderPriceInfo`), `lib/cli.js:1535-1542` (`readJsonResponseSafe`, delete — now imported), `lib/cli.js:1482-1491` (`extractBenchmarkCodingScore`, delete — now imported), `lib/cli.js:1623-1635` (`mapProviderToCloudPriceIds`, delete — now imported)

**Interfaces:**
- Produces (used by Task 4 and Task 12): `readJsonResponseSafe(response)`, `normalizeCloudPriceModelCandidates(model)`, `extractBenchmarkCodingScore(payload)`, `fetchCodingScore(model, fetchFn, cache) → Promise<number|null>`, `mapProviderToCloudPriceIds(provider)`, `fetchModelPricing(model, fetchFn, cache) → Promise<{result, options}|null>`, `pickCurrentPricingOption(options, provider) → {total_cost, breakdown, ...}|null`

- [ ] **Step 1: Write `lib/cloudprice-client.js`**

```js
"use strict";

async function readJsonResponseSafe(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeCloudPriceModelCandidates(model) {
  const raw = String(model || "").trim();
  if (!raw) return [];
  const withoutDate = raw.replace(/-\d{8}$/i, "");
  const withoutFree = raw.replace(/-free$/i, "");
  const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
  const leafWithoutDate = leaf.replace(/-\d{8}$/i, "");
  const leafWithoutFree = leaf.replace(/-free$/i, "");
  return Array.from(new Set([
    raw, withoutDate, withoutFree,
    leaf, leafWithoutDate, leafWithoutFree,
  ].filter(Boolean)));
}

function extractBenchmarkCodingScore(payload) {
  const sources = Array.isArray(payload?.data?.sources) ? payload.data.sources : [];
  for (const source of sources) {
    const scores = Array.isArray(source?.scores) ? source.scores : [];
    const codingScore = scores.find((entry) => String(entry?.metric || "").trim().toLowerCase() === "coding_index");
    const numeric = Number(codingScore?.value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

async function fetchCodingScore(model, fetchFn, cache = new Map()) {
  const candidates = normalizeCloudPriceModelCandidates(model);
  if (candidates.length === 0) return null;
  const cacheKey = candidates.join("|").toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    for (const candidate of candidates) {
      try {
        const response = await fetchFn(`https://ai.cloudprice.net/api/v1/models/${encodeURIComponent(candidate)}/benchmarks`, {
          method: "GET",
          headers: { "content-type": "application/json" },
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(7000) : undefined,
        });
        if (!response?.ok) continue;
        const payload = await readJsonResponseSafe(response);
        const score = extractBenchmarkCodingScore(payload);
        if (score != null) return score;
      } catch {
        // try next candidate
      }
    }
    return null;
  })();

  cache.set(cacheKey, promise);
  return promise;
}

function mapProviderToCloudPriceIds(provider) {
  const providerKind = String(provider?.provider || provider?.id || "").trim().toLowerCase();
  if (!providerKind) return [];
  const mappings = {
    deepseek: ["deepseek"],
    openrouter: ["openrouter"],
    qwen: ["alibaba_qwen", "qwen"],
    kimi: ["moonshot", "moonshot_ai", "moonshotai", "kimi"],
    fireworks: ["fireworks", "fireworks_ai"],
    opencode: ["opencode", "opencode_zen", "opencode-go", "opencode_go"],
  };
  return mappings[providerKind] || [providerKind];
}

async function fetchModelPricing(model, fetchFn, cache = new Map()) {
  const candidates = normalizeCloudPriceModelCandidates(model);
  if (candidates.length === 0) return null;
  const cacheKey = candidates.join("|").toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const query = "?tier=standard&input_tokens=1000000&output_tokens=1000000";
    for (const candidate of candidates) {
      try {
        const response = await fetchFn(`https://ai.cloudprice.net/api/v1/models/${encodeURIComponent(candidate)}/pricing/calculate${query}`, {
          method: "GET",
          headers: { "content-type": "application/json" },
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(7000) : undefined,
        });
        if (!response?.ok) continue;
        const payload = await readJsonResponseSafe(response);
        if (payload?.data?.result || Array.isArray(payload?.data?.options)) return payload.data;
      } catch {
        // try next candidate
      }
    }
    return null;
  })();

  cache.set(cacheKey, promise);
  return promise;
}

function pickCurrentPricingOption(options, provider) {
  const providerIds = new Set(mapProviderToCloudPriceIds(provider));
  const matches = (Array.isArray(options) ? options : []).filter((option) => {
    const optionProviderId = String(option?.provider_id || "").trim().toLowerCase();
    return providerIds.has(optionProviderId) && String(option?.tier || "standard").trim().toLowerCase() === "standard";
  });
  if (matches.length === 0) return null;
  matches.sort((left, right) => Number(left?.total_cost || Infinity) - Number(right?.total_cost || Infinity));
  return matches[0];
}

module.exports = {
  readJsonResponseSafe,
  normalizeCloudPriceModelCandidates,
  extractBenchmarkCodingScore,
  fetchCodingScore,
  mapProviderToCloudPriceIds,
  fetchModelPricing,
  pickCurrentPricingOption,
};
```

- [ ] **Step 2: Write `tests/cloudprice-client.test.js`**

```js
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
```

- [ ] **Step 3: Run the new test file**

Run: `node --test tests/cloudprice-client.test.js`
Expected: all tests PASS (this is a brand-new file with no prior dependents, so there's nothing to fail against yet — this step confirms the module itself is correct before Step 4 rewires `cli.js` to depend on it).

- [ ] **Step 4: Rewire `lib/cli.js` to use the shared client and fix the `isFree` bug**

In `lib/cli.js`, add the import near the top (next to other `require("./...")` lines, e.g. after the `provider-benchmark` import at line 26):

```js
const {
  readJsonResponseSafe,
  normalizeCloudPriceModelCandidates,
  extractBenchmarkCodingScore,
  fetchCodingScore,
  mapProviderToCloudPriceIds,
  fetchModelPricing,
  pickCurrentPricingOption,
} = require("./cloudprice-client");
```

Delete these now-duplicated local definitions from `lib/cli.js` (bodies verbatim shown in Step 1 above, now living in `cloudprice-client.js`):
- `readJsonResponseSafe` (lines 1535-1542)
- `normalizeCloudPriceModelCandidates` (lines 1609-1621)
- `extractBenchmarkCodingScore` (lines 1482-1491)
- `mapProviderToCloudPriceIds` (lines 1623-1635)
- `fetchCloudPriceModelPricing` (lines 1689-1716) — replaced by calling the imported `fetchModelPricing`
- `pickCloudPriceCurrentOption` (lines 1663-1672) — replaced by calling the imported `pickCurrentPricingOption`

Replace `fetchProviderCodingInfo` (lines 1493-1525) with a thin wrapper over `fetchCodingScore`:

```js
async function fetchProviderCodingInfo(provider, fetchFn, cache = new Map()) {
  const model = String(provider?.effective_model || provider?.default_model || "").trim();
  if (!model) return { label: "n/a", color: "dim" };
  const score = await fetchCodingScore(model, fetchFn, cache);
  if (score == null) return { label: "n/a", color: "dim" };
  const label = formatCodingScoreLabel(score);
  return { label, color: colorForCodingScore(label) };
}
```

Replace every call site of `fetchCloudPriceModelPricing(...)` with `fetchModelPricing(...)` and every call site of `pickCloudPriceCurrentOption(...)` with `pickCurrentPricingOption(...)` (only call site of each is inside `fetchProviderPriceInfo`). Rewrite `fetchProviderPriceInfo` (lines 1718-1775) to fix the pre-existing `isFree` `ReferenceError` bug (the undefined-variable branch is dead/broken code — a non-free provider whose model can't be resolved on CloudPrice should just fall through to "unavailable", which is what the code already does one branch below):

```js
async function fetchProviderPriceInfo(provider, fetchFn, cache = new Map()) {
  if (provider?.free_model === true) {
    return {
      currentPriceLabel: "free",
      currentPriceColor: "green",
      bestProviderLabel: "free",
      bestProviderColor: "green",
      bestPriceLabel: "free",
      bestPriceColor: "green",
    };
  }
  const model = String(provider?.effective_model || provider?.default_model || "").trim();
  if (!model) {
    return {
      currentPriceLabel: "n/a",
      currentPriceColor: "dim",
      bestProviderLabel: "n/a",
      bestProviderColor: "dim",
      bestPriceLabel: "n/a",
      bestPriceColor: "dim",
    };
  }
  const data = await fetchModelPricing(model, fetchFn, cache);
  if (!data) {
    return {
      currentPriceLabel: "unavailable",
      currentPriceColor: "dim",
      bestProviderLabel: "unavailable",
      bestProviderColor: "dim",
      bestPriceLabel: "unavailable",
      bestPriceColor: "dim",
    };
  }

  const currentOption = pickCurrentPricingOption(data.options, provider);
  const bestProvider = pickCloudPriceBestProvider(data?.result?.providers, provider);
  const currentPriceLabel = currentOption ? formatCloudPriceBreakdownLabel(currentOption) : "n/a";
  const bestProviderLabel = bestProvider ? mapCloudPriceProviderLabel(bestProvider.provider_id) : "n/a";
  const bestPriceLabel = data?.result ? formatCloudPriceBreakdownLabel(data.result) : "n/a";
  return {
    currentPriceLabel,
    currentPriceColor: currentPriceLabel === "n/a" || currentPriceLabel === "unavailable" ? "dim" : "magenta",
    bestProviderLabel,
    bestProviderColor: bestProviderLabel === "n/a" || bestProviderLabel === "unavailable" ? "dim" : "green",
    bestPriceLabel,
    bestPriceColor: bestPriceLabel === "n/a" || bestPriceLabel === "unavailable" ? "dim" : "green",
  };
}
```

`pickCloudPriceBestProvider`, `mapCloudPriceProviderLabel`, `formatCloudPriceBreakdownLabel`, `AVAILABLE_PROVIDER_SPECS`, `formatCodingScoreLabel`, `colorForCodingScore` all stay in `lib/cli.js` unchanged — they're CLI-display-only concerns (the "cheapest alternative provider" feature), not needed by the ranking engine.

- [ ] **Step 5: Run the full existing CLI test suite to confirm no regression**

Run: `node --test tests/cli.test.js`
Expected: all tests PASS (same behavior as before, just re-homed).

- [ ] **Step 6: Commit**

```bash
git add lib/cloudprice-client.js tests/cloudprice-client.test.js lib/cli.js
git commit -m "refactor: extract shared cloudprice.net client from cli.js"
```

---

## Task 2: Criteria parsing for `LLMPROXY_REORDERING`

**Files:**
- Create: `lib/provider-reordering.js` (this task only adds parsing; later tasks append to the same file)
- Create: `tests/provider-reordering.test.js` (this task only adds parsing tests; later tasks append)

**Interfaces:**
- Produces (used by Task 3, 5, 6, 12): `parseReorderingCriteria(value) → string[]` (throws on invalid input), `resolveReorderingCriteria(envSource) → string[]`, `resolveReorderingMinutes(override, envSource) → number`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/provider-reordering.test.js`
Expected: FAIL with `Cannot find module '../lib/provider-reordering'`

- [ ] **Step 3: Write `lib/provider-reordering.js` with the parsing functions**

```js
"use strict";

const VALID_CRITERIA = ["price", "power", "speed"];

function parseReorderingCriteria(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return [];
  const tokens = raw.split("-").map((token) => token.trim()).filter(Boolean);
  const seen = new Set();
  const criteria = [];
  for (const token of tokens) {
    if (!VALID_CRITERIA.includes(token)) {
      throw new Error(`LLMPROXY_REORDERING: criterio non valido "${token}" (ammessi: ${VALID_CRITERIA.join(", ")})`);
    }
    if (seen.has(token)) {
      throw new Error(`LLMPROXY_REORDERING: criterio duplicato "${token}"`);
    }
    seen.add(token);
    criteria.push(token);
  }
  return criteria;
}

function resolveReorderingCriteria(envSource) {
  const source = envSource || process.env;
  return parseReorderingCriteria(source.LLMPROXY_REORDERING);
}

function resolveReorderingMinutes(override, envSource) {
  if (typeof override === "number" && override > 0) return override;
  const source = envSource || process.env;
  const criteria = parseReorderingCriteria(source.LLMPROXY_REORDERING);
  if (criteria.length === 0) return 0;
  const raw = String(source.LLMPROXY_REORDERING_MINUTES || "").trim();
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  return 5;
}

module.exports = {
  VALID_CRITERIA,
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/provider-reordering.test.js`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add lib/provider-reordering.js tests/provider-reordering.test.js
git commit -m "feat: add LLMPROXY_REORDERING criteria parsing"
```

---

## Task 3: Scoring engine (price / power / speed metrics)

**Files:**
- Modify: `lib/provider-reordering.js` (append)
- Modify: `tests/provider-reordering.test.js` (append)

**Interfaces:**
- Consumes: `fetchCodingScore`, `fetchModelPricing`, `pickCurrentPricingOption` from `lib/cloudprice-client.js` (Task 1)
- Produces (used by Task 4, 5): `computeProviderScores(providers, criteria, { fetchFn, probeFn, priceCache, powerCache }) → Promise<Map<string, {price?: number|null, power?: number|null, speed?: number|null}>>` keyed by `provider.id`

- [ ] **Step 1: Write the failing tests**

```js
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
```

Add the `computeProviderScores` import to the top `require` in `tests/provider-reordering.test.js` (extend the existing destructure from Task 2's Step 1 rather than adding a second `require` line):

```js
const {
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
  computeProviderScores,
} = require("../lib/provider-reordering");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/provider-reordering.test.js`
Expected: FAIL — `computeProviderScores is not a function`

- [ ] **Step 3: Append the scoring functions to `lib/provider-reordering.js`**

Add this import at the top of `lib/provider-reordering.js` (below `"use strict";`):

```js
const { fetchCodingScore, fetchModelPricing, pickCurrentPricingOption } = require("./cloudprice-client");
```

Append below `resolveReorderingMinutes`:

```js
function isFreeModelProvider(provider) {
  return provider?.free_model === true;
}

async function fetchPriceMetric(provider, fetchFn, cache) {
  if (isFreeModelProvider(provider)) return 0;
  const model = String(provider?.default_model || "").trim();
  if (!model || typeof fetchFn !== "function") return null;
  const data = await fetchModelPricing(model, fetchFn, cache);
  if (!data) return null;
  const option = pickCurrentPricingOption(data.options, provider);
  const cost = Number(option?.total_cost);
  return Number.isFinite(cost) ? cost : null;
}

async function fetchPowerMetric(provider, fetchFn, cache) {
  const model = String(provider?.default_model || "").trim();
  if (!model || typeof fetchFn !== "function") return null;
  const score = await fetchCodingScore(model, fetchFn, cache);
  return typeof score === "number" ? score : null;
}

async function fetchSpeedMetric(provider, probeFn, fetchFn) {
  if (typeof probeFn !== "function") return null;
  const model = String(provider?.default_model || "").trim();
  const startedAt = Date.now();
  try {
    const result = await probeFn({ provider, model, fetchFn });
    if (!result || (result.ok !== true && result.success !== true)) return null;
    return Date.now() - startedAt;
  } catch {
    return null;
  }
}

async function computeProviderScores(providers, criteria, options = {}) {
  const { fetchFn = fetch, probeFn = null, priceCache = new Map(), powerCache = new Map() } = options;
  const needsPrice = criteria.includes("price");
  const needsPower = criteria.includes("power");
  const needsSpeed = criteria.includes("speed");
  const scores = new Map();
  await Promise.all((Array.isArray(providers) ? providers : []).map(async (provider) => {
    const entry = {};
    if (needsPrice) entry.price = await fetchPriceMetric(provider, fetchFn, priceCache);
    if (needsPower) entry.power = await fetchPowerMetric(provider, fetchFn, powerCache);
    if (needsSpeed) entry.speed = await fetchSpeedMetric(provider, probeFn, fetchFn);
    scores.set(provider.id, entry);
  }));
  return scores;
}
```

Update `module.exports` at the bottom of `lib/provider-reordering.js` to add `isFreeModelProvider, computeProviderScores,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/provider-reordering.test.js`
Expected: PASS (17/17)

- [ ] **Step 5: Commit**

```bash
git add lib/provider-reordering.js tests/provider-reordering.test.js
git commit -m "feat: add price/power/speed scoring to provider-reordering"
```

---

## Task 4: Stable multi-key ranking

**Files:**
- Modify: `lib/provider-reordering.js` (append)
- Modify: `tests/provider-reordering.test.js` (append)

**Interfaces:**
- Consumes: the `Map` shape produced by `computeProviderScores` (Task 3)
- Produces (used by Task 5): `rankProvidersByCriteria(providers, criteria, scores) → Array` (same provider objects, reordered)

- [ ] **Step 1: Write the failing tests**

```js
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
```

Extend the `require` destructure in `tests/provider-reordering.test.js` with `rankProvidersByCriteria`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/provider-reordering.test.js`
Expected: FAIL — `rankProvidersByCriteria is not a function`

- [ ] **Step 3: Append the ranking function to `lib/provider-reordering.js`**

```js
const CRITERION_DIRECTIONS = { price: "asc", power: "desc", speed: "asc" };

function rankProvidersByCriteria(providers, criteria, scores) {
  const list = Array.isArray(providers) ? providers : [];
  if (list.length <= 1 || !Array.isArray(criteria) || criteria.length === 0) {
    return list.slice();
  }
  const indexed = list.map((provider, index) => ({ provider, index }));
  indexed.sort((a, b) => {
    for (const criterion of criteria) {
      const direction = CRITERION_DIRECTIONS[criterion];
      const rawA = scores.get(a.provider.id)?.[criterion];
      const rawB = scores.get(b.provider.id)?.[criterion];
      const valueA = rawA == null ? Number.POSITIVE_INFINITY : (direction === "desc" ? -rawA : rawA);
      const valueB = rawB == null ? Number.POSITIVE_INFINITY : (direction === "desc" ? -rawB : rawB);
      if (valueA !== valueB) return valueA - valueB;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.provider);
}
```

Update `module.exports` to add `rankProvidersByCriteria,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/provider-reordering.test.js`
Expected: PASS (24/24)

- [ ] **Step 5: Commit**

```bash
git add lib/provider-reordering.js tests/provider-reordering.test.js
git commit -m "feat: add stable multi-key provider ranking"
```

---

## Task 5: Persistence, real speed probe, and scheduling

**Files:**
- Modify: `lib/provider-reordering.js` (append)
- Modify: `tests/provider-reordering.test.js` (append)

**Interfaces:**
- Consumes: `rankProvidersByCriteria`, `computeProviderScores`, `resolveReorderingCriteria`, `resolveReorderingMinutes` (this file, Tasks 2-4); `tokenStore.listProviders()` and `tokenStore.setProviderOrder(string[])` (see design doc section 3 — synchronous, `setProviderOrder` takes provider ids)
- Produces (used by Task 6 and Task 12): `createProviderReordering({ tokenStore, filePath, fetchFn, probeFn }) → { runCycle, start, stop, getStore, getLastResult, filePath }`, `buildDefaultProbeFn() → probeFn`, `readReorderingStore(filePath)`, `writeReorderingStore(filePath, store)`, `DEFAULT_REORDERING_FILE`

- [ ] **Step 1: Write the failing tests**

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
```

Extend the `require` destructure in `tests/provider-reordering.test.js` with `createProviderReordering, readReorderingStore, buildDefaultProbeFn`, and add `const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");` near the top of the test file (alongside the existing `node:test`/`node:assert/strict` requires).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/provider-reordering.test.js`
Expected: FAIL — `createProviderReordering is not a function`

- [ ] **Step 3: Append persistence, probe, and scheduling to `lib/provider-reordering.js`**

Add these two imports at the top of `lib/provider-reordering.js`, alongside the existing `cloudprice-client` require:

```js
const fs = require("node:fs");
const path = require("node:path");
```

Append below `rankProvidersByCriteria`:

```js
const DEFAULT_REORDERING_FILE = "provider-reordering.json";

function readReorderingStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { criteria: [], order: [], scores: {}, lastUpdatedMs: 0 };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { criteria: [], order: [], scores: {}, lastUpdatedMs: 0 };
    return {
      criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
      order: Array.isArray(parsed.order) ? parsed.order : [],
      scores: parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {},
      lastUpdatedMs: Number(parsed.lastUpdatedMs) || 0,
    };
  } catch {
    return { criteria: [], order: [], scores: {}, lastUpdatedMs: 0 };
  }
}

function writeReorderingStore(filePath, store) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  } catch {
    // best effort
  }
}

const PROBE_ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  zai: "https://api.z.ai/api/paas/v4/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  opencode: "https://opencode.ai/zen/v1/chat/completions",
  "opencode-go": "https://opencode.ai/zen/go/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
  perplexity: "https://api.perplexity.ai/chat/completions",
  together: "https://api.together.xyz/v1/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  commandcode: "https://api.commandcode.ai/provider/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
};

function resolveProbeEndpoint(provider) {
  const pType = (provider.provider || "").toLowerCase();
  if (pType === "copilot") return "https://api.githubcopilot.com/chat/completions";
  return PROBE_ENDPOINTS[pType] || null;
}

function buildDefaultProbeFn() {
  return async ({ provider, model, fetchFn }) => {
    const pType = (provider.provider || "").toLowerCase();
    const isAnthropic = pType === "anthropic" || pType === "opencode-go";
    const url = resolveProbeEndpoint(provider);
    if (!url) return { ok: false };

    const proxyFetch = (() => {
      if (!provider.proxy_url) return fetchFn;
      try {
        const { ProxyAgent } = require("undici");
        const agent = new ProxyAgent(provider.proxy_url);
        return (u, opts = {}) => fetchFn(u, { ...opts, dispatcher: agent });
      } catch {
        return fetchFn;
      }
    })();

    const body = JSON.stringify(isAnthropic
      ? { model: model || "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }
      : { model: model || "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    const headers = isAnthropic
      ? { "Content-Type": "application/json", "x-api-key": provider.access_token || "", "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${provider.access_token || ""}` };
    try {
      const res = await proxyFetch(url, { method: "POST", headers, body });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  };
}

function createProviderReordering({ tokenStore, filePath, fetchFn = fetch, probeFn = null } = {}) {
  if (!tokenStore) throw new Error("provider-reordering tokenStore required");
  if (!filePath) throw new Error("provider-reordering filePath required");
  let intervalHandle = null;

  function getStore() {
    return readReorderingStore(filePath);
  }

  function getLastResult() {
    return getStore();
  }

  async function runCycle(envSource) {
    const criteria = resolveReorderingCriteria(envSource);
    if (criteria.length === 0) return null;
    const providers = (typeof tokenStore.listProviders === "function" ? tokenStore.listProviders() : [])
      .filter((provider) => provider && provider.access_token);
    if (providers.length === 0) return null;

    const scores = await computeProviderScores(providers, criteria, { fetchFn, probeFn });
    const ranked = rankProvidersByCriteria(providers, criteria, scores);
    const order = ranked.map((provider) => provider.id);
    tokenStore.setProviderOrder(order);

    const store = {
      criteria,
      order,
      scores: Object.fromEntries(providers.map((provider) => [provider.id, scores.get(provider.id) || {}])),
      lastUpdatedMs: Date.now(),
    };
    writeReorderingStore(filePath, store);
    return store;
  }

  function start(_unusedProvidersHint, envSource) {
    const minutes = resolveReorderingMinutes(null, envSource);
    if (!minutes) return;
    if (intervalHandle) return;
    const tick = () => {
      runCycle(envSource).catch(() => null);
    };
    tick();
    intervalHandle = setInterval(tick, minutes * 60 * 1000);
    if (intervalHandle && typeof intervalHandle.unref === "function") intervalHandle.unref();
  }

  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  return { filePath, getStore, getLastResult, runCycle, start, stop };
}
```

Update `module.exports` at the bottom of `lib/provider-reordering.js` to its final full form:

```js
module.exports = {
  VALID_CRITERIA,
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
  isFreeModelProvider,
  computeProviderScores,
  rankProvidersByCriteria,
  createProviderReordering,
  buildDefaultProbeFn,
  readReorderingStore,
  writeReorderingStore,
  DEFAULT_REORDERING_FILE,
};
```

Note: `start()`'s first parameter is intentionally unused (kept only so callers can pass `null` positionally without an error) — unlike the old `provider-benchmark.js`, this module always re-reads `tokenStore.listProviders()` fresh inside `runCycle()`, which is what makes `LLMPROXY_REORDERING` genuinely hot-reloadable (see design doc's "Hot-reload scope" note).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/provider-reordering.test.js`
Expected: PASS (33/33)

- [ ] **Step 5: Commit**

```bash
git add lib/provider-reordering.js tests/provider-reordering.test.js
git commit -m "feat: add persistence, real speed probe, and scheduling to provider-reordering"
```

---

## Task 6: Wire into `lib/app.js` (server startup + REST endpoint)

**Files:**
- Modify: `lib/app.js:180` (import), `lib/app.js:209-281` (startup wiring inside `startServer()`), `lib/app.js:630-636` (add new REST route near `/api/providers/order`), `lib/app.js:122-123` (remove `pricePerformanceRouting`/`pricePerformanceTieBreaker` passthrough in `handleMessages`)

**Interfaces:**
- Consumes: `createProviderReordering`, `buildDefaultProbeFn`, `DEFAULT_REORDERING_FILE` from `lib/provider-reordering.js` (Task 5)

- [ ] **Step 1: Replace the `provider-benchmark` import**

In `lib/app.js:180`, replace:

```js
const { createProviderBenchmark, resolveBenchmarkMinutes } = require("./provider-benchmark");
```

with:

```js
const { createProviderReordering, buildDefaultProbeFn, DEFAULT_REORDERING_FILE } = require("./provider-reordering");
```

- [ ] **Step 2: Replace the benchmark wiring block in `startServer()`**

In `lib/app.js`, replace the entire block from `const benchmarkMinutes = resolveBenchmarkMinutes(null, runtimeEnv);` through the closing `}` of the `if (benchmarkMinutes > 0 && options.tokenStore) { ... }` block (lines 210-281 per the current file) with:

```js
  if (options.tokenStore) {
    try {
      const reordering = createProviderReordering({
        filePath: path.join(options.dataRoot || paths?.dataRoot || require("./paths").createPaths().dataRoot, DEFAULT_REORDERING_FILE),
        tokenStore: options.tokenStore,
        fetchFn: options.fetchFn || fetch,
        probeFn: buildDefaultProbeFn(),
      });
      reordering.start(null, runtimeEnv);
      options.tokenStore.__llmproxyProviderReordering = reordering;
    } catch {
      // best effort: automatic reordering is non-critical
    }
  }
```

This preserves the exact `dataRoot` resolution fallback chain the old benchmark block used, and the same `__llmproxy...` side-channel pattern (renamed to `__llmproxyProviderReordering`) that `cli.js`'s `provider:list` reads back when running as a separate CLI process (rewired in Task 12).

- [ ] **Step 3: Remove `pricePerformanceRouting`/`pricePerformanceTieBreaker` from the `handleMessages` → `executeGatewayRequest` call**

In `lib/app.js`, inside `handleMessages`, delete these two lines from the `executeGatewayRequest({...})` call (currently lines 122-123):

```js
        pricePerformanceRouting: projectSettings.pricePerformanceRouting,
        pricePerformanceTieBreaker: projectSettings.pricePerformanceTieBreaker,
```

- [ ] **Step 4: Add a REST endpoint to force an immediate cycle**

In `lib/app.js`, immediately after the existing `/api/providers/order` route (around line 636), add:

```js

  app.post("/api/providers/reorder", async (_req, res) => {
    const result = await executeCliCommand(["provider:reorder"]);
    const response = jsonFromCliResult(result, "provider:reorder");
    res.status(response.status).json(response.payload);
  });
```

This follows the exact same `executeCliCommand`/`jsonFromCliResult` pattern already used by every other `/api/providers/*` route in this file — it shells out in-process to the `provider:reorder` CLI command added in Task 12, so this route has no real logic of its own to test independently (it's exercised end-to-end by the REST test added in Task 13).

- [ ] **Step 5: Run the app test suite**

Run: `node --test tests/app.test.js`
Expected: some tests still FAIL at this point — the 4 escalation/price-performance tests (lines 375, 458, 550, 646) and the `escalationTracker` import at line 20 reference code this plan removes in Task 9. That is expected; Task 13 rewrites those tests. Confirm here only that the file **starts up and runs** without a module-load crash (i.e. failures are assertion failures in the flagged tests, not `Cannot find module` errors for `provider-reordering` or `app.js` itself).

- [ ] **Step 6: Commit**

```bash
git add lib/app.js
git commit -m "feat: wire provider-reordering into server startup and REST API"
```

---

## Task 7: Update `lib/configuration.js` (CONFIG_SPECS, defaults, legacy cleanup)

**Files:**
- Modify: `lib/configuration.js:7-50` (`CONFIG_SPECS`), `lib/configuration.js:53-83` (`LEGACY_PROJECT_ENV_KEYS_TO_REMOVE`), `lib/configuration.js:225-256` (`getProjectDefaultValues`)
- Modify: `tests/configuration.test.js:73-84`, `tests/configuration.test.js:316-330`, `tests/configuration.test.js:345-375`

- [ ] **Step 1: Update `CONFIG_SPECS`**

In `lib/configuration.js`, delete these 3 lines from the project-scope block:

```js
  { key: "LLMPROXY_AUTO_ESCALATE",              scope: "project", restartRequired: false, hotReloadable: true },
```
```js
  { key: "LLMPROXY_PRICE_PERFORMANCE_ROUTING",  scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER", scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_PROVIDER_BENCHMARK_MINUTES", scope: "project", restartRequired: false, hotReloadable: true, defaultValue: "0" },
```

Add these 2 lines to the **service-scope, requires-restart** block (right after `{ key: "LLMPROXY_HOME", ... }`, before the `DBLAYER_URL`/`EVENTBUS_URL` hot-reloadable service block):

```js
  { key: "LLMPROXY_REORDERING_MINUTES",         scope: "service", restartRequired: true, hotReloadable: false },
```

Add this 1 line to the **service-scope, hot-reloadable** block (alongside `DBLAYER_URL`/`EVENTBUS_URL`):

```js
  { key: "LLMPROXY_REORDERING",                 scope: "service", restartRequired: false, hotReloadable: true },
```

(`LLMPROXY_REORDERING` is hot-reloadable because `provider-reordering.js`'s `runCycle()` re-reads it fresh every tick; `LLMPROXY_REORDERING_MINUTES` requires a restart because the `setInterval` period is fixed when `start()` runs at server boot — see design doc's "Hot-reload scope" note.)

- [ ] **Step 2: Add the 4 old vars to `LEGACY_PROJECT_ENV_KEYS_TO_REMOVE`**

In `lib/configuration.js`, change:

```js
const LEGACY_PROJECT_ENV_KEYS_TO_REMOVE = Object.freeze([
  "LLMPROXY_SMART_ROUTE",
  "LLMPROXY_SMART_PREFERENCE",
  "BRAVE_API_KEY",
]);
```

to:

```js
const LEGACY_PROJECT_ENV_KEYS_TO_REMOVE = Object.freeze([
  "LLMPROXY_SMART_ROUTE",
  "LLMPROXY_SMART_PREFERENCE",
  "LLMPROXY_AUTO_ESCALATE",
  "LLMPROXY_PRICE_PERFORMANCE_ROUTING",
  "LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER",
  "LLMPROXY_PROVIDER_BENCHMARK_MINUTES",
  "BRAVE_API_KEY",
]);
```

Leave `LEGACY_SERVICE_ENV_KEYS_TO_REMOVE` untouched — none of the 4 old vars were ever service-scope.

- [ ] **Step 3: Remove the 4 old vars from `getProjectDefaultValues()`**

In `lib/configuration.js`, inside `getProjectDefaultValues()`, delete:

```js
    LLMPROXY_AUTO_ESCALATE: "1",
```

and

```js
    LLMPROXY_PRICE_PERFORMANCE_ROUTING: "1",
    LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER: "power",
```

(There was never a `LLMPROXY_PROVIDER_BENCHMARK_MINUTES` line in `getProjectDefaultValues()` to remove — confirmed by research, it only had the inline `defaultValue: "0"` in `CONFIG_SPECS`, already deleted in Step 1.) Do not add `LLMPROXY_REORDERING`/`LLMPROXY_REORDERING_MINUTES` here — they are service-scope now, so they don't belong in project defaults, and their real defaults (absent = disabled; 5 minutes only when criteria are set) are conditional logic that `resolveReorderingMinutes()` already handles, not a flat default value this function models.

- [ ] **Step 4: Update `tests/configuration.test.js`**

Replace the test at lines 73-84 (`"getConfigSpec exposes price/performance routing project variables"`) with:

```js
test("getConfigSpec exposes the reordering service variables", () => {
  const reorderingSpec = getConfigSpec("LLMPROXY_REORDERING");
  const minutesSpec = getConfigSpec("LLMPROXY_REORDERING_MINUTES");
  const meteringInlineSpec = getConfigSpec("LLMPROXY_METERING_INLINE");
  assert.equal(reorderingSpec.scope, "service");
  assert.equal(reorderingSpec.hotReloadable, true);
  assert.equal(reorderingSpec.restartRequired, false);
  assert.equal(minutesSpec.scope, "service");
  assert.equal(minutesSpec.restartRequired, true);
  assert.equal(meteringInlineSpec.scope, "project");
});
```

In the test at lines 316-330 (`"getProjectDefaultValues returns llmproxy project defaults"`), delete these 3 assertion lines:

```js
  assert.equal(defaults.LLMPROXY_AUTO_ESCALATE, "1");
```
```js
  assert.equal(defaults.LLMPROXY_PRICE_PERFORMANCE_ROUTING, "1");
  assert.equal(defaults.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER, "power");
```

In the test at lines 345-375 (`"normalizeClaudeSettingsConfig removes legacy project variables and injects current llmproxy defaults"`), add `LLMPROXY_AUTO_ESCALATE: "1",` and `LLMPROXY_PRICE_PERFORMANCE_ROUTING: "1",` to the input `env` fixture object (alongside the existing `LLMPROXY_SMART_ROUTE: "hybrid",`), and replace these two assertion lines:

```js
  assert.equal(normalized.env.LLMPROXY_PRICE_PERFORMANCE_ROUTING, "1");
  assert.equal(normalized.env.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER, "power");
```

with:

```js
  assert.equal("LLMPROXY_AUTO_ESCALATE" in normalized.env, false);
  assert.equal("LLMPROXY_PRICE_PERFORMANCE_ROUTING" in normalized.env, false);
```

(this now proves the legacy-removal path strips the old vars, mirroring the existing `LLMPROXY_SMART_ROUTE` assertion right below it, rather than proving injected defaults that no longer exist).

- [ ] **Step 5: Run the configuration test suite**

Run: `node --test tests/configuration.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/configuration.js tests/configuration.test.js
git commit -m "feat: replace old routing/benchmark CONFIG_SPECS with LLMPROXY_REORDERING"
```

---

## Task 8: Simplify `lib/copilot-proxy.js`

**Files:**
- Modify: `lib/copilot-proxy.js:1,11,14-19` (imports/instantiation), `lib/copilot-proxy.js:238-357` (dead functions), `lib/copilot-proxy.js:359-382` (`prioritizeProvider`), `lib/copilot-proxy.js:1004-1027` (`getLastUserMessageText`, `buildEscalationConversationKey`), `lib/copilot-proxy.js:1810-1815` (options destructure), `lib/copilot-proxy.js:1926-1959` (runtime application), `lib/copilot-proxy.js:2588-2615` (`module.exports`)

- [ ] **Step 1: Remove the `escalation-tracker` import and instantiation**

Delete line 1:

```js
const { EscalationTracker } = require("./escalation-tracker");
```

Delete lines 14-19:

```js
const escalationTracker = new EscalationTracker({
  enabled: (() => {
    const raw = String(process.env.LLMPROXY_AUTO_ESCALATE || "").trim();
    return raw === "true" || raw === "1";
  })(),
});
```

- [ ] **Step 2: Remove the now-unused `model-capabilities` scoring imports**

Change line 11 from:

```js
const { getEstimatedCost, getPowerScore, getSpeedScore } = require("./model-capabilities");
```

Delete this line entirely — none of `getEstimatedCost`/`getPowerScore`/`getSpeedScore` are used anywhere else in this file once Step 3 removes their only callers.

- [ ] **Step 3: Delete the dead routing/escalation/smart-router functions**

Delete the following functions from `lib/copilot-proxy.js` in their entirety (verbatim bodies are in the design doc / research above — this step just removes them): `isFreeModelProvider` (238-240), `resolvePricePerformanceRoutingEnabled` (251-254), `resolvePricePerformanceTieBreaker` (256-262), `estimateProviderRelativeCost` (264-271), `getProviderPowerScore` (273-276), `getProviderSpeedScore` (278-281), `selectEscalatedProviderIndex` (283-289), `shouldSuppressEscalation` (291-310, including its doc comment), `buildPricePerformanceSelectionReason` (312-317), `rankProvidersByPricePerformance` (319-357), `prioritizeProvider` (359-382).

Keep `parseBooleanLike` (242-249) — it's a generic helper still used elsewhere in the file (e.g. `isMeteringInlineEnabled`, `isCreditInlineEnabled`).

- [ ] **Step 4: Delete the escalation-only message helpers**

Delete `getLastUserMessageText` (1004-1021, including its doc comment) and `buildEscalationConversationKey` (1023-1027) — both are exclusively used by the escalation block removed in Step 5, confirmed by grep (no other call sites in this file).

- [ ] **Step 5: Simplify the runtime request path**

In the options destructure (around line 1810), delete these 3 lines:

```js
    smartRouteInfo = null,
```
```js
    pricePerformanceRouting = null,
    pricePerformanceTieBreaker = null,
```

Replace the block from `const smartRouteProviderId = ...` through the end of the auto-escalation `if (escalationTracker.enabled) { ... }` block (currently lines 1926-1959) with just:

```js
  let runtimeSelectionReason = null;
```

(This one line replaces roughly 34 lines: the smart-router branch, the price/performance-routing branch, and the entire auto-escalation block. `runtimeSelectionReason` stays — `buildSelectionReason` still uses it as an optional preferred-reason override later in the function, it will now simply always be `null`, which `buildSelectionReason`'s existing `preferredReason = null` default already handles correctly.)

- [ ] **Step 6: Update `module.exports`**

Remove `getLastUserMessageText,`, `escalationTracker,`, `isFreeModelProvider,`, `selectEscalatedProviderIndex,`, `shouldSuppressEscalation,` from the `module.exports` object (lines 2588-2615). The final export list should read:

```js
module.exports = {
  proxyAnthropicRequest,
  buildCopilotHeaders,
  shouldFallbackToNextProvider,
  isContextLimitError,
  trimOldestNonSystemMessage,
  API_KEY_PROVIDER_CONFIGS,
  parseProviderModelPreferences,
  probeApiKeyProviderModel,
  getApiKeyProviderRequestUrls,
  normalizeQwenEndpointVariant,
  sanitizeSchemaForMoonshot,
  sanitizeToolsForMoonshot,
  isVisionCapableModel,
  VISION_CAPABLE_PROVIDERS,
  sanitizeVisionContent,
  buildSelectionReason,
  hasImageInOpenAiMessages,
  hasImageInLastUserMessage,
  handleStreaming,
  consumeMinimaxToolCallBuffer,
  makeProxyFetch,
};
```

- [ ] **Step 7: Run a syntax/load check**

Run: `node -e "require('./lib/copilot-proxy.js'); console.log('loads OK')"`
Expected: prints `loads OK` (confirms no leftover reference to a deleted identifier causes a `ReferenceError` at module-load time). Full test-suite verification happens in Task 9 (which also deletes the tests exercising the now-removed exports) and Task 13.

- [ ] **Step 8: Commit**

```bash
git add lib/copilot-proxy.js
git commit -m "refactor: remove escalation/price-performance/smart-router logic from copilot-proxy"
```

---

## Task 9: Delete dead modules and their tests

**Files:**
- Delete: `lib/escalation-tracker.js`, `lib/provider-benchmark.js`, `tests/escalation-tracker.test.js`
- Modify: `tests/copilot-proxy.test.js:695-712`

- [ ] **Step 1: Delete `lib/escalation-tracker.js` and its dedicated test file**

Confirmed safe by research: `lib/escalation-tracker.js`'s only code importer was `lib/copilot-proxy.js`, already removed in Task 8.

`lib/provider-benchmark.js` is **not** deleted in this task — `lib/cli.js` still imports it until Task 12 rewires that import, so deleting it here would break `tests/cli.test.js` in the interim. Its deletion is Task 12 Step 4, after the import swap.

```bash
rm lib/escalation-tracker.js tests/escalation-tracker.test.js
```

- [ ] **Step 2: Remove the escalation tests from `tests/copilot-proxy.test.js`**

Delete lines 695-712 (both `test("selectEscalatedProviderIndex ...")` blocks shown below) from `tests/copilot-proxy.test.js`:

```js
test("selectEscalatedProviderIndex returns next index when providers[0] is free but ALL providers are free", () => {
  const { selectEscalatedProviderIndex, isFreeModelProvider } = require("../lib/copilot-proxy");
  const providers = [
    { id: "a", free_model: true },
    { id: "b", free_model: true },
    { id: "c", free_model: true },
  ];
  assert.equal(isFreeModelProvider(providers[0]), true);
  assert.equal(selectEscalatedProviderIndex(providers, 1), 1);
  assert.equal(selectEscalatedProviderIndex(providers, 2), 2);
});

test("selectEscalatedProviderIndex preserves single provider early-return", () => {
  const { selectEscalatedProviderIndex } = require("../lib/copilot-proxy");
  assert.equal(selectEscalatedProviderIndex([{ id: "only", free_model: true }], 1), -1);
  assert.equal(selectEscalatedProviderIndex([{ id: "a" }, { id: "b" }], 0), -1);
});
```

- [ ] **Step 3: Run the copilot-proxy test suite**

Run: `node --test tests/copilot-proxy.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -u lib/escalation-tracker.js tests/escalation-tracker.test.js tests/copilot-proxy.test.js
git commit -m "chore: delete escalation-tracker module and its tests"
```

---

## Task 10: Update `lib/project-context.js` (drop per-project price/performance settings)

**Files:**
- Modify: `lib/project-context.js:149-153` (`parsePricePerformanceTieBreaker`, delete), `lib/project-context.js` (all 5 return sites inside `resolveClaudeProjectSettings`), `lib/project-context.js` (the two `const pricePerformance... =` lines)
- Modify: `tests/project-context.test.js:357-377`

- [ ] **Step 1: Delete `parsePricePerformanceTieBreaker`**

Delete the function (lines 149-153):

```js
function parsePricePerformanceTieBreaker(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "power" || normalized === "speed") return normalized;
  return "power";
}
```

- [ ] **Step 2: Delete the two computed values**

Delete these two lines (near the other `env.LLMPROXY_*` reads inside `resolveClaudeProjectSettings`):

```js
      const pricePerformanceRouting = parseBooleanLike(env.LLMPROXY_PRICE_PERFORMANCE_ROUTING);
      const pricePerformanceTieBreaker = parsePricePerformanceTieBreaker(env.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER);
```

- [ ] **Step 3: Remove `pricePerformanceRouting`/`pricePerformanceTieBreaker` from every returned object**

`resolveClaudeProjectSettings` has 5 return sites that each end with these two keys: the early "no project path" return, and 4 more inside/after the directory-walking loop. In **every one of the 5**, delete these two lines:

```js
      pricePerformanceRouting: null,
      pricePerformanceTieBreaker: "power",
```

(or, in the 4 loop-body returns, the non-null variable form:)

```js
          pricePerformanceRouting,
          pricePerformanceTieBreaker,
```

After this step, `resolveClaudeProjectSettings` no longer returns these two fields under any code path — confirmed necessary because Task 6 already stopped `lib/app.js` from reading `projectSettings.pricePerformanceRouting`/`projectSettings.pricePerformanceTieBreaker`.

- [ ] **Step 4: Delete the obsolete test**

Delete the entire test at lines 357-377 in `tests/project-context.test.js`:

```js
test("resolveClaudeProjectSettings reads price/performance routing preferences from Claude env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-price-performance-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "src");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_PRICE_PERFORMANCE_ROUTING: "1",
      LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER: "speed",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.pricePerformanceRouting, true);
  assert.equal(result.pricePerformanceTieBreaker, "speed");
});
```

- [ ] **Step 5: Run the project-context test suite**

Run: `node --test tests/project-context.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/project-context.js tests/project-context.test.js
git commit -m "refactor: remove per-project price/performance settings"
```

---

## Task 11: Remove dead smart-router plumbing (`llm-transport.ts`, `findBestModel`)

**Files:**
- Modify: `src/gateway/services/llm-transport.ts` (interface fields + passthrough call)
- Modify: `lib/model-capabilities.js` (delete `findBestModel`)
- Modify: `tests/model-capabilities.test.js:10,76-151`
- Rebuild: `lib/ts-build/gateway/services/llm-transport.js` via `npm run build:ts`

- [ ] **Step 1: Remove `pricePerformanceRouting`/`pricePerformanceTieBreaker`/`smartRouteInfo` from the TS interface**

In `src/gateway/services/llm-transport.ts`, delete these 3 lines from the params interface (around lines 90-98):

```ts
  pricePerformanceRouting?: boolean | null;
  pricePerformanceTieBreaker?: string | null;
```
```ts
  smartRouteInfo?: Record<string, unknown> | null;
```

- [ ] **Step 2: Remove the same 3 fields from the passthrough call**

In the same file, delete these 3 lines from the call into `proxyAnthropicRequest` (around lines 254-266):

```ts
    pricePerformanceRouting: params.pricePerformanceRouting,
    pricePerformanceTieBreaker: params.pricePerformanceTieBreaker,
```
```ts
    smartRouteInfo: params.smartRouteInfo,
```

- [ ] **Step 3: Rebuild the compiled JS output**

Run: `npm run build:ts`
Expected: succeeds, regenerates `lib/ts-build/gateway/services/llm-transport.js` without the 3 removed fields.

- [ ] **Step 4: Delete `findBestModel` from `lib/model-capabilities.js`**

Delete the `findBestModel` function (lines 147-216) and remove `findBestModel,` from the `module.exports` object at the bottom of the file. Keep `MODEL_TIERS`, `MODEL_CAPABILITIES`, `MODEL_CAPABILITY_OVERRIDES`, `getCapabilities`, `getTierForModel`, `getEstimatedCost`, `getPowerScore`, `getSpeedScore` — all still used elsewhere (`getEstimatedCost`/`getPowerScore`/`getSpeedScore` remain exported for any external consumer even though `copilot-proxy.js` no longer calls them internally after Task 8; they're general-purpose model-metadata utilities, not routing-specific).

- [ ] **Step 5: Delete the `findBestModel` test block**

In `tests/model-capabilities.test.js`, remove `findBestModel,` from the top `require("../lib/model-capabilities")` destructure (line 10), and delete the entire `describe("findBestModel", () => { ... });` block (lines 76-151, 7 `it()` cases). Leave the following `describe("MODEL_TIERS", ...)` block untouched.

- [ ] **Step 6: Run the affected test suites**

Run: `node --test tests/model-capabilities.test.js`
Expected: PASS

Run: `node --test tests/llm-transport.test.js`
Expected: PASS (confirmed by research: no test in this repo asserts on `smartRouteInfo` or `pricePerformanceRouting`/`pricePerformanceTieBreaker` directly — the only other file referencing either name is `tests/project-context.test.js`, already handled in Task 10 — so this run should be a clean pass with no assertions to update).

- [ ] **Step 7: Commit**

```bash
git add src/gateway/services/llm-transport.ts lib/ts-build/gateway/services/llm-transport.js lib/model-capabilities.js tests/model-capabilities.test.js
git commit -m "refactor: remove dead smart-router plumbing and findBestModel"
```

---

## Task 12: `provider:reorder` CLI command + `provider:list` display + finish deleting `provider-benchmark.js`

**Files:**
- Modify: `lib/cli.js` (import swap, `provider:list` handler, 4 new-command registration points, `proxyEnv` defaults block)
- Delete: `lib/provider-benchmark.js` (deferred from Task 9 — see Task 9 Step 1 note)
- Modify: `tests/cli.test.js` (new tests for `provider:reorder`, updated `provider:list` assertions if any reference `benchmark_info`)

- [ ] **Step 1: Swap the `provider-benchmark` import for `provider-reordering`**

In `lib/cli.js`, replace:

```js
const { createProviderBenchmark, readBenchmarkStore, resolveBenchmarkMinutes, DEFAULT_BENCHMARK_FILE } = require("./provider-benchmark");
```

with:

```js
const { createProviderReordering, readReorderingStore, buildDefaultProbeFn, DEFAULT_REORDERING_FILE } = require("./provider-reordering");
```

- [ ] **Step 2: Update the `provider:list` handler**

Replace the `benchmarkCache` construction and the `providersWithCredit` mapping inside the `provider:list` handler with:

```js
  if (parsed.command === "provider:list") {
    const providers = providerStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato.\n");
      return 0;
    }
    const projectSettings = resolveClaudeProjectSettings(path.resolve(String(options.cwd || process.cwd())));
    const effectiveProviders = resolveEffectiveProviderList(providers, projectSettings.configuredModel);
    const creditCache = new Map();
    const priceCache = new Map();
    const codingCache = new Map();
    const reorderingCache = providerStore.__llmproxyProviderReordering
      ? providerStore.__llmproxyProviderReordering
      : (() => {
          const storePath = path.join(paths.dataRoot, DEFAULT_REORDERING_FILE);
          const store = readReorderingStore(storePath);
          return { getStore: () => store };
        })();
    const reorderingStore = reorderingCache.getStore();
    const providersWithCredit = await Promise.all(
      effectiveProviders.providers.map(async (provider) => ({
        ...provider,
        coding_info: await fetchProviderCodingInfo(provider, fetchFn, codingCache),
        credit_info: await fetchProviderCreditInfo(provider, fetchFn, creditCache),
        price_info: await fetchProviderPriceInfo(provider, fetchFn, priceCache),
        reorder_info: reorderingStore.scores?.[provider.id] || null,
      })),
    );
    if (effectiveProviders.projectOverrideActive) {
      stdout.write(`Provider effettivi per il progetto (override: ${effectiveProviders.configuredModel}):\n`);
    }
    if (reorderingStore.criteria.length > 0) {
      const ageMinutes = reorderingStore.lastUpdatedMs ? Math.round((Date.now() - reorderingStore.lastUpdatedMs) / 60000) : null;
      stdout.write(`reorder=${reorderingStore.criteria.join(">")}${ageMinutes != null ? ` (ultimo: ${ageMinutes}m fa)` : ""}\n`);
    }
    stdout.write(`${formatProviderList(providersWithCredit, { stdout, env, creditInline: projectSettings.creditInline })}\n`);
    return 0;
  }
```

`formatProviderList` (not modified in this plan — out of scope for a pure text-table formatting tweak) will render `reorder_info` however it currently renders unknown extra fields; if it needs an explicit `speed=` column, that's a follow-up cosmetic change, not required for the reordering mechanism itself to work end-to-end.

- [ ] **Step 3: Add the `provider:reorder` command — 4 registration points**

**3a. Short alias** — in `SHORT_COMMAND_ALIASES`, add next to the existing `"p:o": "provider:order",` entry:

```js
  "p:ro": "provider:reorder",
```

**3b. Help table entry** — add next to the existing `"provider:order"` entry:

```js
  "provider:reorder": {
    usage: "llmproxy provider:reorder",
    description: "Forza subito un ciclo di reordering automatico (price/power/speed) senza aspettare il timer.",
    when: "Usalo dopo aver cambiato LLMPROXY_REORDERING, o quando vuoi un ordine aggiornato subito.",
    example: "llmproxy provider:reorder",
  },
```

**3c. HTTP request builder case** — add next to the existing `case "provider:order":`:

```js
      case "provider:reorder":
        return {
          method: "POST",
          path: "/api/providers/reorder",
          headers,
          body: {},
        };
```

**3d. Local execution handler** — add next to the existing `if (parsed.command === "provider:order") { ... }` block:

```js
  if (parsed.command === "provider:reorder") {
    const reordering = createProviderReordering({
      tokenStore: providerStore,
      filePath: path.join(paths.dataRoot, DEFAULT_REORDERING_FILE),
      fetchFn,
      probeFn: buildDefaultProbeFn(),
    });
    const result = await reordering.runCycle(env);
    if (!result) {
      stdout.write("LLMPROXY_REORDERING non configurata (o vuota): nessun reordering automatico da eseguire.\n");
      return 0;
    }
    stdout.write(`Criteri: ${result.criteria.join(">")}\n`);
    stdout.write(`Nuovo ordine provider: ${result.order.join(", ")}\n`);
    for (const providerId of result.order) {
      const score = result.scores[providerId] || {};
      const parts = Object.entries(score).map(([key, value]) => `${key}=${value == null ? "n/a" : value}`);
      stdout.write(`  ${providerId}: ${parts.join(" ")}\n`);
    }
    return 0;
  }
```

- [ ] **Step 4: Delete `lib/provider-benchmark.js`**

Now that Steps 1-2 removed the last two importers (`lib/app.js` was already rewired in Task 6; `lib/cli.js` is rewired as of Step 1 above), delete the file:

```bash
rm lib/provider-benchmark.js
```

- [ ] **Step 5: Update the duplicated `proxyEnv` defaults block**

In `lib/cli.js` (the `proxyEnv` object built for `claude:setup`, currently around lines 705-726), delete:

```js
    LLMPROXY_AUTO_ESCALATE: "1",
```

and

```js
    LLMPROXY_PRICE_PERFORMANCE_ROUTING: "1",
    LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER: "power",
```

Do not add `LLMPROXY_REORDERING`/`LLMPROXY_REORDERING_MINUTES` here — this block seeds a **project's** `.claude/settings.json`, and the new vars are service-scope (they belong in the service's own env/config file, not per-project settings), matching the Task 7 decision to keep them out of `getProjectDefaultValues()`.

- [ ] **Step 6: Write CLI tests for `provider:reorder`**

Add to `tests/cli.test.js`, immediately after the existing `"provider:order moves providers to the requested fallback position"` test (confirmed pattern: `runCli(["node", "llmproxy", <command>, ...args], { dataRoot, stdout, env })`, providers arranged directly via `require("../lib/token-store").createTokenStore({ filePath })`, verified by reloading a fresh `createTokenStore` instance):

```js
test("provider:reorder reports 'not configured' when LLMPROXY_REORDERING is unset", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-reorder-off-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("primary", { access_token: "token-primary", token_type: "bearer", scope: "read:user" }, { name: "Primary" });

  const exitCode = await runCli(["node", "llmproxy", "provider:reorder"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /non configurata/);
});

test("provider:reorder ranks by price and persists the new order", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-reorder-price-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("paid", {
    access_token: "token-paid", token_type: "api_key", scope: "api_key",
    provider: "deepseek", auth_type: "api_key", default_model: "deepseek-chat", free_model: false,
  }, { name: "Paid" });
  tokenStore.saveProvider("free", {
    access_token: "token-free", token_type: "api_key", scope: "api_key",
    provider: "openrouter", auth_type: "api_key", default_model: "some-free-model", free_model: true,
  }, { name: "Free" });

  const fetchFn = async () => ({ ok: false }); // pricing lookup fails for the paid provider -> treated as worst, free wins

  const exitCode = await runCli(["node", "llmproxy", "provider:reorder"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
    env: { LLMPROXY_REORDERING: "price" },
  });

  const reloaded = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  assert.equal(exitCode, 0);
  assert.deepEqual(reloaded.listProviders().map((provider) => provider.id), ["free", "paid"]);
  assert.match(stdout.toString(), /Criteri: price/);
  assert.match(stdout.toString(), /Nuovo ordine provider: free, paid/);
});
```

- [ ] **Step 7: Run the CLI test suite**

Run: `node --test tests/cli.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -u lib/provider-benchmark.js
git add lib/cli.js tests/cli.test.js
git commit -m "feat: add provider:reorder CLI command, finish removing provider-benchmark"
```

---

## Task 13: Fix up `tests/app.test.js` for the removed mechanisms

**Files:**
- Modify: `tests/app.test.js:9` (global env line), `tests/app.test.js:20` (import), `tests/app.test.js` (delete tests at 375, 458, 550, 646), `tests/app.test.js:3662-3727` (swap example config key), plus add one new end-to-end reordering test

- [ ] **Step 1: Remove the obsolete global env line and import**

Delete line 9:

```js
process.env.LLMPROXY_PRICE_PERFORMANCE_ROUTING = "false";
```

Change line 20 from:

```js
const { API_KEY_PROVIDER_CONFIGS, escalationTracker } = require("../lib/copilot-proxy");
```

to:

```js
const { API_KEY_PROVIDER_CONFIGS } = require("../lib/copilot-proxy");
```

Grep the rest of the file for `escalationTracker` afterward and remove any other usages (e.g. `escalationTracker.enabled = ...` toggles inside individual tests) — each such line was only there to arrange the now-deleted mechanism for its own test, which Step 2 deletes anyway.

- [ ] **Step 2: Delete the 4 tests that exercised the removed mechanisms**

Delete these 4 `test(...)` blocks in full: `"messages endpoint does not auto-escalate away from a free_model provider"` (line 375), `"messages endpoint auto-escalates to the next provider after repeated identical requests"` (line 458), `"messages endpoint price/performance routing prefers the most powerful free provider"` (line 550), `"messages endpoint price/performance routing prefers the fastest free provider when requested"` (line 646).

- [ ] **Step 3: Add one end-to-end test proving the new mechanism drives real fallback order**

Add a replacement test in the same area of the file, following the exact harness pattern the deleted tests used (`createTokenStore`, a `.claude/settings.json` fixture under `x-project-path`, a `fetchFn` that branches on request URL, `createApp({ dataRoot, tokenStore, fetchFn })`, `withServer(app, callback)`), except the provider order is now set by running an actual `provider-reordering` cycle beforehand instead of relying on per-request env-driven ranking, and the expected inline reason is the new, simpler default (`"First in order from provider list"`) since `runtimeSelectionReason` is always `null` now:

```js
test("messages endpoint follows the order persisted by an LLMPROXY_REORDERING price cycle", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-reordering-price-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash",
    free_model: false,
  }, { name: "DeepSeek Paid" });
  tokenStore.saveProvider("opencode", {
    access_token: "token-opencode",
    token_type: "api_key",
    scope: "api_key",
    provider: "opencode",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
    free_model: true,
  }, { name: "OpenCode Free" });

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llm-proxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
      LLMPROXY_INFERENCE_INFO_INLINE: "1",
    },
  }, null, 2));

  const fetchFn = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: String(url).includes("opencode.ai") ? "deepseek-v4-flash-free" : "deepseek-v4-flash",
        choices: [{
          message: { content: String(url).includes("opencode.ai") ? "served by opencode" : "served by deepseek" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      };
    },
  });

  const { createProviderReordering } = require("../lib/provider-reordering");
  const reordering = createProviderReordering({
    tokenStore,
    filePath: path.join(tempRoot, "provider-reordering.json"),
    fetchFn: async () => ({ ok: false }), // price lookup fails for the paid provider -> treated as worst, free wins
  });
  await reordering.runCycle({ LLMPROXY_REORDERING: "price" });
  assert.deepEqual(tokenStore.listProviders().map((provider) => provider.id), ["opencode", "deepseek"]);

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-project-path": workspaceRoot },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(payload.content[0].text, /^\[llmproxy\] provider: opencode \| model: deepseek-v4-flash-free : First in order from provider list/m);
    assert.match(payload.content[0].text, /served by opencode/);
  });
});
```

- [ ] **Step 4: Swap the REST config-endpoint example key**

In the test `"model:set and config endpoints are exposed via REST"` (starts ~line 3662), replace every occurrence of `LLMPROXY_PRICE_PERFORMANCE_ROUTING` with `LLMPROXY_REORDERING`, and `project.LLMPROXY_PRICE_PERFORMANCE_ROUTING=1` with `project.LLMPROXY_REORDERING=price`, and `configSetResponse`'s posted value `"1"` with `"price"` (adjust literal value assertions accordingly — the point of this test is exercising generic `/api/config/{key}` plumbing, not this specific variable's semantics, so any valid `LLMPROXY_REORDERING` value works). Also update the companion assertion at line 3708 (`project.LLMPROXY_AUTO_ESCALATE=1`) — since that var no longer exists, remove that specific assertion line rather than swapping it (it was asserting a second, unrelated config key was also listed; if the test needs a second example key for that purpose, use `LLMPROXY_REORDERING_MINUTES` instead).

- [ ] **Step 5: Run the full app test suite**

Run: `node --test tests/app.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tests/app.test.js
git commit -m "test: replace escalation/price-performance app tests with LLMPROXY_REORDERING coverage"
```

---

## Task 14: Update documentation

**Files:**
- Modify: `.env.example:174-186`, `llmproxy_settings.md:11-17,139-153`, `README.md:279-357`, `README-IT.md:821-846,1054-1055`, `README.md` provider CLI docs (~1028-1079, REST mapping table ~841-869)

- [ ] **Step 1: Update `.env.example`**

Replace:

```
# ── Auto Escalation ──────────────────────────────────────────────────────────
# Se 1, llmProxy monitora richieste ripetute sullo stesso problema ed escala
# automaticamente a provider con coding score più alto dopo 2 tentativi falliti.
# LLMPROXY_AUTO_ESCALATE=1

# ── Price/Performance Routing ────────────────────────────────────────────────
# Se 1, preferisce provider/modello gratuiti o più convenienti a parità di idoneità.
# LLMPROXY_PRICE_PERFORMANCE_ROUTING=1

# ── Price/Performance Tie-Breaker ────────────────────────────────────────────
# Se più provider gratuiti sono idonei, sceglie il più potente o il più veloce.
# Valori: power | speed
# LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER=power
```

with:

```
# ── Provider Reordering ──────────────────────────────────────────────────────
# Riordina automaticamente i provider registrati in base a criteri reali,
# in ordine di preferenza, separati da "-". Valori ammessi: price, power, speed.
# - price: costo reale (ai.cloudprice.net), free_model=true conta come 0
# - power: coding_index reale (ai.cloudprice.net benchmarks)
# - speed: latenza reale misurata da un probe di inferenza
# Sottoinsiemi ammessi (es. solo "price"). Se assente, il reordering automatico
# è disattivato e resta l'ordine manuale (llmproxy provider:order).
# LLMPROXY_REORDERING=price-speed-power

# ── Provider Reordering — intervallo ─────────────────────────────────────────
# Ogni quanti minuti rieseguire il ciclo di reordering. Se LLMPROXY_REORDERING
# è impostata e questa manca, il default è 5. Richiede restart per cambiare.
# LLMPROXY_REORDERING_MINUTES=5
```

- [ ] **Step 2: Update `llmproxy_settings.md`**

Replace the `## \`LLMPROXY_AUTO_ESCALATE\`` block (lines 11-17) and the `## \`LLMPROXY_PRICE_PERFORMANCE_ROUTING\`` / `## \`LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER\`` blocks (lines 139-153) each with a single removal, and add one new combined section (placed where the price/performance blocks were, since `LLMPROXY_PROVIDER_BENCHMARK_MINUTES` was never documented here to begin with — this section now also fills that gap):

```markdown
## `LLMPROXY_REORDERING`

Controls automatic, periodic provider reordering based on live price, power (coding benchmark), and speed (real latency probe) data. Value is an ordered, `-`-separated list of criteria (subset of `price`, `power`, `speed`), most important first — e.g. `price-speed-power`.

May be omitted: yes.
Value when omitted: automatic reordering is off; the manually-configured provider order is used as-is.
Example: `LLMPROXY_REORDERING=price-speed-power`

## `LLMPROXY_REORDERING_MINUTES`

How often (in minutes) the reordering cycle runs when `LLMPROXY_REORDERING` is set.

May be omitted: yes.
Value when omitted: `5`, but only takes effect if `LLMPROXY_REORDERING` is also set.
Example: `LLMPROXY_REORDERING_MINUTES=10`
```

- [ ] **Step 3: Update `README.md`'s "Interaction Rules" section**

Replace the entire block from `### \`LLMPROXY_PRICE_PERFORMANCE_ROUTING\`` through the end of the `### Example \`.claude/settings.json\`` code sample (lines 279-357, no more `LLMPROXY_AUTO_ESCALATE` heading or "Interaction Rules When Multiple Features Are Enabled" heading either — there's only one mechanism now) with:

```markdown
### `LLMPROXY_REORDERING`

Service-scoped variable (read from the running proxy's own environment, not per-project `.claude/settings.json`).

Supported values: an ordered, `-`-separated list of criteria, most important first. Valid tokens: `price`, `power`, `speed`. Any subset is allowed (e.g. just `price`).

Related variable:

- `LLMPROXY_REORDERING_MINUTES=<n>` — how often the reordering cycle runs (default `5` when `LLMPROXY_REORDERING` is set)

What it does:

- every `LLMPROXY_REORDERING_MINUTES` minutes, ranks all registered providers using live data and persists the result as the new provider fallback order
- `price`: real cost from the CloudPrice pricing API (`free_model=true` providers count as cost `0`)
- `power`: real `coding_index` benchmark score from the CloudPrice benchmarks API
- `speed`: real inference-latency probe (a minimal `max_tokens: 1` request to each provider)
- providers missing data for a given criterion rank last on that criterion only — ranking still proceeds using the remaining criteria
- the persisted order is the single source of truth: it's what `llmproxy provider:list` shows, what `/v1/messages` fallback uses, and what a manual `llmproxy provider:order` sets until the next automatic cycle

Important:

- if `LLMPROXY_REORDERING` is unset or empty, no automatic reordering happens — the order stays whatever was last set manually
- run `llmproxy provider:reorder` to force an immediate cycle without waiting for the timer

### Example service `.env`

```
LLMPROXY_REORDERING=price-speed-power
LLMPROXY_REORDERING_MINUTES=5
```

In this configuration, every 5 minutes the proxy re-ranks providers: cheapest (free) first; among equal-cost providers, fastest measured latency next; among equal-cost-and-speed providers, highest coding benchmark score last.
```

- [ ] **Step 4: Update `README-IT.md`**

Replace the `### Routing prezzo/prestazioni` section (lines 821-846) with:

```markdown
### Riordino automatico provider

`LLMPROXY_REORDERING` è una variabile a livello di servizio (letta dall'ambiente del proxy in esecuzione, non da `.claude/settings.json` per-progetto).

Come funziona:

1. ogni `LLMPROXY_REORDERING_MINUTES` minuti (default 5), riordina tutti i provider registrati usando dati reali
2. i criteri sono una lista ordinata separata da `-`, ammesso un sottoinsieme di: `price`, `power`, `speed`
3. `price`: costo reale da CloudPrice (i provider `free_model=true` valgono costo 0)
4. `power`: `coding_index` reale da CloudPrice benchmarks
5. `speed`: latenza reale misurata con un probe di inferenza
6. l'ordine calcolato viene salvato stabilmente: è quello che vede `provider:list`, quello usato dal fallback di `/v1/messages`, e resta valido fino al ciclo successivo

Esempio `.env` del servizio:

```
LLMPROXY_REORDERING=price-speed-power
LLMPROXY_REORDERING_MINUTES=5
```

Se `LLMPROXY_REORDERING` non è impostata, il reordering automatico è disattivato e resta l'ordine impostato manualmente con `llmproxy provider:order`. Usa `llmproxy provider:reorder` per forzare subito un ciclo.
```

And replace the two table rows at lines 1054-1055 (in the project-scope `config:*` table) — **delete** them entirely from that table (they no longer belong there, since the new vars are service-scope, not project-scope); instead add a new row to the **service-scope** table further down the file (find the table following the `### Service-Scope (.env — richiede restart)` heading and add):

```markdown
| `LLMPROXY_REORDERING` | unset (`off`) | lista `-`-separata di `price`, `power`, `speed` | riordina automaticamente i provider ogni N minuti in base a dati reali |
| `LLMPROXY_REORDERING_MINUTES` | `5` (solo se REORDERING è impostata) | minuti | intervallo del ciclo di reordering |
```

Also update the `llmproxy config:set LLMPROXY_PRICE_PERFORMANCE_ROUTING 1 --scope project` example command (line 1036) to `llmproxy config:set LLMPROXY_REORDERING price-speed-power --scope service`.

- [ ] **Step 5: Update the `provider:list`/`provider:order` CLI docs and REST mapping table in `README.md`**

Add a new subsection immediately after the existing `### \`llmproxy provider:order <id> <position>\`` block:

```markdown
### `llmproxy provider:reorder`

Forces an immediate automatic reordering cycle (price/power/speed, per `LLMPROXY_REORDERING`) without waiting for the timer. Prints the criteria used, the resulting order, and the raw score for each provider. Does nothing (and says so) if `LLMPROXY_REORDERING` is unset.
```

Add a new row to the CLI/REST mapping table:

```markdown
| `llmproxy provider:reorder` | `POST /api/providers/reorder` |
```

- [ ] **Step 6: Commit**

```bash
git add .env.example llmproxy_settings.md README.md README-IT.md
git commit -m "docs: replace escalation/price-performance/benchmark docs with LLMPROXY_REORDERING"
```

---

## Task 15: Full verification, version bump, final commit

**Files:**
- Modify: `package.json` (version bump, per `CLAUDE.md`'s mandatory rule)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — this runs `npm run build:ts && node --test tests/*.test.js`, exercising every file touched across all 14 prior tasks in one pass.

- [ ] **Step 2: Grep for any leftover reference to removed identifiers**

Run: `grep -rn "LLMPROXY_AUTO_ESCALATE\|LLMPROXY_PRICE_PERFORMANCE_ROUTING\|LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER\|LLMPROXY_PROVIDER_BENCHMARK_MINUTES\|escalationTracker\|EscalationTracker\|rankProvidersByPricePerformance\|smartRouteInfo\|prioritizeProvider\|findBestModel" --include="*.js" --include="*.ts" --include="*.md" -- lib src tests README.md README-IT.md llmproxy_settings.md .env.example`
Expected: no output (a match here means a Task above missed a spot — go fix it and re-run this grep before proceeding).

- [ ] **Step 3: Bump the `llmproxy` package version**

Read the current `version` field in `package.json`, then bump the patch number by one (e.g. `0.3.47` → `0.3.48` — check the actual current value first, since other work may have landed on `main` since this plan was written) in both `package.json` and `package-lock.json` (the top-level `version` field and the root package entry's `version` field, per this repo's existing convention — check how the last few version-bump commits in `git log` touched `package-lock.json` and mirror that exactly).

- [ ] **Step 4: Commit the version bump together with any final cleanup**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to <new-version>"
```

(If Steps 1-2 required additional fixes beyond the version bump, include those in this same commit or a preceding one — per `CLAUDE.md`, the version bump must land in the same push as the feature work, not necessarily the exact same commit as every fix.)

- [ ] **Step 5: Final full test run to confirm the version-bump commit didn't break anything**

Run: `npm test`
Expected: PASS
