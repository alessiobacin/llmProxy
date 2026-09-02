"use strict";

// Contratto /v1/responses (OpenAI Responses API — T3):
//   - non-streaming: shape Responses completa (object "response", status "completed",
//     output[].type "message" con content[].type "output_text", usage input/output/total)
//     anche con modello qualificato provider:model
//   - tool calling: input items function_call_output + output items function_call
//   - instructions -> system message; max_output_tokens -> max_tokens
//   - stream:true -> eventi SSE Responses (response.created, response.output_text.delta,
//     response.completed) terminati da [DONE]
//   - error shape OpenAI-style { error: { message, type, code } }
//   - api-key gate: /v1/responses NON è pubblico -> 401 senza chiave quando LLMPROXY_API_KEY è attiva

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const { createPaths, ensureRuntimeDirs } = require("../lib/paths");
const { createTokenStore } = require("../lib/token-store");
const { createProviderRegistry } = require("../lib/provider-registry");

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

function makeApp(tempRoot, fetchFn) {
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("openai", {
    access_token: "sk-openai-test",
    token_type: "api_key",
    scope: "api_key",
    provider: "openai",
    auth_type: "api_key",
    default_model: "gpt-4o-mini",
  }, { name: "OpenAI" });
  return createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    fetchFn,
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

function startApp(envOverrides) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmp-resp-apikey-"));
  const paths = createPaths({ dataRoot });
  ensureRuntimeDirs(paths);
  const app = createApp({ env: { ...process.env, ...envOverrides }, dataRoot });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Unit contract: lib/responses-format.js (translators)
// ---------------------------------------------------------------------------

test("responsesRequestToOpenAIChat maps input items, instructions and max_output_tokens (unit contract)", () => {
  const { responsesRequestToOpenAIChat } = require("../lib/responses-format");
  const out = responsesRequestToOpenAIChat({
    model: "openai:gpt-4o-mini",
    instructions: "Sei un assistente conciso.",
    max_output_tokens: 64,
    input: [
      { role: "user", content: [{ type: "input_text", text: "che tempo fa?" }] },
    ],
  });
  assert.equal(out.model, "openai:gpt-4o-mini");
  assert.equal(out.max_tokens, 64);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "Sei un assistente conciso.");
  assert.equal(out.messages[1].role, "user");
  assert.equal(out.messages[1].content, "che tempo fa?");
});

test("responsesRequestToOpenAIChat maps function_call_output and tools (unit contract)", () => {
  const { responsesRequestToOpenAIChat } = require("../lib/responses-format");
  const out = responsesRequestToOpenAIChat({
    model: "openai:gpt-4o-mini",
    input: [
      { role: "user", content: [{ type: "input_text", text: "che tempo fa a Milano?" }] },
      { type: "function_call_output", call_id: "call_1", output: "{\"temp\":22}" },
    ],
    tools: [{
      type: "function",
      name: "get_weather",
      description: "Meteo corrente per città",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }],
  });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[1].role, "tool");
  assert.equal(out.messages[1].tool_call_id, "call_1");
  assert.equal(out.messages[1].content, "{\"temp\":22}");
  assert.equal(out.tools[0].type, "function");
  assert.equal(out.tools[0].function.name, "get_weather");
  assert.deepEqual(out.tools[0].function.parameters.type, "object");
});

