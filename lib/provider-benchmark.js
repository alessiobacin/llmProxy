"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BENCHMARK_FILE = "provider-benchmark.json";

function readBenchmarkStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { providers: {}, lastUpdatedMs: 0 };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { providers: {}, lastUpdatedMs: 0 };
    return {
      providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {},
      lastUpdatedMs: Number(parsed.lastUpdatedMs) || 0,
    };
  } catch {
    return { providers: {}, lastUpdatedMs: 0 };
  }
}

function writeBenchmarkStore(filePath, store) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  } catch {
    // best effort
  }
}

function resolveBenchmarkMinutes(override) {
  if (typeof override === "number" && override > 0) return override;
  const env = String(process.env.LLMPROXY_PROVIDER_BENCHMARK_MINUTES || "").trim();
  const num = Number(env);
  if (Number.isFinite(num) && num > 0) return num;
  return 0;
}

function createProviderBenchmark({ filePath, fetchFn = fetch, probeFn = null } = {}) {
  if (!filePath) throw new Error("provider-benchmark filePath required");
  const probes = new Map();
  let intervalHandle = null;

  function getStore() {
    return readBenchmarkStore(filePath);
  }

  function getLastResult(providerId) {
    const store = getStore();
    return store.providers[providerId] || null;
  }

  function getAllResults() {
    const store = getStore();
    return Object.entries(store.providers).map(([providerId, value]) => ({
      providerId,
      durationMs: value?.durationMs || null,
      ok: value?.ok !== false,
      timestamp: value?.timestamp || null,
      model: value?.model || null,
    }));
  }

  async function probeProvider(provider) {
    if (!provider || !provider.access_token) return null;
    if (probes.has(provider.id)) return probes.get(provider.id);
    const task = (async () => {
      const startedAt = Date.now();
      const model = provider.default_model || "";
      let ok = false;
      try {
        const result = typeof probeFn === "function"
          ? await probeFn({ provider, model, fetchFn })
          : null;
        ok = !!(result && (result.ok || result.success));
      } catch {
        ok = false;
      }
      const entry = { ok, durationMs: Date.now() - startedAt, model, timestamp: Date.now() };
      const store = getStore();
      store.providers[provider.id] = entry;
      store.lastUpdatedMs = Date.now();
      writeBenchmarkStore(filePath, store);
      return entry;
    })();
    probes.set(provider.id, task);
    try {
      return await task;
    } finally {
      probes.delete(provider.id);
    }
  }

  async function runAll(providers) {
    if (!Array.isArray(providers)) return [];
    return Promise.all(providers.map((provider) => probeProvider(provider)));
  }

  function start(providers, minutesOverride = null) {
    const minutes = resolveBenchmarkMinutes(minutesOverride);
    if (!minutes || !Array.isArray(providers) || providers.length === 0) return;
    if (intervalHandle) return;
    const tick = () => {
      runAll(providers).catch(() => null);
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

  return {
    filePath,
    getStore,
    getLastResult,
    getAllResults,
    probeProvider,
    runAll,
    start,
    stop,
  };
}

module.exports = {
  createProviderBenchmark,
  readBenchmarkStore,
  writeBenchmarkStore,
  resolveBenchmarkMinutes,
  DEFAULT_BENCHMARK_FILE,
};
