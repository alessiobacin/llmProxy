const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
const { createTokenStore } = require("../lib/token-store");

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("health and auth status endpoints reflect standalone runtime state", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-health-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-abc" });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn: async () => {
      throw new Error("fetch should not run");
    },
  });

  await withServer(app, async (baseUrl) => {
    const healthResponse = await fetch(`${baseUrl}/health`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.ok, true);

    const authResponse = await fetch(`${baseUrl}/auth/status`);
    const authPayload = await authResponse.json();
    assert.equal(authResponse.status, 200);
    assert.equal(authPayload.authenticated, true);
  });
});

test("messages endpoint proxies a non-stream Copilot response into Anthropic format", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-proxy-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz" });

  const fetchFn = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: "claude-sonnet-4.5",
        choices: [
          {
            message: { content: "pong from copilot" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      };
    },
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": "/Users/example/project-alpha",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.type, "message");
    assert.equal(payload.role, "assistant");
    assert.equal(payload.content[0].text, "pong from copilot");
    assert.equal(payload.model, "claude-sonnet-4-5");
  });
});

test("messages endpoint falls back to the next Copilot provider when the first one fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-fallback-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("primary", { access_token: "token-primary", token_type: "bearer", scope: "read:user" }, { name: "Primary" });
  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Backup" });

  const attempts = [];
  const fetchFn = async (_url, options = {}) => {
    const authHeader = options.headers?.Authorization || "";
    attempts.push(authHeader);

    if (authHeader === "Bearer token-primary") {
      return {
        ok: false,
        status: 503,
        async text() {
          return "primary unavailable";
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "claude-sonnet-4.5",
          choices: [
            {
              message: { content: "served by backup" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        };
      },
    };
  };

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": "/Users/example/project-beta",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.content[0].text, "served by backup");
    assert.deepEqual(attempts, ["Bearer token-primary", "Bearer token-backup"]);
  });
});

test("messages endpoint falls back to a supported Copilot model when the client sends an unsupported model", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-model-fallback-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz" });
  const requestBodies = [];

  const fetchFn = async (_url, options = {}) => {
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "claude-sonnet-4.5",
          choices: [
            {
              message: { content: "pong from copilot" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 5 },
        };
      },
    };
  };

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "glm-5",
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].model, "claude-sonnet-4.5");
  });
});

test("messages endpoint preserves a cached dynamic Copilot model", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-model-catalog-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz" });
  fs.writeFileSync(path.join(tempRoot, "copilot-models.json"), JSON.stringify({
    updatedAt: "2026-03-27T00:00:00.000Z",
    models: ["gpt-4.1", "o3"],
  }, null, 2));
  const requestBodies = [];

  const fetchFn = async (_url, options = {}) => {
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "gpt-4.1",
          choices: [
            {
              message: { content: "dynamic model ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 5 },
        };
      },
    };
  };

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].model, "gpt-4.1");
  });
});