test("anthropicResponseToResponses maps text and usage (unit contract)", () => {
  const { anthropicResponseToResponses } = require("../lib/responses-format");
  const out = anthropicResponseToResponses({
    id: "msg_abc",
    type: "message",
    role: "assistant",
    model: "gpt-4o-mini",
    content: [{ type: "text", text: "ciao dal provider" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  assert.equal(out.object, "response");
  assert.equal(out.status, "completed");
  assert.match(out.id, /^resp_/);
  assert.equal(out.model, "gpt-4o-mini");
  assert.equal(out.output[0].type, "message");
  assert.equal(out.output[0].content[0].type, "output_text");
  assert.equal(out.output[0].content[0].text, "ciao dal provider");
  assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
});

test("anthropicResponseToResponses maps tool_use to function_call output item (unit contract)", () => {
  const { anthropicResponseToResponses } = require("../lib/responses-format");
  const out = anthropicResponseToResponses({
    id: "msg_abc",
    type: "message",
    role: "assistant",
    model: "gpt-4o-mini",
    content: [{
      type: "tool_use",
      id: "call_abc",
      name: "get_weather",
      input: { city: "Milano" },
    }],
    stop_reason: "tool_use",
    usage: { input_tokens: 9, output_tokens: 4 },
  });
  assert.equal(out.status, "completed");
  assert.equal(out.output[0].type, "function_call");
  assert.equal(out.output[0].call_id, "call_abc");
  assert.equal(out.output[0].name, "get_weather");
  assert.equal(out.output[0].arguments, "{\"city\":\"Milano\"}");
});

test("anthropicSseWriteToResponsesEvents emits response.created, output_text.delta and completed (unit contract)", () => {
  const { createResponsesStreamTranslator, anthropicSseWriteToResponsesEvents } = require("../lib/responses-format");
  const state = createResponsesStreamTranslator({ model: "gpt-4o-mini" });
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const chunks = [
    ...anthropicSseWriteToResponsesEvents(state, sse("message_start", {
      type: "message_start",
      message: { id: "msg_abc", model: "gpt-4o-mini", usage: { input_tokens: 5, output_tokens: 0 } },
    })),
    ...anthropicSseWriteToResponsesEvents(state, sse("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Ciao" },
    })),
    ...anthropicSseWriteToResponsesEvents(state, sse("content_block_delta", {
      type: "content_block_delta",
      delta: { type: "text_delta", text: " dal provider" },
    })),
    ...anthropicSseWriteToResponsesEvents(state, sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 5, output_tokens: 2 },
    })),
    ...anthropicSseWriteToResponsesEvents(state, sse("message_stop", { type: "message_stop" })),
  ];

  const events = chunks.map((chunk) => {
    const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine || dataLine === "data: [DONE]") {
      return { event: eventLine ? eventLine.slice(7).trim() : null, data: null, done: dataLine === "data: [DONE]" };
    }
    return { event: eventLine ? eventLine.slice(7).trim() : null, data: JSON.parse(dataLine.slice(6)) };
  });

  assert.equal(events[0].event, "response.created");
  assert.equal(events[0].data.type, "response.created");
  assert.match(events[0].data.response.id, /^resp_/);
  assert.equal(events[0].data.response.model, "gpt-4o-mini");

  const deltas = events.filter((e) => e.event === "response.output_text.delta");
  assert.ok(deltas.length >= 2, "text deltas emitted");
  assert.equal(deltas.map((d) => d.data.delta).join(""), "Ciao dal provider");

  const completed = events.find((e) => e.event === "response.completed");
  assert.ok(completed, "response.completed emitted");
  assert.equal(completed.data.type, "response.completed");
  assert.equal(completed.data.response.status, "completed");
  assert.deepEqual(completed.data.response.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });

  assert.equal(chunks[chunks.length - 1], "data: [DONE]\n\n", "stream terminated with [DONE]");
});

// ---------------------------------------------------------------------------
// E2E: POST /v1/responses (non-streaming)
// ---------------------------------------------------------------------------

