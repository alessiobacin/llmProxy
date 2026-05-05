"use strict";

/**
 * Tests for lib/metering-dblayer.js
 *
 * Uses a fake fetchFn so no real HTTP connections are made.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDbLayerSink, resolveDbLayerUrl, buildQueryString } = require("../lib/metering-dblayer");
const { createNoopMeteringSink } = require("../lib/metering");

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a fake fetch that returns a given status/body for each URL pattern.
 *
 * routes: [{ match: string | RegExp, status: number, body: object }]
 * Default for unmatched routes: { status: 200, body: { ok: true } }
 */
function makeFetch(routes = [], defaultStatus = 200) {
  const calls = [];

  async function fakeFetch(url, opts = {}) {
    calls.push({ url, method: opts.method || "GET", body: opts.body });

    for (const route of routes) {
      const matched =
        typeof route.match === "string"
          ? url.includes(route.match)
          : route.match.test(url);
      if (matched) {
        const body = route.body ?? { ok: true };
        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          json: async () => body,
        };
      }
    }

    return {
      ok: defaultStatus >= 200 && defaultStatus < 300,
      status: defaultStatus,
      json: async () => ({ ok: true }),
    };
  }

  fakeFetch.calls = calls;
  return fakeFetch;
}

/** Wait until probe has run at least once (background async) */
async function waitForProbe() {
  await new Promise((r) => setTimeout(r, 20));
}

// ─── resolveDbLayerUrl ───────────────────────────────────────────────────────

test("resolveDbLayerUrl: uses DBLAYER_URL when set", () => {
  const old = process.env.DBLAYER_URL;
  process.env.DBLAYER_URL = "http://custom:9999";
  assert.equal(resolveDbLayerUrl(), "http://custom:9999");
  if (old === undefined) delete process.env.DBLAYER_URL;
  else process.env.DBLAYER_URL = old;
});

test("resolveDbLayerUrl: strips trailing slash from DBLAYER_URL", () => {
  const old = process.env.DBLAYER_URL;
  process.env.DBLAYER_URL = "http://custom:9999/";
  assert.equal(resolveDbLayerUrl(), "http://custom:9999");
  if (old === undefined) delete process.env.DBLAYER_URL;
  else process.env.DBLAYER_URL = old;
});

test("resolveDbLayerUrl: falls back to 5046 in development", () => {
  const oldURL = process.env.DBLAYER_URL;
  const oldEnv = process.env.LLMPROXY_ENV;
  const oldNode = process.env.NODE_ENV;
  delete process.env.DBLAYER_URL;
  process.env.LLMPROXY_ENV = "development";
  delete process.env.NODE_ENV;
  assert.equal(resolveDbLayerUrl(), "http://localhost:5046");
  if (oldURL !== undefined) process.env.DBLAYER_URL = oldURL;
  if (oldEnv !== undefined) process.env.LLMPROXY_ENV = oldEnv;
  else delete process.env.LLMPROXY_ENV;
  if (oldNode !== undefined) process.env.NODE_ENV = oldNode;
});

test("resolveDbLayerUrl: port 6046 for staging", () => {
  const oldURL = process.env.DBLAYER_URL;
  const oldEnv = process.env.LLMPROXY_ENV;
  delete process.env.DBLAYER_URL;
  process.env.LLMPROXY_ENV = "staging";
  assert.equal(resolveDbLayerUrl(), "http://localhost:6046");
  if (oldURL !== undefined) process.env.DBLAYER_URL = oldURL;
  process.env.LLMPROXY_ENV = oldEnv;
});

test("resolveDbLayerUrl: port 7046 for production", () => {
  const oldURL = process.env.DBLAYER_URL;
  const oldEnv = process.env.LLMPROXY_ENV;
  delete process.env.DBLAYER_URL;
  process.env.LLMPROXY_ENV = "production";
  assert.equal(resolveDbLayerUrl(), "http://localhost:7046");
  if (oldURL !== undefined) process.env.DBLAYER_URL = oldURL;
  process.env.LLMPROXY_ENV = oldEnv;
});

// ─── buildQueryString ─────────────────────────────────────────────────────────

test("buildQueryString: empty opts returns empty string", () => {
  assert.equal(buildQueryString({}), "");
});

test("buildQueryString: encodes from/to dates", () => {
  const qs = buildQueryString({ filters: { from: "2025-01-01T00:00:00Z", to: "2025-12-31T23:59:59Z" } });
  assert.ok(qs.includes("from=2025-01-01"), `got: ${qs}`);
  assert.ok(qs.includes("to=2025-12-31"), `got: ${qs}`);
});

test("buildQueryString: encodes success filter", () => {
  const qs = buildQueryString({ filters: { success: false } });
  assert.ok(qs.includes("success=false"), `got: ${qs}`);
});

test("buildQueryString: encodes string filter fields", () => {
  const qs = buildQueryString({ filters: { project_id: "proj-1", provider: "openai" } });
  assert.ok(qs.includes("project_id=proj-1"));
  assert.ok(qs.includes("provider=openai"));
});

test("buildQueryString: encodes limit/offset/order", () => {
  const qs = buildQueryString({ limit: 50, offset: 10, order: "asc" });
  assert.ok(qs.includes("limit=50"));
  assert.ok(qs.includes("offset=10"));
  assert.ok(qs.includes("order=asc"));
});

// ─── createDbLayerSink: health probe ─────────────────────────────────────────

