const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildMeteringRecord,
  createNoopMeteringSink,
  createJsonlMeteringSink,
  emitMetering,
  redactObject,
  readJsonlFile,
  queryMeteringRecords,
  computeMeteringStats,
  matchesFilters,
} = require("../lib/metering");

test("buildMeteringRecord normalizes provider attempts and totals", () => {
  const record = buildMeteringRecord({
    requestId: "req-1",
    traceId: "tr-1",
    provider: "github-copilot",
    providerAttempts: [
      { id: "github-copilot-a", endpoint: "/chat/completions", error: "rate-limit" },
      { id: "github-copilot-b", endpoint: "/responses" },
    ],
    modelRequested: "claude-sonnet-4.5",
    modelUsed: "claude-sonnet-4.5",
    endpoint: "/responses",
    durationMs: 1234,
    promptTokens: 11,
    completionTokens: 5,
  });
  assert.equal(record.fallback_count, 1);
  assert.equal(record.total_tokens, 16);
  assert.equal(record.provider, "github-copilot");
  assert.equal(record.success, true);
});

test("buildMeteringRecord emits per-level user IDs from hierarchyContext", () => {
  const record = buildMeteringRecord({
    requestId: "req-uid",
    hierarchyContext: {
      master_company: "mc-1",
      tenant_id: "t-1",
      client_id: "c-1",
      project_id: "p-1",
      scope_type: "project",
      scope_id: "p-1",
      user_id: "u-generic",
      master_user_id: "u-mc",
      tenant_user_id: "u-tenant",
      client_user_id: "u-client",
      project_user_id: "u-project",
    },
  });
  assert.equal(record.user_id, "u-generic");
  assert.equal(record.master_user_id, "u-mc");
  assert.equal(record.tenant_user_id, "u-tenant");
  assert.equal(record.client_user_id, "u-client");
  assert.equal(record.project_user_id, "u-project");
});

test("buildMeteringRecord per-level user IDs default to null when absent", () => {
  const record = buildMeteringRecord({
    requestId: "req-no-uid",
    hierarchyContext: {
      master_company: "mc-1",
      project_id: "p-1",
      scope_type: "project",
      scope_id: "p-1",
    },
  });
  assert.equal(record.master_user_id, null);
  assert.equal(record.tenant_user_id, null);
  assert.equal(record.client_user_id, null);
  assert.equal(record.project_user_id, null);
});

test("createNoopMeteringSink stores records in memory for inspection", async () => {
  const sink = createNoopMeteringSink();
  await sink.record({ a: 1 });
  await sink.record({ a: 2 });
  assert.equal(sink.inspect().length, 2);
});

test("createJsonlMeteringSink writes redacted records to disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-"));
  const filePath = path.join(dir, "meter.jsonl");
  const sink = createJsonlMeteringSink({ filePath });
  await sink.record({
    request_id: "r-1",
    messages: [{ role: "user", content: "secret prompt" }],
    api_key: "sk-shouldnotleak",
    nested: { token: "abc" },
  });
  const written = fs.readFileSync(filePath, "utf8").trim().split("\n");
  assert.equal(written.length, 1);
  const row = JSON.parse(written[0]);
  assert.equal(row.messages, "[redacted]");
  assert.equal(row.api_key, "[redacted]");
  assert.equal(row.nested.token, "[redacted]");
  assert.equal(row.request_id, "r-1");
});

test("emitMetering returns METERING_SINK_FAILED when sink throws", async () => {
  const sink = {
    record: async () => {
      throw new Error("disk full");
    },
  };
  const result = await emitMetering(sink, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "METERING_SINK_FAILED");
});

test("redactObject scrubs sensitive keys recursively", () => {
  const out = redactObject({
    safe: "ok",
    authorization: "Bearer secret",
    payload: { content: [{ text: "hi" }], tools: ["t1"], nested: { access_token: "x" } },
  });
  assert.equal(out.safe, "ok");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.payload.content, "[redacted]");
  assert.equal(out.payload.tools, "[redacted]");
  assert.equal(out.payload.nested.access_token, "[redacted]");
});

// ---------------------------------------------------------------------------
// readJsonlFile
// ---------------------------------------------------------------------------

test("readJsonlFile returns empty array when file does not exist", () => {
  const result = readJsonlFile("/nonexistent/path/that/does/not/exist.jsonl");
  assert.deepEqual(result, []);
});

test("readJsonlFile parses valid JSONL and skips malformed lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-rjsonl-"));
  const filePath = path.join(dir, "test.jsonl");
  fs.writeFileSync(filePath, '{"a":1}\n{bad json}\n{"a":2}\n\n', "utf8");
  const result = readJsonlFile(filePath);
  assert.equal(result.length, 2);
  assert.equal(result[0].a, 1);
  assert.equal(result[1].a, 2);
});

