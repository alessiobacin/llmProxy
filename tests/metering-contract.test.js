"use strict";

// Contratto metering delle richieste fallite (R3 QA residui):
// 1. Un fallimento a LIVELLO PROVIDER (401/4xx/5xx dal provider o network error)
//    produce SEMPRE un record metering con success:false nel sink; il record
//    terminale (nessun altro provider/modello/proxy in grado di salvare) porta
//    l'error_code dell'ULTIMO tentativo (AUTH_REQUIRED/HTTP_<status>/
//    NETWORK_ERROR).
// 2. Quando il loop dei provider termina SENZA alcun tentativo (tutti i provider
//    saltati, es. richiesta immagine senza provider vision-capable), viene
//    emesso un record success:false con error_code PROVIDER_FALLBACK_EXHAUSTED.
// 3. Un rifiuto PRE-PROXY (gate inbound LLMPROXY_API_KEY 401/503) NON produce
//    alcun record metering: la richiesta non raggiunge mai un provider.
// 4. Nessun provider configurato (401 "Nessun provider autenticato") non produce
//    record: non è stato tentato alcun provider.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
const { createPaths, ensureRuntimeDirs } = require("../lib/paths");
const { createTokenStore } = require("../lib/token-store");
const { createProviderRegistry } = require("../lib/provider-registry");
const { createNoopMeteringSink } = require("../lib/metering");

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

function makeTokenStore(root, providers) {
  const tokenStore = createTokenStore({ filePath: path.join(root, "copilot-token.json") });
  for (const [id, data, name] of providers) {
    tokenStore.saveProvider(id, data, { name });
  }
  return tokenStore;
}

test("provider HTTP 401 failure is metered with success:false in the sink", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-provider-401-"));
  const tokenStore = makeTokenStore(tempRoot, [
    ["openai", {
      access_token: "bad-key", token_type: "api_key", scope: "api_key",
      provider: "openai", auth_type: "api_key", default_model: "gpt-4o-mini",
    }, "OpenAI"],
  ]);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    meteringSink,
    fetchFn: async () => ({
      ok: false,
      status: 401,
      async text() { return "invalid api key"; },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 401);
    const records = meteringSink.inspect();
    assert.equal(records.length, 1, "provider failure must produce exactly one metering record");
    assert.equal(records[0].success, false, "record must be success:false");
    assert.equal(records[0].provider, "openai", "record must carry the failed provider");
    assert.equal(records[0].error_code, "AUTH_REQUIRED", "401 provider failure must carry error_code AUTH_REQUIRED");
    assert.equal(records[0].model_used, "gpt-4o-mini", "record must carry the attempted model");
  });
});

test("network failure at provider level is metered with success:false", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-network-"));
  const tokenStore = makeTokenStore(tempRoot, [
    ["kimi", {
      access_token: "tok", token_type: "api_key", scope: "api_key",
      provider: "kimi", auth_type: "api_key", default_model: "kimi-k2.5",
    }, "Kimi"],
  ]);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    meteringSink,
    fetchFn: async () => {
      throw new Error("socket hang up");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k2.5",
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 502);
    const records = meteringSink.inspect();
    assert.equal(records.length, 1, "network failure must produce a metering record");
    assert.equal(records[0].success, false, "record must be success:false");
    assert.equal(records[0].error_code, "NETWORK_ERROR", "network failure must carry NETWORK_ERROR");
  });
});

test("all providers exhausted carries the last provider's HTTP error code", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-exhausted-"));
  const tokenStore = makeTokenStore(tempRoot, [
    ["openai", {
      access_token: "bad", token_type: "api_key", scope: "api_key",
      provider: "openai", auth_type: "api_key", default_model: "gpt-4o-mini",
    }, "OpenAI"],
  ]);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    meteringSink,
    fetchFn: async () => ({
      ok: false,
      status: 503,
      async text() { return "provider overloaded"; },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 503);
    const records = meteringSink.inspect();
    assert.equal(records.length, 1, "exhausted fallback must produce exactly one metering record");
    assert.equal(records[0].success, false, "record must be success:false");
    // The terminal record carries the error of the LAST provider attempt
    // (no other provider/model/proxy can rescue it); PROVIDER_FALLBACK_EXHAUSTED
    // is reserved for the loop-without-any-attempt path (see next test).
    assert.equal(records[0].error_code, "HTTP_503", "terminal record must carry the last attempt's error code");
    assert.equal(records[0].provider, "openai");
  });
});

test("all providers skipped (no attempt) is metered with PROVIDER_FALLBACK_EXHAUSTED", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-fallback-exhausted-"));
  // Single provider, vision disabled, image request: the provider loop skips it
  // without any request attempt, so the loop falls through to the exhausted
  // terminal record instead of the in-loop error path.
  const tokenStore = makeTokenStore(tempRoot, [
    ["kimi", {
      access_token: "tok-imageno", token_type: "api_key", scope: "api_key",
      provider: "kimi", auth_type: "api_key", default_model: "kimi-k2.5", vision: false,
    }, "Kimi"],
  ]);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    meteringSink,
    fetchFn: async () => {
      throw new Error("fetch must never be called when every provider is skipped");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kimi-k2.5",
        stream: false,
        max_tokens: 8,
        messages: [{
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
        }],
      }),
    });

    assert.equal(response.status, 502);
    const records = meteringSink.inspect();
    assert.equal(records.length, 1, "exhausted-without-attempt must produce one metering record");
    assert.equal(records[0].success, false, "record must be success:false");
    assert.equal(records[0].error_code, "PROVIDER_FALLBACK_EXHAUSTED");
    assert.equal(records[0].provider, null);
  });
});

test("inbound gate rejection (401 pre-proxy) produces NO metering record", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-gate-401-"));
  const paths = createPaths({ dataRoot: tempRoot });
  ensureRuntimeDirs(paths);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    env: { LLMPROXY_API_KEY: "secret-123" },
    meteringSink,
    fetchFn: async () => {
      throw new Error("fetch must never be called for a gate rejection");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(meteringSink.inspect().length, 0, "pre-provider gate rejection must not be metered");
  });
});

test("inbound gate 503 (key required but unset in production) produces NO metering record", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-gate-503-"));
  const paths = createPaths({ dataRoot: tempRoot });
  ensureRuntimeDirs(paths);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    env: { LLMPROXY_API_KEY: "", LLMPROXY_ENV: "production", LLMPROXY_RUNTIME_PROFILE: "production" },
    meteringSink,
    fetchFn: async () => {
      throw new Error("fetch must never be called for a gate rejection");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 503);
    assert.equal(meteringSink.inspect().length, 0, "pre-provider gate rejection must not be metered");
  });
});

test("no provider configured (401 before any attempt) produces NO metering record", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-meting-no-provider-"));
  const paths = createPaths({ dataRoot: tempRoot });
  ensureRuntimeDirs(paths);
  const meteringSink = createNoopMeteringSink();
  const app = createApp({
    dataRoot: tempRoot,
    meteringSink,
    fetchFn: async () => {
      throw new Error("fetch must never be called with no providers configured");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(meteringSink.inspect().length, 0, "no provider attempted -> no metering record");
  });
});