"use strict";
// E2E: vision routing via proxyAnthropicRequest con providerCandidates mock
// (nessuna rete esterna: fetchFn simulato in-process).
// Requisiti verificati:
//  A1) con immagine, un provider vision=false non viene MAI contattato; il
//      relay immunitario viene inviato SOLO a provider vision-capable e il
//      blocco arriv   e' convertito in image_url (data URL base64).
//  A2) se il primo provider vision-capable fallisce, si fa fallback al
//      successivo vision-capable, MAI a un provider vision=false.
//  A3) senza immagine, il primo provider in ordine lista viene usato (invariato).
const test = require("node:test");
const assert = require("node:assert/strict");
const { proxyAnthropicRequest } = require("../lib/copilot-proxy");

function provider(o) {
  return {
    id: o.id,
    provider: o.kind,
    access_token: "sk-test",
    default_model: o.model,
    vision: o.vision,
  };
}

const OK = {
  ok: true,
  status: 200,
  async json() {
    return {
      id: "c1", model: "m", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  },
  async text() {
    return "ok";
  },
};
const ERR = { ok: false, status: 500, async text() { return "e"; }, async json() { return { error: { message: "e" } }; } };

function run(providers, route, bodyMsgContent) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    let b = {};
    try { b = JSON.parse(String(opts.body || "{}")); } catch {}
    const isChat = Array.isArray(b.messages) || Array.isArray(b.input);
    const host = String(url).replace("https://", "").split("/")[0];
    calls.push({ host, body: b });
    if (!isChat) return ERR;
    return route(host, b);
  };
  const res = { writes: [], write(c) { this.writes.push(String(c)); }, end() { this.ended = true; }, json() {} };
  const noop = { logProviderAttempt() {}, logProviderResult() {}, logRequestSummary() {}, getModelBreakdownTotals: () => ({ today: {}, week: {} }) };
  return proxyAnthropicRequest({
    anthropicBody: { model: "claude-sonnet-4.5", messages: [{ role: "user", content: bodyMsgContent }] },
    req: { headers: {} }, res,
    requestId: "e2e-" + Math.random().toString(36).slice(2, 8),
    projectName: "e2e-vision", providerCandidates: providers, fetchFn,
    logger: noop, configuredModel: null, availableModels: [],
  }).then(() => ({ calls, error: null })).catch((e) => ({ calls, error: e && e.message }));
}

function img(name) {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: name } };
}

test("A1: immagine -> solo provider vision-capable, mai deepseek(vision=false), convertito in image_url", async () => {
  const providers = [
    provider({ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash-free", vision: false }),
    provider({ id: "openrouter-openai", kind: "openrouter", model: "gpt-5.6-luna", vision: true }),
  ];
  const urls = [];
  const { calls, error } = await run(providers, (host) => { urls.push(host); return OK; }, [{ type: "text", text: "descri" }, img("AAAA")]);

  const hosts = calls.filter((c) => Array.isArray(c.body.messages) || Array.isArray(c.body.input)).map((c) => String(c.host));
  assert.ok(!hosts.some((h) => h.includes("deepseek")), "must never contact deepseek, got: " + hosts.join(","));
  assert.ok(hosts.some((h) => h.includes("openrouter")), "must contact openrouter (vision), got: " + hosts.join(","));
  const visionCall = calls.find((c) => (Array.isArray(c.body.messages) || Array.isArray(c.body.input)) && String(c.host).includes("openrouter"));
  const um = Array.isArray(visionCall.body.messages) ? visionCall.body.messages.find((m) => m.role === "user") : null;
  const blocks = Array.isArray(um?.content) ? um.content : [];
  assert.ok(blocks.some((x) => x.type === "image_url" && String(x.image_url.url).startsWith("data:image/png;base64,AAAA")), "image must become image_url dataURL");
  assert.equal(error, null);
});

test("A2: primo vision fallisce -> fallback vision next, mai deepseek", async () => {
  const providers = [
    provider({ id: "meta", kind: "meta", model: "muse-spark-1.2", vision: true }),
    provider({ id: "qwen-vision", kind: "qwen", model: "qwen3.7-plus", vision: true }),
    provider({ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash-free", vision: false }),
  ];
  const hosts = [];
  const { calls, error } = await run(providers,
    (host) => { hosts.push(host); return host.includes("metaai") || host.includes("meta") ? ERR : OK; },
    [img("BBBB")]);

  assert.ok(hosts.some((h) => h.includes("qwen") || h.includes("dashscope")), "fallback to Qwen vision called: " + hosts.join(","));
  assert.ok(!hosts.some((h) => h.includes("deepseek")), "deepseek never used, got: " + hosts.join(","));
  assert.equal(error, null);
});

test("A3: senza immagine -> comportamento invariato (provider in ordine lista)", async () => {
  const hosts = [];
  const providers = [
    provider({ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash-free", vision: false }),
    provider({ id: "openrouter-openai", kind: "openrouter", model: "gpt-5.6-luna", vision: true }),
  ];
  await run(providers, (host) => { hosts.push(host); return OK; }, "plain text");
  assert.equal(hosts[0].includes("deepseek"), true, "no image -> first provider (deepseek), got: " + hosts[0]);
});