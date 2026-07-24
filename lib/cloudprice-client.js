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
  const leafWithoutBoth = leafWithoutDate.replace(/-free$/i, "");
  return Array.from(new Set([
    raw, withoutDate, withoutFree,
    leaf, leafWithoutDate, leafWithoutFree, leafWithoutBoth,
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
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(15000) : undefined,
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
    "vercel-ai-gateway": ["vercel_ai_gateway", "vercel", "openrouter"],
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
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(15000) : undefined,
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
