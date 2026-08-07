"use strict";

// Registry of known model capabilities, tiers, and approximate costs.
// Used by the smart router to select the best model for a given request.

const MODEL_TIERS = {
  economy: [
    "deepseek-chat",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "kimi-k2.6",
    "gpt-4.1-nano",
    "qwen3.7-max",
    "qwen3.7-plus",
    "groq/llama-3.3-70b-versatile",
    "meta-llama/llama-3.3-70b-instruct",
    "mistral-7b-instruct",
    "mixtral-8x7b-instruct",
  ],
  standard: [
    "claude-haiku-4.5",
    "claude-sonnet-4",
    "gpt-4.1-mini",
    "gpt-4.1",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20251001",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "qwen-max",
  ],
  premium: [
    "claude-opus-4-6",
    "claude-opus-4.5",
    "claude-sonnet-4.5",
    "gpt-5",
    "o3",
    "o1",
    "gemini-2.5-pro",
    "claude-opus-4-6-20250820",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
  ],
};

// Per-model capability overrides. If a model is not here, defaults apply.
const MODEL_CAPABILITY_OVERRIDES = {
  // Economy
  "deepseek-chat": { vision: false, tools: true, inputPerM: 0.14, outputPerM: 0.28 },
  "deepseek-v4-flash": { vision: false, tools: true, inputPerM: 0.14, outputPerM: 0.28 },
  "deepseek-v4-pro": { vision: false, tools: true, inputPerM: 0.27, outputPerM: 0.42 },
  "kimi-k2.6": { vision: true, tools: true, inputPerM: 0.15, outputPerM: 0.60 },
  "gpt-4.1-nano": { vision: true, tools: true, inputPerM: 0.10, outputPerM: 0.40 },
  "qwen3.7-max": { vision: false, tools: true, inputPerM: 0.10, outputPerM: 0.30 },
  "qwen3.7-plus": { vision: true, tools: true, inputPerM: 0.10, outputPerM: 0.30 },
  "groq/llama-3.3-70b-versatile": { vision: false, tools: true, inputPerM: 0.00, outputPerM: 0.00 },
  "meta-llama/llama-3.3-70b-instruct": { vision: false, tools: true, inputPerM: 0.00, outputPerM: 0.00 },
  "mistral-7b-instruct": { vision: false, tools: true, inputPerM: 0.00, outputPerM: 0.00 },
  "mixtral-8x7b-instruct": { vision: false, tools: true, inputPerM: 0.00, outputPerM: 0.00 },

  // Standard
  "claude-haiku-4.5": { vision: true, tools: true, inputPerM: 1.00, outputPerM: 5.00 },
  "claude-haiku-4-5-20251001": { vision: true, tools: true, inputPerM: 1.00, outputPerM: 5.00 },
  "claude-sonnet-4": { vision: true, tools: true, inputPerM: 3.00, outputPerM: 15.00 },
  "claude-sonnet-4-20250514": { vision: true, tools: true, inputPerM: 3.00, outputPerM: 15.00 },
  "gpt-4.1-mini": { vision: true, tools: true, inputPerM: 0.40, outputPerM: 1.60 },
  "gpt-4.1": { vision: true, tools: true, inputPerM: 2.00, outputPerM: 8.00 },
  "gpt-4o": { vision: true, tools: true, inputPerM: 2.50, outputPerM: 10.00 },
  "gpt-4o-mini": { vision: true, tools: true, inputPerM: 0.15, outputPerM: 0.60 },
  "o4-mini": { vision: true, tools: true, inputPerM: 1.10, outputPerM: 4.40 },
  "qwen-max": { vision: false, tools: true, inputPerM: 0.20, outputPerM: 0.60 },

  // Premium
  "claude-opus-4-6": { vision: true, tools: true, inputPerM: 15.00, outputPerM: 75.00 },
  "claude-opus-4.5": { vision: true, tools: true, inputPerM: 15.00, outputPerM: 75.00 },
  "claude-opus-4-6-20250820": { vision: true, tools: true, inputPerM: 15.00, outputPerM: 75.00 },
  "claude-opus-4-5-20251101": { vision: true, tools: true, inputPerM: 15.00, outputPerM: 75.00 },
  "claude-sonnet-4.5": { vision: true, tools: true, inputPerM: 3.00, outputPerM: 15.00 },
  "claude-sonnet-4-5-20250929": { vision: true, tools: true, inputPerM: 3.00, outputPerM: 15.00 },
  "gpt-5": { vision: true, tools: true, inputPerM: 10.00, outputPerM: 30.00 },
  "o3": { vision: true, tools: true, inputPerM: 10.00, outputPerM: 40.00 },
  "o1": { vision: true, tools: true, inputPerM: 15.00, outputPerM: 60.00 },
  "gemini-2.5-pro": { vision: true, tools: true, inputPerM: 1.25, outputPerM: 10.00 },
};