test("/v1/responses non-streaming returns a Responses-shaped body", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-resp-e2e-"));
  const app = makeApp(tempRoot, async (url, opts) => {
    const body = JSON.parse(String(opts.body || "{}"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "ciao dal provider" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 20,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.match(body.id, /^resp_/);
    assert.equal(typeof body.created_at, "number");
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(body.output[0].type, "message");
    assert.equal(body.output[0].role, "assistant");
    assert.equal(body.output[0].content[0].type, "output_text");
    assert.equal(body.output[0].content[0].text, "ciao dal provider");
    assert.deepEqual(body.usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });
});

test("/v1/responses forwards instructions and max_output_tokens to the provider", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-resp-instr-"));
  const calls = [];
  const app = makeApp(tempRoot, async (_url, opts) => {
    calls.push(JSON.parse(String(opts.body || "{}")));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: calls[calls.length - 1].model,
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        instructions: "Sei un assistente conciso.",
        max_output_tokens: 64,
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(calls.length >= 1, "provider received a request");
    assert.equal(calls[0].max_tokens ?? calls[0].max_completion_tokens, 64, "max_output_tokens mapped to max_tokens");
    const systemMessage = calls[0].messages.find((m) => m.role === "system");
    assert.ok(systemMessage, "system message present");
    assert.equal(systemMessage.content, "Sei un assistente conciso.");
    assert.equal(calls[0].stream, undefined, "non-streaming request does not force stream");
  });
});

test("/v1/responses tool calling: function_call_output input and function_call output", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-resp-tools-"));
  const app = makeApp(tempRoot, async (url, opts) => {
    const body = JSON.parse(String(opts.body || "{}"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: "{\"city\":\"Milano\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        input: [
          { role: "user", content: [{ type: "input_text", text: "che tempo fa a Milano?" }] },
          { type: "function_call_output", call_id: "call_1", output: "{\"temp\":22}" },
        ],
        max_output_tokens: 64,
        tools: [{
          type: "function",
          name: "get_weather",
          description: "Meteo corrente per città",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "response");
    assert.equal(body.output[0].type, "function_call");
    assert.equal(body.output[0].call_id, "call_abc");
    assert.equal(body.output[0].name, "get_weather");
    assert.equal(body.output[0].arguments, "{\"city\":\"Milano\"}");
    assert.deepEqual(body.usage, { input_tokens: 9, output_tokens: 4, total_tokens: 13 });
  });
});

test("/v1/responses returns OpenAI-style error shape on upstream provider failure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-resp-error-"));
  const app = makeApp(tempRoot, async () => ({
    ok: false,
    status: 401,
    async text() { return "invalid api key"; },
  }));

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 20,
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error, "error envelope present");
    assert.equal(body.type, undefined, "no Anthropic type:error envelope");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  });
});

// ---------------------------------------------------------------------------
// E2E: POST /v1/responses (streaming)
// ---------------------------------------------------------------------------

test("/v1/responses stream:true returns Responses SSE events ending with [DONE]", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-resp-stream-"));
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
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 20,
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type") || ""), /text\/event-stream/);

    const raw = await res.text();
    const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
    assert.ok(lines.length > 0, "stream has data lines");
    assert.equal(lines[lines.length - 1], "data: [DONE]", "stream terminated with [DONE]");

    const events = [];
    const blocks = raw.split("\n\n").filter((b) => b.trim().length > 0);
    for (const block of blocks) {
      let event = null;
      let data = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        if (line.startsWith("data: ") && line !== "data: [DONE]") data = JSON.parse(line.slice(6));
      }
      if (event) events.push({ event, data });
    }

    const created = events.find((e) => e.event === "response.created");
    assert.ok(created, "response.created emitted");
    assert.match(created.data.response.id, /^resp_/);

    const deltas = events.filter((e) => e.event === "response.output_text.delta");
    assert.ok(deltas.length >= 2, "text deltas emitted");
    assert.equal(deltas.map((d) => d.data.delta).join(""), "Ciao dal provider");

    const completed = events.find((e) => e.event === "response.completed");
    assert.ok(completed, "response.completed emitted");
    assert.equal(completed.data.response.status, "completed");
  });
});

// ---------------------------------------------------------------------------
// E2E: api-key gate
// ---------------------------------------------------------------------------

test("api-key gate: with LLMPROXY_API_KEY, /v1/responses requires the key", async () => {
  const { server, baseUrl } = await startApp({ LLMPROXY_API_KEY: "secret-123" });
  try {
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 8,
      }),
    });
    assert.equal(res.status, 401, "missing key -> 401");
    const body = await res.json();
    assert.equal(body.error, "UNAUTHORIZED", "gate rejects with UNAUTHORIZED");

    const valid = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-123" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        max_output_tokens: 8,
      }),
    });
    assert.notEqual(valid.status, 404, "route exists");
    assert.notEqual(valid.status, 500, "no crash with valid bearer");
    // Con LLMPROXY_API_KEY attiva ma nessun provider configurato, il 401
    // successivo è atteso: significa che il gate API key è stato superato
    // e la richiesta è arrivata alla pipeline (provider mancante).
    const validBody = await valid.json();
    assert.ok(validBody.error, "error envelope present after gate");
    assert.equal(validBody.error.code, "invalid_api_key", "provider-level auth error after gate");
    assert.equal(validBody.error.code, "invalid_api_key", "provider-level auth error after gate");
  } finally {
    server.close();
  }
});