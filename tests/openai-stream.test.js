"use strict";

// Contratto streaming /v1/chat/completions (T1): il flusso SSE Anthropic emesso
// dal gateway viene tradotto in chunk OpenAI chat.completion.chunk.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createOpenAiStreamTranslator,
  anthropicSseWriteToOpenAiChunks,
} = require("../lib/openai-format");
const { createApp } = require("../lib/app");
const { createTokenStore } = require("../lib/token-store");
const { createProviderRegistry } = require("../lib/provider-registry");

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------- unit: traduttore statoful ----------

test("translator emits a first chat.completion.chunk with assistant role on message_start", () => {
  const t = createOpenAiStreamTranslator({ model: "openai:gpt-4o-mini" });
  const chunks = anthropicSseWriteToOpenAiChunks(t, sse("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "gpt-4o-mini", usage: { input_tokens: 3, output_tokens: 0 } },
  }));

  assert.equal(chunks.length, 1);
  const chunk = JSON.parse(chunks[0].replace(/^data: /, "").replace(/\n\n$/, ""));
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.match(chunk.id, /^chatcmpl-/);
  assert.equal(typeof chunk.created, "number");
  assert.equal(chunk.model, "openai:gpt-4o-mini");
  assert.deepEqual(chunk.choices, [{
    index: 0,
    delta: { role: "assistant", content: "" },
    finish_reason: null,
  }]);
});

test("translator maps text_delta to content deltas and terminates with [DONE]", () => {
  const t = createOpenAiStreamTranslator({ model: "gpt-4o-mini" });
  const writes = [
    sse("message_start", { type: "message_start", message: { id: "m", model: "gpt-4o-mini" } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ciao" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " mondo" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
  ];

  let all = [];
  for (const w of writes) all = all.concat(anthropicSseWriteToOpenAiChunks(t, w));

  const parsed = all.filter((line) => line !== "data: [DONE]\n\n").map((line) => JSON.parse(line.replace(/^data: /, "").replace(/\n\n$/, "")));
  const contentDeltas = parsed.filter((c) => c.choices?.[0]?.delta?.content);
  assert.deepEqual(contentDeltas.map((c) => c.choices[0].delta.content), ["Ciao", " mondo"]);

  const finishChunk = parsed.find((c) => c.choices?.[0]?.finish_reason);
  assert.ok(finishChunk, "finish_reason chunk present");
  assert.equal(finishChunk.choices[0].finish_reason, "stop");

  assert.equal(all[all.length - 1], "data: [DONE]\n\n", "stream terminates with [DONE]");
});

test("translator maps stop_reason max_tokens to finish_reason length and tool_use to tool_calls", () => {
  for (const [stopReason, expected] of [["max_tokens", "length"], ["tool_use", "tool_calls"]]) {
    const t = createOpenAiStreamTranslator({ model: "m" });
    const writes = [
      sse("message_start", { type: "message_start", message: { id: "m", model: "m" } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: {} }),
      sse("message_stop", { type: "message_stop" }),
    ];
    let all = [];
    for (const w of writes) all = all.concat(anthropicSseWriteToOpenAiChunks(t, w));
    const parsed = all.filter((line) => line !== "data: [DONE]\n\n").map((line) => JSON.parse(line.replace(/^data: /, "").replace(/\n\n$/, "")));
    const finishChunk = parsed.find((c) => c.choices?.[0]?.finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, expected);
  }
});

test("translator maps tool_use blocks to OpenAI tool_calls deltas", () => {
  const t = createOpenAiStreamTranslator({ model: "m" });
  const writes = [
    sse("message_start", { type: "message_start", message: { id: "m", model: "m" } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }),
    sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"city\":\"Milano\"}" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 8, output_tokens: 4 } }),
    sse("message_stop", { type: "message_stop" }),
  ];

  let all = [];
  for (const w of writes) all = all.concat(anthropicSseWriteToOpenAiChunks(t, w));
  const parsed = all.filter((line) => line !== "data: [DONE]\n\n").map((line) => JSON.parse(line.replace(/^data: /, "").replace(/\n\n$/, "")));

  const startDelta = parsed.find((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.id === "toolu_1");
  assert.ok(startDelta, "tool_call start delta present");
  assert.equal(startDelta.choices[0].delta.tool_calls[0].type, "function");
  assert.equal(startDelta.choices[0].delta.tool_calls[0].function.name, "get_weather");

  const argsDelta = parsed.find((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === "{\"city\":\"Milano\"}");
  assert.ok(argsDelta, "tool_call arguments delta present");

  const finishChunk = parsed.find((c) => c.choices?.[0]?.finish_reason);
  assert.equal(finishChunk.choices[0].finish_reason, "tool_calls");
});

test("translator buffers partial SSE writes across boundaries", () => {
  const t = createOpenAiStreamTranslator({ model: "m" });
  const event = sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "split" } });
  // split the write in two arbitrary halves
  const mid = Math.floor(event.length / 2);
  const first = anthropicSseWriteToOpenAiChunks(t, event.slice(0, mid));
  const second = anthropicSseWriteToOpenAiChunks(t, event.slice(mid));

  assert.equal(first.length, 0, "incomplete event buffered, no chunk emitted");
  const joined = second.map((line) => JSON.parse(line.replace(/^data: /, "").replace(/\n\n$/, "")));
  assert.equal(joined[0].choices[0].delta.content, "split");
});

