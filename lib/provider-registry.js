"use strict";

const fs = require("node:fs");
const path = require("node:path");
const tsRegistry = require("./ts-build/gateway/providers/provider-registry");

// Bridge: old filePath-based API → new persistence-interface API
function createFilePersistence(filePath) {
  if (!filePath) throw new Error("provider-registry filePath required");
  const fileMode = 0o600;
  const dirMode = 0o700;

  function read() {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { entries: [] };
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch (err) {
      if (err && err.code === "ENOENT") return { entries: [] };
      throw err;
    }
  }

  function write(store) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: dirMode });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { mode: fileMode });
    fs.chmodSync(filePath, fileMode);
  }

  return { read, write };
}

function createProviderRegistry(options = {}) {
  const filePath = options.filePath;
  if (!filePath) throw new Error("provider-registry filePath required");

  const persistence = createFilePersistence(filePath);
  const registry = tsRegistry.createProviderRegistry({
    persistence,
    secret: options.secret || null,
  });

  // Bridge: old upsert(raw input) → new upsert(validated entry)
  const rawUpsert = registry.upsert;
  registry.upsert = function (input) {
    const validated = tsRegistry.validateEntry(input || {});
    return rawUpsert(validated);
  };

  return registry;
}

// Re-export TS constants and helpers
module.exports = {
  createProviderRegistry,
  SUPPORTED_PROVIDERS: tsRegistry.SUPPORTED_PROVIDERS,
  VALID_SCOPE_TYPES: tsRegistry.VALID_SCOPE_TYPES,
  validateEntry: tsRegistry.validateEntry,
  entryId: tsRegistry.entryId,
  publicView: tsRegistry.publicView,
  buildScopeMatchSet: tsRegistry.buildScopeMatchSet,
};
