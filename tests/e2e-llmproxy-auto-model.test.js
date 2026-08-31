const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
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
  tokenStore.saveProvider("copilot", {
    access_token: "sk-copilot-test", token_type: "bearer", scope: "read:user",
    provider: "copilot", default_model: "claude-sonnet-4.5",
  }, { name: "Copilot" });
  return createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
    fetchFn,
  });
}

test("E2E: /v1/chat/completions accepts 'llmproxy auto' model label with space (client sends this format)", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-e2e-auto-"));
  const calls = [];
  const app = makeApp(tempRoot, async (_url, opts) => {
    const body = JSON.parse(String(opts.body || "{}"));
    calls.push({ method: "POST", url: _url, body });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model || "claude-sonnet-4.5",
          choices: [{ message: { content: "risposta dal provider" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      },
    };
  });

  await withServer(app, async (baseUrl) => {
    // Test 1: Client sends "llmproxy auto" (with space) — should work
    const res1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llmproxy auto",  // Client format: with space
        messages: [{ role: "user", content: "ciao" }],
        max_tokens: 20,
      }),
    });

    assert.equal(res1.status, 200, "should accept 'llmproxy auto' with space");
    const body1 = await res1.json();
    assert.equal(body1.choices[0].message.content, "risposta dal provider");
    assert.ok(calls.length >= 1, "provider should have received a request");

    // Test 2: Bare "llmproxy" (without space) — should also work
    calls.length = 0;
    const res2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llmproxy",  // Bare form
        messages: [{ role: "user", content: "ciao" }],
        max_tokens: 20,
      }),
    });

    assert.equal(res2.status, 200, "should accept bare 'llmproxy'");
    const body2 = await res2.json();
    assert.equal(body2.choices[0].message.content, "risposta dal provider");
    assert.ok(calls.length >= 1, "provider should have received a request");

    // Test 3: GET /v1/models/:modelId with "llmproxy auto"
    const resModel = await fetch(`${baseUrl}/v1/models/llmproxy%20auto`);  // URL-encoded space
    assert.equal(resModel.status, 200, "should accept 'llmproxy auto' in model lookup");
    const modelBody = await resModel.json();
    assert.equal(modelBody.id, "llmproxy");
  });
});
