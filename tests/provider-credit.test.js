const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatCreditAmount,
  readJsonResponseSafe,
  fetchProviderCreditInfo,
  createCreditCache,
} = require("../lib/provider-credit");

test("formatCreditAmount formats with currency", () => {
  assert.equal(formatCreditAmount(12.34, "USD"), "USD 12.34");
  assert.equal(formatCreditAmount(0, "EUR"), "EUR 0.00");
  assert.equal(formatCreditAmount(100), "100.00");
  assert.equal(formatCreditAmount("invalid"), "");
  assert.equal(formatCreditAmount(undefined), "");
});

test("readJsonResponseSafe handles valid and invalid responses", async () => {
  const validResponse = { json: async () => ({ data: "test" }) };
  const result = await readJsonResponseSafe(validResponse);
  assert.deepEqual(result, { data: "test" });

  const invalidResponse = { json: async () => { throw new Error("parse error"); } };
  const nullResult = await readJsonResponseSafe(invalidResponse);
  assert.equal(nullResult, null);

  assert.equal(await readJsonResponseSafe(null), null);
  assert.equal(await readJsonResponseSafe({}), null);
});

test("fetchProviderCreditInfo returns n/a for missing provider or token", async () => {
  const mockFetch = async () => ({ ok: true, json: async () => ({}) });

  const noProvider = await fetchProviderCreditInfo({}, mockFetch);
  assert.deepEqual(noProvider, { label: "n/a", color: "dim" });

  const noToken = await fetchProviderCreditInfo({ provider: "deepseek" }, mockFetch);
  assert.deepEqual(noToken, { label: "n/a", color: "dim" });
});

test("fetchProviderCreditInfo fetches DeepSeek balance", async () => {
  const mockFetch = async (url) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    return {
      ok: true,
      json: async () => ({
        balance_infos: [
          { currency: "USD", total_balance: "25.50" },
          { currency: "CNY", total_balance: "100.00" },
        ],
      }),
    };
  };

  const result = await fetchProviderCreditInfo(
    { provider: "deepseek", access_token: "test-token" },
    mockFetch,
  );
  assert.deepEqual(result, { label: "USD 25.50", color: "blue" });
});

test("fetchProviderCreditInfo fetches Kimi balance", async () => {
  const mockFetch = async (url) => {
    assert.equal(url, "https://api.moonshot.ai/v1/users/me/balance");
    return {
      ok: true,
      json: async () => ({ data: { available_balance: 15.75 } }),
    };
  };

  const result = await fetchProviderCreditInfo(
    { provider: "kimi", access_token: "test-token" },
    mockFetch,
  );
  assert.deepEqual(result, { label: "15.75", color: "blue" });
});

test("fetchProviderCreditInfo fetches OpenRouter credits", async () => {
  const mockFetch = async (url) => {
    assert.equal(url, "https://openrouter.ai/api/v1/credits");
    return {
      ok: true,
      json: async () => ({ data: { total_credits: 100, total_usage: 30 } }),
    };
  };

  const result = await fetchProviderCreditInfo(
    { provider: "openrouter", access_token: "test-token" },
    mockFetch,
  );
  assert.deepEqual(result, { label: "70.00 credits", color: "blue" });
});

test("fetchProviderCreditInfo returns unavailable on API error", async () => {
  const mockFetch = async () => ({ ok: false, status: 500 });

  const result = await fetchProviderCreditInfo(
    { provider: "deepseek", access_token: "test-token" },
    mockFetch,
  );
  assert.deepEqual(result, { label: "unavailable", color: "red" });
});

test("fetchProviderCreditInfo returns unavailable on network error", async () => {
  const mockFetch = async () => { throw new Error("network error"); };

  const result = await fetchProviderCreditInfo(
    { provider: "deepseek", access_token: "test-token" },
    mockFetch,
  );
  assert.deepEqual(result, { label: "unavailable", color: "red" });
});

test("fetchProviderCreditInfo caches results", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({ data: { available_balance: 10 } }),
    };
  };

  const cache = createCreditCache();
  const provider = { provider: "kimi", access_token: "test-token" };

  await fetchProviderCreditInfo(provider, mockFetch, cache);
  await fetchProviderCreditInfo(provider, mockFetch, cache);

  assert.equal(callCount, 1);
});

test("createCreditCache respects TTL", async () => {
  const cache = createCreditCache();
  cache.set("key", Promise.resolve({ label: "test" }));

  assert.equal(cache.has("key"), true);
  const value = await cache.get("key");
  assert.deepEqual(value, { label: "test" });

  cache.clear();
  assert.equal(cache.has("key"), false);
});

test("fetchProviderCreditInfo returns n/a for unknown provider", async () => {
  const mockFetch = async () => ({ ok: true, json: async () => ({}) });

  const result = await fetchProviderCreditInfo(
    { provider: "unknown-provider", access_token: "test-token" },
    mockFetch,
  );
  assert.deepEqual(result, { label: "n/a", color: "dim" });
});
