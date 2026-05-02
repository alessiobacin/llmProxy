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
