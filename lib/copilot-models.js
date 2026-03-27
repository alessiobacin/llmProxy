const fs = require("node:fs");
const path = require("node:path");
const { getAvailableModels } = require("./openai-translate");

const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";

function normalizeCatalogPayload(payload) {
  const rawModels = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

  return [...new Set(rawModels
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => String(entry.id || "").trim())
    .filter((entry) => entry.model_picker_enabled !== false)
    .filter((entry) => String(entry.policy?.state || "enabled") === "enabled")
    .map((entry) => String(entry.id).trim()))];
}

function createCopilotModelCatalogStore(options = {}) {
  const filePath = path.resolve(String(options.filePath || "copilot-models.json"));

  function load() {
    try {
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(parsed?.models)
        ? parsed.models.map((model) => String(model || "").trim()).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  function save(models) {
    const normalizedModels = [...new Set((Array.isArray(models) ? models : []).map((model) => String(model || "").trim()).filter(Boolean))];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      models: normalizedModels,
    }, null, 2));
    return normalizedModels;
  }

  return {
    filePath,
    load,
    list: load,
    save,
  };
}

async function fetchAvailableCopilotModels(options = {}) {
  const tokenStore = options.tokenStore;
  const fetchFn = options.fetchFn || fetch;
  const accessToken = tokenStore?.getAccessToken ? tokenStore.getAccessToken() : null;
  if (!accessToken) {
    throw new Error("GitHub Copilot non autenticato");
  }

  const response = await fetchFn(COPILOT_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "llmproxy/0.1.0",
    },
  });

  if (!response.ok) {
    const errorText = typeof response.text === "function" ? await response.text() : "fetch_models_failed";
    throw new Error(`Recupero catalogo modelli fallito: ${response.status} ${errorText}`);
  }

  return normalizeCatalogPayload(await response.json());
}

async function resolveAvailableCopilotModels(options = {}) {
  const catalogStore = options.catalogStore;
  const staticModels = Array.isArray(options.fallbackModels) && options.fallbackModels.length > 0
    ? options.fallbackModels
    : getAvailableModels();

  if (options.preferLive !== false) {
    try {
      const liveModels = await fetchAvailableCopilotModels(options);
      if (liveModels.length > 0) {
        if (catalogStore?.save) catalogStore.save(liveModels);
        return liveModels;
      }
    } catch {
      // Fall back to cached or static models.
    }
  }

  const cachedModels = catalogStore?.list ? catalogStore.list() : [];
  if (cachedModels.length > 0) return cachedModels;

  return staticModels;
}

module.exports = {
  COPILOT_MODELS_URL,
  normalizeCatalogPayload,
  createCopilotModelCatalogStore,
  fetchAvailableCopilotModels,
  resolveAvailableCopilotModels,
};