test("createDbLayerSink throws when url is empty string", () => {
  assert.throws(
    () => createDbLayerSink({ url: "" }),
    /requires.*url/i,
  );
});

test("createDbLayerSink: isAvailable() is false before first probe", () => {
  const fetchFn = makeFetch();
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  // Before await the background probe hasn't resolved yet
  assert.equal(sink.isAvailable(), false);
  sink.close();
});

test("createDbLayerSink: isAvailable() is true after successful probe", async () => {
  const fetchFn = makeFetch([{ match: "/health", status: 200 }]);
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  await waitForProbe();
  assert.equal(sink.isAvailable(), true);
  await sink.close();
});

test("createDbLayerSink: isAvailable() is false after failed probe", async () => {
  const fetchFn = makeFetch([{ match: "/health", status: 503 }]);
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  await waitForProbe();
  assert.equal(sink.isAvailable(), false);
  await sink.close();
});

test("createDbLayerSink: isAvailable() is false when fetch throws", async () => {
  async function failFetch() { throw new Error("ECONNREFUSED"); }
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn: failFetch });
  await waitForProbe();
  assert.equal(sink.isAvailable(), false);
  await sink.close();
});

// ─── record() ────────────────────────────────────────────────────────────────

test("record: POSTs to db-layer when available", async () => {
  const fetchFn = makeFetch([
    { match: "/health", status: 200 },
    { match: "/metering", status: 200 },
  ]);
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  await waitForProbe();

  await sink.record({ provider: "openai", tokens_input: 10 });

  const meteringCall = fetchFn.calls.find((c) => c.url.includes("/metering") && c.method === "POST");
  assert.ok(meteringCall, "should have POSTed to /metering");
  const sent = JSON.parse(meteringCall.body);
  assert.equal(sent.provider, "openai");
  await sink.close();
});

test("record: falls back to fallbackSink when db-layer unavailable", async () => {
  const fetchFn = makeFetch([{ match: "/health", status: 503 }]);
  const fallback = createNoopMeteringSink();
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn, fallbackSink: fallback });
  await waitForProbe();

  await sink.record({ provider: "copilot", tokens_input: 5 });

  assert.equal(fallback.inspect().length, 1);
  assert.equal(fallback.inspect()[0].provider, "copilot");
  await sink.close();
});

test("record: falls back to fallbackSink when POST fails", async () => {
  const fetchFn = makeFetch([
    { match: "/health", status: 200 },
    { match: "/metering", status: 500 },
  ]);
  const fallback = createNoopMeteringSink();
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn, fallbackSink: fallback });
  await waitForProbe();

  await sink.record({ provider: "copilot" });

  assert.equal(fallback.inspect().length, 1);
  assert.equal(fallback.inspect()[0].provider, "copilot");
  await sink.close();
});

// ─── query() ─────────────────────────────────────────────────────────────────

test("query: fetches from db-layer when available", async () => {
  const dbResponse = { records: [{ provider: "openai" }], total: 1, limit: 100, offset: 0, order: "desc" };
  const fetchFn = makeFetch([
    { match: "/health", status: 200 },
    { match: "/metering", status: 200, body: dbResponse },
  ]);
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  await waitForProbe();

  const result = await sink.query({});
  assert.equal(result.total, 1);
  assert.equal(result.records[0].provider, "openai");
  await sink.close();
});

test("query: falls back to fallbackSink when db-layer unavailable", async () => {
  const fetchFn = makeFetch([{ match: "/health", status: 503 }]);
  const fallback = createNoopMeteringSink();
  // Seed one record via the public record() method
  await fallback.record({ provider: "copilot", timestamp: "2025-01-01T10:00:00.000Z" });
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn, fallbackSink: fallback });
  await waitForProbe();

  const result = await sink.query({});
  assert.equal(result.total, 1);
  await sink.close();
});

test("query: returns empty result when unavailable and no fallback", async () => {
  const fetchFn = makeFetch([{ match: "/health", status: 503 }]);
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  await waitForProbe();

  const result = await sink.query({ limit: 50 });
  assert.deepEqual(result.records, []);
  assert.equal(result.total, 0);
  assert.equal(result.limit, 50);
  await sink.close();
});

// ─── computeStats() ──────────────────────────────────────────────────────────

test("computeStats: fetches from db-layer stats endpoint when available", async () => {
  const statsBody = { total_requests: 42, success_count: 40, error_count: 2 };
  const fetchFn = makeFetch([
    { match: "/health", status: 200 },
    { match: "/metering/stats", status: 200, body: statsBody },
  ]);
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn });
  await waitForProbe();

  const stats = await sink.computeStats({});
  assert.equal(stats.total_requests, 42);
  await sink.close();
});

test("computeStats: falls back to fallback computeStats when unavailable", async () => {
  const fetchFn = makeFetch([{ match: "/health", status: 503 }]);
  const fallback = createNoopMeteringSink();
  // Seed one record via the public record() method
  await fallback.record(
    { provider: "openai", success: true, tokens_input: 10, tokens_output: 5, duration_ms: 100, timestamp: "2025-01-01T10:00:00.000Z" },
  );
  const sink = createDbLayerSink({ url: "http://localhost:5046", fetchFn, fallbackSink: fallback });
  await waitForProbe();

  const stats = await sink.computeStats({});
  assert.equal(stats.total_requests, 1);
  assert.equal(stats.success_count, 1);
  await sink.close();
});
