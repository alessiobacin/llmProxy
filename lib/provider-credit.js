const crypto = require("node:crypto");

function formatCreditAmount(amount, currency = "") {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "";
  const formatted = numeric.toFixed(2);
  const normalizedCurrency = String(currency || "").trim().toUpperCase();
  return normalizedCurrency ? `${normalizedCurrency} ${formatted}` : formatted;
}

async function readJsonResponseSafe(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchProviderCreditInfo(provider, fetchFn, cache = new Map()) {
  const providerKind = String(provider?.provider || provider?.id || "").trim().toLowerCase();
  const accessToken = String(provider?.access_token || "").trim();
  const endpointVariant = String(provider?.endpoint_variant || "").trim().toLowerCase();
  if (!providerKind || !accessToken) return { label: "n/a", color: "dim" };

  const cacheKey = crypto
    .createHash("sha1")
    .update(`${providerKind}|${endpointVariant}|${accessToken}`)
    .digest("hex");

  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const unavailable = { label: "unavailable", color: "red" };
    const request = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(5000) : undefined,
    };

    try {
      if (providerKind === "deepseek") {
        const response = await fetchFn("https://api.deepseek.com/user/balance", request);
        if (!response?.ok) return unavailable;
        const payload = await readJsonResponseSafe(response);
        const balances = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
        const preferred = balances.find((entry) => String(entry?.currency || "").trim().toUpperCase() === "USD") || balances[0];
        const label = formatCreditAmount(preferred?.total_balance, preferred?.currency);
        return label ? { label, color: "blue" } : unavailable;
      }

      if (providerKind === "kimi") {
        const response = await fetchFn("https://api.moonshot.ai/v1/users/me/balance", request);
        if (!response?.ok) return unavailable;
        const payload = await readJsonResponseSafe(response);
        const label = formatCreditAmount(payload?.data?.available_balance);
        return label ? { label, color: "blue" } : unavailable;
      }

      if (providerKind === "openrouter") {
        const response = await fetchFn("https://openrouter.ai/api/v1/credits", request);
        if (!response?.ok) return unavailable;
        const payload = await readJsonResponseSafe(response);
        const totalCredits = Number(payload?.data?.total_credits);
        const totalUsage = Number(payload?.data?.total_usage);
        if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return unavailable;
        const remainingCredits = Math.max(0, totalCredits - totalUsage);
        return { label: `${remainingCredits.toFixed(2)} credits`, color: "blue" };
      }

      return { label: "n/a", color: "dim" };
    } catch {
      return unavailable;
    }
  })();

  cache.set(cacheKey, promise);
  return promise;
}

function createCreditCache() {
  const store = new Map();
  const timestamps = new Map();
  const ttlMs = 5 * 60 * 1000;

  return {
    get(key) {
      if (!store.has(key)) return undefined;
      const ts = timestamps.get(key) || 0;
      if (Date.now() - ts > ttlMs) {
        store.delete(key);
        timestamps.delete(key);
        return undefined;
      }
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
      timestamps.set(key, Date.now());
    },
    has(key) {
      return this.get(key) !== undefined;
    },
    clear() {
      store.clear();
      timestamps.clear();
    },
  };
}

module.exports = {
  formatCreditAmount,
  readJsonResponseSafe,
  fetchProviderCreditInfo,
  createCreditCache,
};