// Build a unified MODEL_CAPABILITIES map: model → { tier, vision, tools, inputPerM, outputPerM }
const MODEL_CAPABILITIES = (() => {
  const map = {};
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    for (const model of models) {
      const override = MODEL_CAPABILITY_OVERRIDES[model] || {};
      map[model.toLowerCase()] = {
        model,
        tier,
        vision: override.vision ?? false,
        tools: override.tools ?? true,
        inputPerM: override.inputPerM ?? 0,
        outputPerM: override.outputPerM ?? 0,
      };
    }
  }
  return map;
})();

// Map of model name aliases (with date suffixes) to their canonical name
const DATE_SUFFIX_RE = /-\d{8}$/;

function getCapabilities(modelName) {
  if (!modelName) return null;
  const lower = String(modelName).trim().toLowerCase();
  // Try exact match first (full name with date suffix)
  if (MODEL_CAPABILITIES[lower]) return MODEL_CAPABILITIES[lower];
  // Try with date suffix stripped
  const stripped = lower.replace(DATE_SUFFIX_RE, "");
  return MODEL_CAPABILITIES[stripped] || null;
}

function getTierForModel(modelName) {
  const caps = getCapabilities(modelName);
  return caps ? caps.tier : "standard";
}

function getEstimatedCost(modelName, inputTokens, outputTokens) {
  const caps = getCapabilities(modelName);
  if (!caps) return 0;
  return (inputTokens * caps.inputPerM + outputTokens * caps.outputPerM) / 1_000_000;
}

const TIER_ORDER = ["economy", "standard", "premium"];
const POWER_TIER_SCORES = { economy: 100, standard: 200, premium: 300 };
const SPEED_TIER_SCORES = { economy: 300, standard: 200, premium: 100 };

function getPowerScore(modelName) {
  const caps = getCapabilities(modelName);
  const tier = getTierForModel(modelName);
  const base = POWER_TIER_SCORES[tier] || POWER_TIER_SCORES.standard;
  return base + (caps?.vision ? 20 : 0) + (caps?.tools ? 10 : 0);
}

function getSpeedScore(modelName) {
  const caps = getCapabilities(modelName);
  const tier = getTierForModel(modelName);
  const base = SPEED_TIER_SCORES[tier] || SPEED_TIER_SCORES.standard;
  return base + (caps?.tools ? 10 : 0) + (!caps?.vision ? 5 : 0);
}

// Per-model coding scores (0-100) for intent escalation routing.
// Higher = better coding ability. Defaults by tier if not explicitly listed.
const CODING_SCORES = {
  // Economy (~40-65)
  "deepseek-chat": 50,
  "deepseek-v4-flash": 56.2,
  "deepseek-v4-flash-free": 56.2,
  "deepseek-v4-pro": 57,
  "kimi-k2.6": 60,
  "kimi-k3": 76.2,
  "qwen3.7-max": 66,
  "qwen3.7-plus": 64,
  "groq/llama-3.3-70b-versatile": 55,
  "gpt-4.1-nano": 48,
  "mistral-7b-instruct": 42,
  "mixtral-8x7b-instruct": 48,
  // Standard (~66-85)
  "claude-haiku-4.5": 70,
  "claude-sonnet-4": 80,
  "gpt-4o-mini": 72,
  "gpt-4o": 82,
  "gpt-4.1-mini": 75,
  "gpt-4.1": 82,
  "o4-mini": 78,
  "qwen-max": 68,
  // Premium (~86-100)
  "claude-opus-4-6": 95,
  "claude-opus-4.5": 96,
  "claude-sonnet-4.5": 88,
  "gpt-5": 92,
  "o3": 94,
  "o1": 90,
  "gemini-2.5-pro": 89,
};

function getCodingScore(modelName) {
  const lower = String(modelName || "").trim().toLowerCase();
  if (CODING_SCORES[lower] !== undefined) return CODING_SCORES[lower];
  // Fallback by tier
  const tier = getTierForModel(modelName);
  if (tier === "premium") return 88;
  if (tier === "standard") return 73;
  if (tier === "economy") return 55;
  return 50;
}

module.exports = {
  MODEL_TIERS,
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_OVERRIDES,
  getCapabilities,
  getTierForModel,
  getEstimatedCost,
  getPowerScore,
  getSpeedScore,
  getCodingScore,
};
