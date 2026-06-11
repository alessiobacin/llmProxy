"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createAvailabilityCache } = require("../lib/smart-router-cache");

function makeEntry(overrides = {}) {
  return {
    provider: "copilot",
    scope_type: "user",
    scope_id: "test-user",
    default_model: "claude-sonnet-4",
    priority: 100,
    metadata: {},
    ...overrides,
  };
}

function makeRegistry(entries = []) {
  return { list: () => entries };
}

describe("smart-router-cache", () => {
  describe("createAvailabilityCache", () => {
    it("ritorna un oggetto con getActiveProviders, invalidate, getCached", () => {
      const cache = createAvailabilityCache({});
      assert.equal(typeof cache.getActiveProviders, "function");
      assert.equal(typeof cache.invalidate, "function");
      assert.equal(typeof cache.getCached, "function");
    });
  });

  describe("getActiveProviders", () => {
    it("proba tutti i provider registrati e ritorna risultati", async () => {
      const entries = [
        makeEntry({ provider: "copilot", scope_id: "u1" }),
        makeEntry({ provider: "openrouter", scope_id: "u2" }),
      ];
      const registry = makeRegistry(entries);

      const probeFn = async (entry) => ({
        active: true,
        error: null,
        models: entry.default_model ? [entry.default_model] : [],
      });

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      const result = await cache.getActiveProviders(registry, probeFn);

      assert.ok(result);
      assert.ok(Array.isArray(result.providers));
      assert.equal(result.providers.length, 2);
      assert.equal(result.providers[0].provider, "copilot");
      assert.equal(result.providers[0].active, true);
      assert.equal(result.providers[1].provider, "openrouter");
      assert.ok(result.checkedAt);
    });

    it("marca provider come inactive quando probe fallisce", async () => {
      const entries = [
        makeEntry({ provider: "copilot", scope_id: "u1" }),
        makeEntry({ provider: "deepseek", scope_id: "u2" }),
      ];
      const registry = makeRegistry(entries);

      const probeFn = async (entry) => {
        if (entry.provider === "deepseek") {
          return { active: false, error: "401 Unauthorized", models: [] };
        }
        return { active: true, error: null, models: ["claude-sonnet-4"] };
      };

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      const result = await cache.getActiveProviders(registry, probeFn);

      const copilot = result.providers.find((p) => p.provider === "copilot");
      const deepseek = result.providers.find((p) => p.provider === "deepseek");
      assert.equal(copilot.active, true);
      assert.equal(deepseek.active, false);
      assert.equal(deepseek.error, "401 Unauthorized");
    });

    it("cacha risultati e non riprova entro TTL", async () => {
      const entries = [makeEntry()];
      const registry = makeRegistry(entries);

      let probeCount = 0;
      const probeFn = async () => {
        probeCount++;
        return { active: true, error: null, models: [] };
      };

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      await cache.getActiveProviders(registry, probeFn);
      await cache.getActiveProviders(registry, probeFn);
      await cache.getActiveProviders(registry, probeFn);

      assert.equal(probeCount, 1, "probe deve essere chiamato una sola volta entro TTL");
    });

    it("riprova dopo scadenza TTL", async () => {
      const entries = [makeEntry()];
      const registry = makeRegistry(entries);

      let probeCount = 0;
      const probeFn = async () => {
        probeCount++;
        return { active: true, error: null, models: [] };
      };

      const cache = createAvailabilityCache({ ttlMs: 1 });
      await cache.getActiveProviders(registry, probeFn);
      // Aspetta che il TTL scada
      await new Promise((r) => setTimeout(r, 10));
      await cache.getActiveProviders(registry, probeFn);

      assert.equal(probeCount, 2, "probe deve essere richiamato dopo TTL");
    });

    it("ritorna cache esistente con getCached senza riprovare", async () => {
      const entries = [makeEntry()];
      const registry = makeRegistry(entries);

      let probeCount = 0;
      const probeFn = async () => {
        probeCount++;
        return { active: true, error: null, models: ["claude-sonnet-4"] };
      };

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      // getCached prima di任何 chiamata ritorna null
      assert.equal(cache.getCached(), null);

      await cache.getActiveProviders(registry, probeFn);
      const cached = cache.getCached();
      assert.ok(cached);
      assert.equal(cached.providers.length, 1);
      assert.equal(probeCount, 1);
    });

    it("invalidate forza refresh alla prossima chiamata", async () => {
      const entries = [makeEntry()];
      const registry = makeRegistry(entries);

      let probeCount = 0;
      const probeFn = async () => {
        probeCount++;
        return { active: true, error: null, models: [] };
      };

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      await cache.getActiveProviders(registry, probeFn);
      assert.equal(probeCount, 1);

      cache.invalidate();
      assert.equal(cache.getCached(), null);

      await cache.getActiveProviders(registry, probeFn);
      assert.equal(probeCount, 2);
    });

    it("gestisce probe che lancia eccezione senza crashare", async () => {
      const entries = [
        makeEntry({ provider: "copilot", scope_id: "u1" }),
        makeEntry({ provider: "openrouter", scope_id: "u2" }),
      ];
      const registry = makeRegistry(entries);

      const probeFn = async (entry) => {
        if (entry.provider === "openrouter") throw new Error("Network error");
        return { active: true, error: null, models: ["claude-sonnet-4"] };
      };

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      const result = await cache.getActiveProviders(registry, probeFn);

      const copilot = result.providers.find((p) => p.provider === "copilot");
      const openrouter = result.providers.find((p) => p.provider === "openrouter");
      assert.equal(copilot.active, true);
      assert.equal(openrouter.active, false);
      assert.ok(openrouter.error, "deve contenere messaggio errore");
    });

    it("ritorna providers vuoti quando registry e vuoto", async () => {
      const registry = makeRegistry([]);
      const probeFn = async () => ({ active: true, error: null, models: [] });

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      const result = await cache.getActiveProviders(registry, probeFn);

      assert.deepEqual(result.providers, []);
      assert.ok(result.checkedAt);
    });

    it("include id e scope info nei risultati", async () => {
      const entries = [
        makeEntry({ provider: "copilot", scope_type: "user", scope_id: "alice" }),
      ];
      const registry = makeRegistry(entries);
      const probeFn = async () => ({ active: true, error: null, models: ["claude-sonnet-4"] });

      const cache = createAvailabilityCache({ ttlMs: 60_000 });
      const result = await cache.getActiveProviders(registry, probeFn);

      const p = result.providers[0];
      assert.equal(p.provider, "copilot");
      assert.equal(p.scope_type, "user");
      assert.equal(p.scope_id, "alice");
      assert.deepEqual(p.models, ["claude-sonnet-4"]);
    });

    it("usa default TTL di 5 minuti quando non specificato", async () => {
      const cache = createAvailabilityCache({});
      // Non possiamo testare direttamente il TTL default senza aspettare 5min,
      // ma verifichiamo che la cache funzioni con il default
      const entries = [makeEntry()];
      const registry = makeRegistry(entries);
      let probeCount = 0;
      const probeFn = async () => {
        probeCount++;
        return { active: true, error: null, models: [] };
      };

      await cache.getActiveProviders(registry, probeFn);
      await cache.getActiveProviders(registry, probeFn);
      assert.equal(probeCount, 1);
    });
  });
});