// ---------------------------------------------------------------------------
// matchesFilters
// ---------------------------------------------------------------------------

test("matchesFilters returns true when no filters applied", () => {
  assert.equal(matchesFilters({ timestamp: "2026-05-01T10:00:00Z", project_id: "p-1" }, {}), true);
});

test("matchesFilters applies from/to range", () => {
  const rec = { timestamp: "2026-05-02T12:00:00Z" };
  assert.equal(matchesFilters(rec, { from: "2026-05-01T00:00:00Z", to: "2026-05-03T00:00:00Z" }), true);
  assert.equal(matchesFilters(rec, { from: "2026-05-03T00:00:00Z" }), false);
  assert.equal(matchesFilters(rec, { to: "2026-05-01T00:00:00Z" }), false);
});

test("matchesFilters applies success filter", () => {
  assert.equal(matchesFilters({ success: true }, { success: true }), true);
  assert.equal(matchesFilters({ success: true }, { success: false }), false);
  assert.equal(matchesFilters({ success: false }, { success: false }), true);
  // records without explicit success field default to true
  assert.equal(matchesFilters({}, { success: true }), true);
  assert.equal(matchesFilters({}, { success: false }), false);
});

test("matchesFilters applies string equality filters", () => {
  const rec = { project_id: "p-1", provider: "copilot", scope_type: "project" };
  assert.equal(matchesFilters(rec, { project_id: "p-1" }), true);
  assert.equal(matchesFilters(rec, { project_id: "p-2" }), false);
  assert.equal(matchesFilters(rec, { provider: "copilot", scope_type: "project" }), true);
  assert.equal(matchesFilters(rec, { provider: "openai" }), false);
});

// ---------------------------------------------------------------------------
// queryMeteringRecords
// ---------------------------------------------------------------------------

test("queryMeteringRecords returns all records when no filters", () => {
  const records = [
    { timestamp: "2026-05-01T10:00:00Z", project_id: "p-1" },
    { timestamp: "2026-05-02T10:00:00Z", project_id: "p-2" },
    { timestamp: "2026-05-03T10:00:00Z", project_id: "p-1" },
  ];
  const result = queryMeteringRecords(records, { order: "asc" });
  assert.equal(result.total, 3);
  assert.equal(result.records.length, 3);
  assert.equal(result.order, "asc");
});

test("queryMeteringRecords desc order returns newest first", () => {
  const records = [
    { timestamp: "2026-05-01T10:00:00Z" },
    { timestamp: "2026-05-02T10:00:00Z" },
    { timestamp: "2026-05-03T10:00:00Z" },
  ];
  const result = queryMeteringRecords(records, { order: "desc" });
  assert.equal(result.records[0].timestamp, "2026-05-03T10:00:00Z");
  assert.equal(result.records[2].timestamp, "2026-05-01T10:00:00Z");
});

test("queryMeteringRecords applies limit and offset", () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ idx: i }));
  const result = queryMeteringRecords(records, { limit: 3, offset: 4, order: "asc" });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].idx, 4);
  assert.equal(result.total, 10); // total is pre-pagination count
  assert.equal(result.limit, 3);
  assert.equal(result.offset, 4);
});

test("queryMeteringRecords filters by project_id", () => {
  const records = [
    { project_id: "p-1", timestamp: "2026-05-01T10:00:00Z" },
    { project_id: "p-2", timestamp: "2026-05-01T11:00:00Z" },
    { project_id: "p-1", timestamp: "2026-05-01T12:00:00Z" },
  ];
  const result = queryMeteringRecords(records, { filters: { project_id: "p-1" }, order: "asc" });
  assert.equal(result.total, 2);
  assert.equal(result.records.every((r) => r.project_id === "p-1"), true);
});

test("queryMeteringRecords caps limit at 1000", () => {
  const records = [];
  const result = queryMeteringRecords(records, { limit: 99999 });
  assert.equal(result.limit, 1000);
});

// ---------------------------------------------------------------------------
// computeMeteringStats
// ---------------------------------------------------------------------------

test("computeMeteringStats on empty array returns zeroes and nulls", () => {
  const stats = computeMeteringStats([]);
  assert.equal(stats.total_requests, 0);
  assert.equal(stats.success_count, 0);
  assert.equal(stats.error_count, 0);
  assert.equal(stats.total_tokens, 0);
  assert.equal(stats.avg_duration_ms, null);
  assert.equal(stats.p50_duration_ms, null);
  assert.equal(stats.p95_duration_ms, null);
  assert.equal(stats.earliest_timestamp, null);
  assert.equal(stats.latest_timestamp, null);
  assert.deepEqual(stats.by_provider, {});
  assert.deepEqual(stats.by_model, {});
});

