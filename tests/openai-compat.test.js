"use strict";

// Contratto /v1/chat/completions OpenAI-compatible (T2):
// - non-streaming: shape OpenAI completa (id, object, created, model,
//   choices[].finish_reason, usage) anche con modello qualificato provider:model
// - tool_calls base (richiesta tools/tool_choice + risposta tool_calls)
// - error shape OpenAI-style ({error:{message,type,code}}) per errori upstream
// - stream:true su /v1/chat/completions (T1) — coperto in openai-stream.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
const { createTokenStore } = require("../lib/token-store");
const { createProviderRegistry } = require("../lib/provider-registry");
const { openAIRequestToAnthropic } = require("../lib/openai-format");

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

test("/v1/chat/completions non-streaming returns the full OpenAI contract shape", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-contract-"));
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
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.match(body.id, /^chatcmpl-/);
    assert.equal(typeof body.created, "number");
    assert.equal(body.model, "gpt-4o-mini");
    assert.equal(Array.isArray(body.choices), true);
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].index, 0);
    assert.equal(body.choices[0].message.role, "assistant");
    assert.equal(body.choices[0].message.content, "ciao dal provider");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
  });
});

test("/v1/chat/completions accepts the qualified provider:model from GET /v1/models", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-qualified-"));
  const calls = [];
  const app = makeApp(tempRoot, async (url, opts) => {
    calls.push(JSON.parse(String(opts.body || "{}")));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: calls[calls.length - 1].model,
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    // The catalog exposed by GET /v1/models lists qualified ids like
    // "openai:gpt-4o-mini"; the chat endpoint must route them.
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    assert.equal(modelsRes.status, 200);
    const catalog = await modelsRes.json();
    assert.equal(catalog.object, "list");
    assert.ok(catalog.data.some((m) => m.id === "openai:gpt-4o-mini"), "catalog exposes qualified model id");

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].finish_reason, "stop");
    // The request reached the provider with the bare model name.
    assert.ok(calls.length >= 1, "provider received a request");
  });
});

test("/v1/chat/completions accepts llmproxy auto and delegates routing to the proxy", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-auto-"));
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
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const modelsRes = await fetch(`${baseUrl}/v1/models`);
    const catalog = await modelsRes.json();
    assert.ok(catalog.data.some((model) => model.id === "llmproxy"), "catalog exposes auto model");

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llmproxy",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(calls.length >= 1, "provider received a request");
    assert.equal(calls[0].model, "gpt-4o-mini", "dynamic routing resolves the concrete provider model");
  });
});

test("openAIRequestToAnthropic maps tools and tool_choice (unit contract)", () => {
  const out = openAIRequestToAnthropic({
    model: "openai:gpt-4o-mini",
    messages: [{ role: "user", content: "che tempo fa?" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Meteo corrente per città",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    }],
    tool_choice: "auto",
  });
  assert.equal(Array.isArray(out.tools), true);
  assert.equal(out.tools[0].name, "get_weather");
  assert.equal(out.tools[0].input_schema.type, "object");
  assert.deepEqual(out.tool_choice, { type: "auto" });
});

test("openAIRequestToAnthropic maps role system to the system field (unit contract)", () => {
  const out = openAIRequestToAnthropic({
    model: "openai:gpt-4o-mini",
    messages: [
      { role: "system", content: "Sei un assistente conciso." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(out.system, "Sei un assistente conciso.");
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, "user");
});

test("/v1/chat/completions tool_calls round-trip: finish_reason tool_calls and usage", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-tools-"));
  const app = makeApp(tempRoot, async (url, opts) => {
    const body = JSON.parse(String(opts.body || "{}"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{
            message: { content: null },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "che tempo fa a Milano?" }],
        max_tokens: 64,
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Meteo corrente per città",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
        tool_choice: "auto",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(body.usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
  });
});

test("/v1/chat/completions returns OpenAI-style error shape on upstream provider failure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-error-"));
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
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    // OpenAI error convention: { error: { message, type, code } } — the
    // Anthropic-style "type: error" envelope must not leak to OpenAI clients.
    assert.ok(body.error, "error envelope present");
    assert.equal(body.type, undefined, "no Anthropic type:error envelope");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  });
});

test("/v1/chat/completions accepts OpenAI role system messages end-to-end", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-oai-system-"));
  const app = makeApp(tempRoot, async (url, opts) => {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "gpt-4o-mini",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai:gpt-4o-mini",
        messages: [
          { role: "system", content: "Sei un assistente conciso." },
          { role: "user", content: "hi" },
        ],
        max_tokens: 20,
      }),
    });
    assert.equal(res.status, 200);
  });
});