test("translator emits a final usage chunk when stream_options.include_usage is set", () => {
  const t = createOpenAiStreamTranslator({ model: "m", includeUsage: true });
  const writes = [
    sse("message_start", { type: "message_start", message: { id: "m", model: "m" } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 2 } }),
    sse("message_stop", { type: "message_stop" }),
  ];

  let all = [];
  for (const w of writes) all = all.concat(anthropicSseWriteToOpenAiChunks(t, w));
  const parsed = all.filter((line) => line !== "data: [DONE]\n\n").map((line) => JSON.parse(line.replace(/^data: /, "").replace(/\n\n$/, "")));
  const usageChunk = parsed.find((c) => c.usage);
  assert.ok(usageChunk, "usage chunk present when include_usage");
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  assert.deepEqual(usageChunk.choices, [], "usage chunk has empty choices per OpenAI convention");
  assert.equal(all[all.length - 1], "data: [DONE]\n\n");
});

// ---------- e2e HTTP: stream consumed, [DONE] received ----------

function makeApp(tempRoot, fetchFn) {
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("openai", {
    access_token: "sk-openai-test", token_type: "api_key", scope: "api_key",
    provider: "openai", auth_type: "api_key", default_model: "gpt-4o-mini",
  }, { name: "OpenAI" });
  return createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    fetchFn,
  });
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      Promise.resolve(fn(`http://127.0.0.1:${port}`))
        .then(() => { server.close(); resolve(); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

function makeUpstreamStream(lines) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: {
      getReader() {
        return {
          async read() {
            if (i < lines.length) {
              return { done: false, value: encoder.encode(lines[i++]) };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

test("/v1/chat/completions stream:true returns SSE OpenAI chunks ending with [DONE]", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-stream-e2e-"));
  const upstreamChunks = [
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ciao\"},\"finish_reason\":null}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" dal provider\"},\"finish_reason\":null}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[],\"usage\":{\"prompt_tokens\":6,\"completion_tokens\":3}}\n\n",
    "data: [DONE]\n\n",
  ];
  const app = makeApp(tempRoot, async () => makeUpstreamStream(upstreamChunks));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type") || ""), /text\/event-stream/);

    const raw = await res.text();
    const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
    assert.ok(lines.length > 0, "stream has data lines");
    assert.equal(lines[lines.length - 1], "data: [DONE]", "stream terminated with [DONE]");

    const chunks = lines.slice(0, -1).filter((l) => l !== "data: [DONE]").map((l) => JSON.parse(l.slice("data: ".length)));
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.match(chunk.id, /^chatcmpl-/);
      assert.equal(typeof chunk.created, "number");
    }

    const first = chunks[0];
    assert.equal(first.choices[0].delta.role, "assistant", "first chunk carries assistant role");

    const content = chunks
      .filter((c) => c.choices?.[0]?.delta?.content)
      .map((c) => c.choices[0].delta.content)
      .join("");
    assert.equal(content, "Ciao dal provider");

    const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);
    assert.ok(finishChunk, "finish_reason chunk present");
    assert.equal(finishChunk.choices[0].finish_reason, "stop");
  });
});

test("/v1/chat/completions stream:true with stream_options.include_usage returns a final usage chunk", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-stream-usage-"));
  const upstreamChunks = [
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"model\":\"gpt-4o-mini\",\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n",
    "data: [DONE]\n\n",
  ];
  const app = makeApp(tempRoot, async () => makeUpstreamStream(upstreamChunks));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    assert.equal(res.status, 200);
    const raw = await res.text();
    const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
    assert.equal(lines[lines.length - 1], "data: [DONE]");
    const chunks = lines.slice(0, -1).filter((l) => l !== "data: [DONE]").map((l) => JSON.parse(l.slice("data: ".length)));

    // The gateway extracts upstream usage into the Anthropic message_delta;
    // with include_usage the translator must emit the final usage chunk.
    const usageChunk = chunks.find((c) => c.usage);
    assert.ok(usageChunk, "usage chunk present when include_usage requested");
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    // The usage chunk must be the last payload before [DONE].
    assert.equal(chunks[chunks.length - 1].usage !== undefined, true);
  });
});

test("/v1/chat/completions stream:true on provider failure returns OpenAI-style error (no SSE envelope leak)", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-stream-err-"));
  const app = makeApp(tempRoot, async () => ({
    ok: false,
    status: 401,
    async text() { return "invalid api key"; },
  }));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
        stream: true,
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error, "OpenAI error envelope");
    assert.equal(body.type, undefined, "no Anthropic type:error envelope");
  });
});