test("computeMeteringStats aggregates token counts, latency, and breakdowns", () => {
  const records = [
    {
      success: true,
      tokens_input: 100,
      tokens_output: 20,
      duration_ms: 500,
      timestamp: "2026-05-01T10:00:00Z",
      provider: "copilot",
      model_used: "claude-sonnet-4.5",
      scope_type: "project",
      project_id: "p-1",
    },
    {
      success: true,
      tokens_input: 200,
      tokens_output: 40,
      duration_ms: 1000,
      timestamp: "2026-05-02T10:00:00Z",
      provider: "copilot",
      model_used: "claude-sonnet-4.5",
      scope_type: "project",
      project_id: "p-1",
    },
    {
      success: false,
      tokens_input: 50,
      tokens_output: 0,
      duration_ms: 200,
      timestamp: "2026-05-03T10:00:00Z",
      provider: "openai",
      model_used: "gpt-4.1",
      scope_type: "project",
      project_id: "p-2",
    },
  ];
  const stats = computeMeteringStats(records);
  assert.equal(stats.total_requests, 3);
  assert.equal(stats.success_count, 2);
  assert.equal(stats.error_count, 1);
  assert.equal(stats.total_tokens_input, 350);
  assert.equal(stats.total_tokens_output, 60);
  assert.equal(stats.total_tokens, 410);
  assert.equal(stats.avg_tokens_input, 117); // Math.round(350/3)
  assert.equal(stats.avg_duration_ms, 567);  // Math.round(1700/3)
  assert.equal(typeof stats.p50_duration_ms, "number");
  assert.equal(typeof stats.p95_duration_ms, "number");
  assert.equal(stats.earliest_timestamp, "2026-05-01T10:00:00Z");
  assert.equal(stats.latest_timestamp, "2026-05-03T10:00:00Z");
  assert.equal(stats.by_provider["copilot"].requests, 2);
  assert.equal(stats.by_provider["openai"].requests, 1);
  assert.equal(stats.by_model["claude-sonnet-4.5"].requests, 2);
  assert.equal(stats.by_model["gpt-4.1"].requests, 1);
  assert.equal(stats.by_project_id["p-1"].requests, 2);
  assert.equal(stats.by_project_id["p-2"].requests, 1);
});

test("createJsonlMeteringSink.computeStats returns aggregate stats with by_model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-sink-stats-"));
  const filePath = path.join(dir, "meter.jsonl");
  const sink = createJsonlMeteringSink({ filePath });
  await sink.record({ request_id: "r-1", provider: "openai", model_used: "gpt-4.1", success: true, tokens_input: 10, tokens_output: 5, timestamp: "2026-05-01T10:00:00Z" });
  await sink.record({ request_id: "r-2", provider: "openai", model_used: "gpt-4.1", success: true, tokens_input: 20, tokens_output: 10, timestamp: "2026-05-02T10:00:00Z" });

  const stats = sink.computeStats({});
  assert.equal(stats.total_requests, 2);
  assert.equal(stats.by_provider.openai.requests, 2);
  assert.equal(stats.by_model["gpt-4.1"].requests, 2);
  assert.equal(stats.filtered_total, 2);
});

// ---------------------------------------------------------------------------
// Sink query() method
// ---------------------------------------------------------------------------

test("createNoopMeteringSink.query returns paginated results", async () => {
  const sink = createNoopMeteringSink();
  for (let i = 0; i < 5; i++) {
    await sink.record({ idx: i, project_id: "p-1", timestamp: `2026-05-0${i + 1}T10:00:00Z` });
  }
  const result = sink.query({ limit: 2, offset: 0, order: "asc" });
  assert.equal(result.total, 5);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].idx, 0);
});

test("createJsonlMeteringSink.query reads and filters JSONL file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-sink-q-"));
  const filePath = path.join(dir, "meter.jsonl");
  const sink = createJsonlMeteringSink({ filePath });
  await sink.record({ request_id: "r-1", project_id: "p-1", success: true, tokens_input: 10, tokens_output: 5, timestamp: "2026-05-01T10:00:00Z" });
  await sink.record({ request_id: "r-2", project_id: "p-2", success: false, tokens_input: 20, tokens_output: 0, timestamp: "2026-05-02T10:00:00Z" });
  await sink.record({ request_id: "r-3", project_id: "p-1", success: true, tokens_input: 30, tokens_output: 8, timestamp: "2026-05-03T10:00:00Z" });

  const allResult = sink.query({ order: "asc" });
  assert.equal(allResult.total, 3);

  const filteredResult = sink.query({ filters: { project_id: "p-1" }, order: "asc" });
  assert.equal(filteredResult.total, 2);
  assert.equal(filteredResult.records.every((r) => r.project_id === "p-1"), true);
});
