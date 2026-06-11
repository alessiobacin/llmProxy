"use strict";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function createAvailabilityCache(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  let cached = null;
  let cachedAt = 0;

  async function getActiveProviders(registry, probeFn) {
    if (cached && Date.now() - cachedAt < ttlMs) return cached;

    const entries = registry.list();
    const providers = [];

    for (const entry of entries) {
      let result;
      try {
        result = await probeFn(entry);
      } catch (err) {
        result = { active: false, error: err.message || String(err), models: [] };
      }

      providers.push({
        provider: entry.provider,
        scope_type: entry.scope_type,
        scope_id: entry.scope_id,
        active: result.active === true,
        error: result.error || null,
        models: Array.isArray(result.models) ? result.models : [],
      });
    }

    cached = { providers, checkedAt: new Date().toISOString() };
    cachedAt = Date.now();
    return cached;
  }

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  function getCached() {
    return cached;
  }

  return { getActiveProviders, invalidate, getCached };
}

module.exports = { createAvailabilityCache };
