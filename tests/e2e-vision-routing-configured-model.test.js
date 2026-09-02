"use strict";
// Regression test: riproduce lo scenario reale segnalato dall'utente.
// Il progetto ha un `configuredModel` pinnato (es. "deepseek-v4-flash" via
// .claude/settings.json / llmproxy config:set --scope project) e i provider
// reali configurati (opencode-bacin/opencode-alessio vision=false,
// openrouter-glm/openrouter-openai/meta/qwen-vision vision=true).
// Verifica che, con un'immagine nel messaggio, il routing scarti comunque
// i provider vision=false e contatti il primo provider vision-capable,
// indipendentemente dal fatto che `configuredModel` punti a un modello
// senza vision.
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
  async text() { return "ok"; },
};

function img(name) {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: name } };
}

// Provider set identico alla config reale dell'utente (~/Library/Application
// Support/llmProxy/copilot-token.json), ordine di registrazione incluso.
const REAL_PROVIDERS = [
  provider({ id: "opencode-bacin", kind: "opencode", model: "deepseek-v4-flash", vision: false }),
  provider({ id: "openrouter-glm", kind: "openrouter", model: "z-ai/glm-5.3-flash", vision: true }),
  provider({ id: "opencode-alessio", kind: "opencode", model: "deepseek-v4-flash", vision: false }),
  provider({ id: "openrouter-openai", kind: "openrouter", model: "gpt-5.6-luna", vision: true }),
  provider({ id: "meta", kind: "meta", model: "muse-spark-1.2", vision: true }),
  provider({ id: "qwen", kind: "qwen", model: "qwen3.7-max", vision: false }),
  provider({ id: "kimi", kind: "kimi", model: "kimi-k3", vision: false }),
  provider({ id: "qwen-vision", kind: "qwen", model: "qwen3.7-plus", vision: true }),
];

function run({ configuredModel, requestModel, bodyMsgContent }) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    let b = {};
    try { b = JSON.parse(String(opts.body || "{}")); } catch {}
    const isChat = Array.isArray(b.messages) || Array.isArray(b.input);
    const host = String(url).replace("https://", "").split("/")[0];
    calls.push({ host, body: b });
    if (!isChat) return { ok: false, status: 500, async text() { return "e"; }, async json() { return {}; } };
    return OK;
  };
  const res = { writes: [], write(c) { this.writes.push(String(c)); }, end() { this.ended = true; }, json() {} };
  const noop = { logProviderAttempt() {}, logProviderResult() {}, logRequestSummary() {}, getModelBreakdownTotals: () => ({ today: {}, week: {} }) };
  return proxyAnthropicRequest({
    anthropicBody: { model: requestModel, messages: [{ role: "user", content: bodyMsgContent }] },
    req: { headers: {} }, res,
    requestId: "e2e-pinned-" + Math.random().toString(36).slice(2, 8),
    projectName: "e2e-vision-pinned", providerCandidates: REAL_PROVIDERS, fetchFn,
    logger: noop, configuredModel, availableModels: [],
  }).then(() => ({ calls, error: null })).catch((e) => ({ calls, error: e && e.message }));
}

test("BUG: immagine + configuredModel pinnato a deepseek-v4-flash (project settings) -> deve comunque saltare opencode-bacin (vision=false) e contattare un provider vision-capable", async () => {
  const { calls, error } = await run({
    configuredModel: "deepseek-v4-flash",
    requestModel: "deepseek-v4-flash",
    bodyMsgContent: [{ type: "text", text: "cosa vedi in questa immagine?" }, img("SCREENSHOT")],
  });

  const hosts = calls.filter((c) => Array.isArray(c.body.messages) || Array.isArray(c.body.input)).map((c) => String(c.host));
  assert.ok(!hosts.some((h) => h.includes("opencode")), "non deve MAI contattare opencode-bacin/opencode-alessio (vision=false), got: " + hosts.join(","));
  assert.ok(hosts.some((h) => h.includes("openrouter") || h.includes("qwen") || h.includes("meta")), "deve contattare un provider vision-capable, got: " + hosts.join(","));
  assert.equal(error, null);
});
