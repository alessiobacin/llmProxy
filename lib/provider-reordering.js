"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VALID_CRITERIA = ["price", "power", "speed"];

const { fetchCodingScore, fetchModelPricing, pickCurrentPricingOption } = require("./cloudprice-client");

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
    if (result?.ok === true) return Date.now() - startedAt;
    if (result?.error) return `errore ${result.error}`;
    return null;
  } catch (e) {
    return `errore ${e?.message || "network-error"}`;
  }
}

async function fetchBenchmarkMetric(provider, fetchFn) {
  const model = String(provider?.default_model || "").trim();
  if (!model || typeof fetchFn !== "function") return null;
  const score = await fetchCodingScore(model, fetchFn, new Map());
  return typeof score === "number" ? score : null;
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
      // Treat non-numeric values (errors) as worst case
      const numA = typeof rawA === "number" ? rawA : Number.POSITIVE_INFINITY;
      const numB = typeof rawB === "number" ? rawB : Number.POSITIVE_INFINITY;
      const valueA = direction === "desc" ? -numA : numA;
      const valueB = direction === "desc" ? -numB : numB;
      if (valueA !== valueB) return valueA - valueB;
    }
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.provider);
}

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
  "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/chat/completions",
};

function resolveProbeEndpoint(provider) {
  const pType = (provider.provider || "").toLowerCase();
  if (pType === "copilot") return "https://api.githubcopilot.com/chat/completions";
  return PROBE_ENDPOINTS[pType] || null;
}

function buildDefaultProbeFn(options = {}) {
  const proxyStore = options.proxyStore || null;
  return async ({ provider, model, fetchFn }) => {
    const pType = (provider.provider || "").toLowerCase();
    const isAnthropic = pType === "anthropic" || pType === "opencode-go";
    const url = resolveProbeEndpoint(provider);
    if (!url) return { ok: false, error: "no-endpoint" };

    const proxyFetch = (() => {
      // Resolve proxy URL: direct proxy_url, proxy_rotation via store, or none
      let proxyUrl = provider.proxy_url;
      if (!proxyUrl && provider.proxy_rotation && proxyStore) {
        const proxies = proxyStore.listProxies();
        if (proxies.length > 0) proxyUrl = proxies[0].url;
      }
      if (!proxyUrl) return fetchFn;
      try {
        const { ProxyAgent, fetch: undiciFetch } = require("undici");
        const agent = new ProxyAgent(proxyUrl);
        return (u, opts = {}) => undiciFetch(u, { ...opts, dispatcher: agent });
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
      const res = await proxyFetch(url, {
        method: "POST",
        headers,
        body,
        signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(30000) : undefined,
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `http ${res.status}` };
    } catch (e) {
      return { ok: false, error: e?.message || "network-error" };
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
  fetchSpeedMetric,
  fetchBenchmarkMetric,
  readReorderingStore,
  writeReorderingStore,
  DEFAULT_REORDERING_FILE,
};
