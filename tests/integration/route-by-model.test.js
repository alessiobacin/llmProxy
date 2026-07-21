const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseProviderModelPreferences,
  API_KEY_PROVIDER_CONFIGS,
} = require("../../lib/copilot-proxy");

// Inline version of providerSupportsRequestedModel (not exported)
function supportsModel(provider, model) {
  if (!model) return false;
  const providerKind = String(provider.provider || provider.id || "").toLowerCase();
  if (providerKind === "copilot") return false;
  const config = API_KEY_PROVIDER_CONFIGS[providerKind];
  if (!config) return true;
  if (typeof config.supportsModel === "function") return config.supportsModel(model);
  return true;
}

// Replicate buildProviderModelCandidates inline (not exported)
function buildCandidates(provider, modelPreference, openaiModel, availableModels, options = {}) {
  const providerKind = String(provider.provider || provider.id || "").toLowerCase();
  const providerConfig = API_KEY_PROVIDER_CONFIGS[providerKind] || null;
  const preferences = parseProviderModelPreferences(modelPreference);
  const providerSpecificModels = preferences
    .filter((preference) => {
      if (!preference.provider) return true;
      const normalized = String(preference.provider).trim().toLowerCase();
      return normalized === providerKind || normalized === String(provider.id || "").toLowerCase();
    })
    .map((preference) => preference.model);

  const useGlobalRequestedModel = !options.hasProviderModelPreferences
    && (options.explicitProvider || providerKind === "copilot" || !provider.default_model);

  const requestedModelsRaw = providerSpecificModels.length > 0
    ? providerSpecificModels
    : useGlobalRequestedModel
      ? preferences.filter((pre) => !pre.provider).map((pre) => pre.model)
      : [];

  const requestedModels = requestedModelsRaw.filter((model) => {
    if (providerKind === "copilot") return true;
    const config = API_KEY_PROVIDER_CONFIGS[providerKind];
    if (!config) return true;
    if (typeof config.supportsModel === "function") return config.supportsModel(model);
    return true;
  });

  const fallbackDefaultModel = String(
    provider.default_model || providerConfig?.defaultModel || "",
  ).trim();
  const rawCandidates = [...requestedModels];

  if (rawCandidates.length === 0 && openaiModel && useGlobalRequestedModel) {
    if (providerKind === "copilot") {
      rawCandidates.push(openaiModel);
    } else {
      const config = API_KEY_PROVIDER_CONFIGS[providerKind];
      if (config && typeof config.supportsModel === "function" && config.supportsModel(openaiModel)) {
        rawCandidates.push(openaiModel);
      }
    }
  }

  // Fallback default model is always available (pre-revert behavior)
  if (fallbackDefaultModel) rawCandidates.push(fallbackDefaultModel);

  return [...new Set(rawCandidates.filter(Boolean))];
}

// Simulate the provider sorting that now happens in proxyAnthropicRequest
function sortProvidersByModelSupport(providers, requestModel) {
  return [...providers].sort((a, b) => {
    const aSupports = supportsModel(a, requestModel);
    const bSupports = supportsModel(b, requestModel);
    if (aSupports && !bSupports) return -1;
    if (!aSupports && bSupports) return 1;
    return 0;
  });
}

test("opencode-bacin keeps fallback default model even with explicit tencent/hy3:free", () => {
  const provider = { id: "opencode-bacin", provider: "opencode", default_model: "deepseek-v4-flash-free" };
  const candidates = buildCandidates(
    provider,
    "tencent/hy3:free",
    "tencent/hy3:free",
    [],
    { clientProvidedModel: true, hasProviderModelPreferences: false, explicitProvider: false },
  );
  assert.ok(candidates.length > 0, "opencode-bacin should still have fallback default model");
  assert.ok(candidates.includes("deepseek-v4-flash-free"), "should have deepseek-v4-flash-free as fallback");
});

test("OpenRouter has tencent/hy3:free as candidate", () => {
  const provider = { id: "tencent/hy3:free", provider: "openrouter", default_model: "tencent/hy3:free" };
  const candidates = buildCandidates(
    provider,
    "tencent/hy3:free",
    "tencent/hy3:free",
    [],
    { clientProvidedModel: true, hasProviderModelPreferences: false, explicitProvider: false },
  );
  assert.ok(candidates.length > 0, "OpenRouter should have candidates");
  assert.ok(candidates.includes("tencent/hy3:free"), "candidates should include tencent/hy3:free");
});

test("opencode-bacin still supports requested deepseek models", () => {
  const provider = { id: "opencode-bacin", provider: "opencode", default_model: "deepseek-v4-flash-free" };
  const candidates = buildCandidates(
    provider,
    "deepseek-v4-flash",
    "deepseek-v4-flash",
    [],
    { clientProvidedModel: true, hasProviderModelPreferences: false, explicitProvider: false },
  );
  assert.ok(candidates.length > 0, "opencode should have candidates for deepseek model");
  assert.ok(candidates.includes("deepseek-v4-flash-free"), "should include default fallback");
});

test("no clientProvidedModel = backward compat: opencode-bacin uses default model", () => {
  const provider = { id: "opencode-bacin", provider: "opencode", default_model: "deepseek-v4-flash-free" };
  const candidates = buildCandidates(
    provider,
    "",
    "",
    [],
    { clientProvidedModel: false, hasProviderModelPreferences: false, explicitProvider: false },
  );
  assert.ok(candidates.length > 0, "opencode should have candidates when no explicit model");
  assert.ok(candidates.includes("deepseek-v4-flash-free"), "should fall back to default model");
});

test("provider sorting: OpenRouter is tried first when tencent/hy3:free is requested", () => {
  const providers = [
    { id: "opencode-bacin", provider: "opencode", default_model: "deepseek-v4-flash-free" },
    { id: "tencent/hy3:free", provider: "openrouter", default_model: "tencent/hy3:free" },
  ];

  const sorted = sortProvidersByModelSupport(providers, "tencent/hy3:free");

  assert.equal(sorted[0].id, "tencent/hy3:free",
    "OpenRouter should be first after sorting by model support");
  assert.equal(sorted[1].id, "opencode-bacin",
    "opencode-bacin should be second (fallback)");
});

test("provider sorting: normal provider order preserved when no model is explicitly requested", () => {
  const providers = [
    { id: "opencode-bacin", provider: "opencode", default_model: "deepseek-v4-flash-free" },
    { id: "tencent/hy3:free", provider: "openrouter", default_model: "tencent/hy3:free" },
  ];

  const sorted = sortProvidersByModelSupport(providers, "");

  assert.equal(sorted[0].id, "opencode-bacin",
    "original order preserved when no model requested");
  assert.equal(sorted[1].id, "tencent/hy3:free",
    "original order preserved when no model requested");
});
