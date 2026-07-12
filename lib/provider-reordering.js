"use strict";

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

module.exports = {
  VALID_CRITERIA,
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
  isFreeModelProvider,
  computeProviderScores,
  rankProvidersByCriteria,
};
