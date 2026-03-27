const fs = require("node:fs");
const path = require("node:path");

const VALID_ENDPOINTS = new Set(["chat", "responses"]);

function normalizeModel(model) {
  return String(model || "").trim();
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim().toLowerCase();
  return VALID_ENDPOINTS.has(value) ? value : null;
}

function loadPreferences(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed?.models && typeof parsed.models === "object" ? parsed.models : {};
  } catch {
    return {};
  }
}

function createCopilotEndpointPreferences(options = {}) {
  const filePath = options.filePath ? path.resolve(String(options.filePath)) : "";
  let models = loadPreferences(filePath);

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, models }, null, 2));
  }

  function getPreferredEndpoint(model) {
    const normalizedModel = normalizeModel(model);
    return normalizedModel ? models[normalizedModel]?.endpoint || null : null;
  }

  function setPreferredEndpoint(model, endpoint, metadata = {}) {
    const normalizedModel = normalizeModel(model);
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    if (!normalizedModel || !normalizedEndpoint) return null;
    models = {
      ...models,
      [normalizedModel]: {
        endpoint: normalizedEndpoint,
        updatedAt: new Date().toISOString(),
        source: metadata.source || null,
        status: metadata.status ?? null,
      },
    };
    persist();
    return models[normalizedModel];
  }

  return {
    getPreferredEndpoint,
    setPreferredEndpoint,
  };
}

module.exports = {
  createCopilotEndpointPreferences,
};