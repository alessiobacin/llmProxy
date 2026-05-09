const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
const { API_KEY_PROVIDER_CONFIGS } = require("../lib/copilot-proxy");
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
    assert.equal(payload.model, "claude-sonnet-4.5");
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

test("messages endpoint truncates oversized Copilot tool lists and records the adjustment in logs", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-tool-trim-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz" });

  const loggerCalls = [];
  const logger = {
    logIncomingRequest(entry) {
      loggerCalls.push({ type: "incoming", entry });
    },
    logProviderAttempt(entry) {
      loggerCalls.push({ type: "attempt", entry });
    },
    logProviderResult(entry) {
      loggerCalls.push({ type: "result", entry });
    },
  };

  const fetchBodies = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    fetchBodies.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "gpt-5.4",
          choices: [
            {
              message: { content: "trim ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 3 },
        };
      },
    };
  };

  const tools = Array.from({ length: 132 }, (_, index) => ({
    name: `tool_${index + 1}`,
    description: `Tool ${index + 1}`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
  }));

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
    logger,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        max_tokens: 64,
        tools,
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
    assert.equal(payload.content[0].text, "trim ok");
    assert.equal(fetchBodies.length, 1);
    assert.equal(fetchBodies[0].tools.length, 128);

    const attemptLog = loggerCalls.find((entry) => entry.type === "attempt");
    assert.ok(attemptLog, "deve registrare un provider attempt");
    assert.deepEqual(attemptLog.entry.toolAdjustment, {
      kind: "copilot_tools_truncated",
      originalToolCount: 132,
      effectiveToolCount: 128,
      droppedToolCount: 4,
      toolChoiceAdjusted: false,
    });
  });
});

test("messages endpoint retries transient socket-close errors before failing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-network-retry-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-retry" });

  let attempts = 0;
  const fetchFn = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()");
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "claude-sonnet-4.5",
          choices: [
            {
              message: { content: "retry success" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
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
    assert.equal(payload.content[0].text, "retry success");
    assert.equal(attempts, 2);
  });
});

test("messages endpoint falls back to the next Copilot provider when the first one is blocked by safety policy", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-safety-fallback-"));
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
        status: 400,
        async text() {
          return JSON.stringify({
            error: {
              message: "This request has been flagged for potentially high-risk cyber activity. Learn more here: https://platform.openai.com/docs/guides/safety-checks/cybersecurity",
              code: "invalid_request_body",
            },
          });
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "gpt-5.4",
          choices: [
            {
              message: { content: "served by backup after safety block" },
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
      },
      body: JSON.stringify({
        model: "gpt-5.4",
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
    assert.equal(payload.content[0].text, "served by backup after safety block");
    assert.deepEqual(attempts, ["Bearer token-primary", "Bearer token-backup"]);
  });
});

test("messages endpoint falls back to a supported Copilot model when the client sends an unsupported model", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-model-fallback-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz" });
  const requestBodies = [];
  const loggerCalls = [];
  const logger = {
    logIncomingRequest(entry) {
      loggerCalls.push({ type: "incoming", entry });
    },
    logProviderAttempt(entry) {
      loggerCalls.push({ type: "attempt", entry });
    },
    logProviderResult(entry) {
      loggerCalls.push({ type: "result", entry });
    },
  };

  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "yt-monitor" }, null, 2));

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
    logger,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": workspaceRoot,
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
    const payload = await response.json();
    assert.equal(payload.model, "claude-sonnet-4.5");

    const incoming = loggerCalls.find((call) => call.type === "incoming");
    const attempt = loggerCalls.find((call) => call.type === "attempt");
    const result = loggerCalls.find((call) => call.type === "result" && call.entry.success);
    assert.ok(incoming);
    assert.ok(attempt);
    assert.ok(result);
    assert.equal(incoming.entry.projectName, "yt-monitor");
    assert.equal(incoming.entry.requestedModel, "glm-5");
    assert.equal(incoming.entry.effectiveModel, "claude-sonnet-4.5");
    assert.equal(attempt.entry.provider, "default");
    assert.equal(attempt.entry.requestedModel, "glm-5");
    assert.equal(attempt.entry.effectiveModel, "claude-sonnet-4.5");
    assert.equal(result.entry.actualModel, "claude-sonnet-4.5");
    assert.equal(result.entry.projectName, "yt-monitor");
  });
});

test("messages endpoint falls back from Copilot to Z.ai for GLM models", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-zai-fallback-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("copilot", {
    access_token: "token-copilot",
    token_type: "bearer",
    scope: "read:user",
    provider: "copilot",
    auth_type: "oauth",
  }, { name: "Copilot" });
  tokenStore.saveProvider("zai", {
    access_token: "token-zai",
    token_type: "api_key",
    scope: "api_key",
    provider: "zai",
    auth_type: "api_key",
  }, { name: "Z.ai" });

  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push({ url: String(url), auth: options.headers?.Authorization || "", model: body.model });

    if (String(url).includes("githubcopilot.com")) {
      return {
        ok: false,
        status: 400,
        async text() {
          return "invalid model: glm-5 is not supported";
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "glm-5",
          choices: [
            {
              message: { content: "served by z.ai" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
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
        "x-project-path": "/Users/example/project-glm",
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

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "glm-5");
    assert.equal(payload.content[0].text, "served by z.ai");
    assert.deepEqual(calls, [
      {
        url: "https://api.githubcopilot.com/chat/completions",
        auth: "Bearer token-copilot",
        model: "glm-5",
      },
      {
        url: "https://api.z.ai/api/paas/v4/chat/completions",
        auth: "Bearer token-zai",
        model: "glm-5",
      },
    ]);
  });
});

test("messages endpoint can fall back to every configurable API-key provider", async (t) => {
  for (const [providerId, providerConfig] of Object.entries(API_KEY_PROVIDER_CONFIGS)) {
    await t.test(providerId, async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `llmproxy-app-${providerId}-fallback-`));
      const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
      tokenStore.saveProvider("copilot", {
        access_token: "token-copilot",
        token_type: "bearer",
        scope: "read:user",
        provider: "copilot",
        auth_type: "oauth",
      }, { name: "Copilot" });
      tokenStore.saveProvider(providerId, {
        access_token: `token-${providerId}`,
        token_type: "api_key",
        scope: "api_key",
        provider: providerId,
        auth_type: "api_key",
      }, { name: providerConfig.displayName });

      const calls = [];
      const fetchFn = async (url, options = {}) => {
        const body = JSON.parse(String(options.body || "{}"));
        calls.push({ url: String(url), auth: options.headers?.Authorization || options.headers?.["x-api-key"] || "", model: body.model });

        if (String(url).includes("githubcopilot.com")) {
          return {
            ok: false,
            status: 400,
            async text() {
              return "The requested model is not supported.";
            },
          };
        }

        if (providerConfig.protocol === "anthropic-messages") {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: "msg_provider",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: `served by ${providerId}` }],
                model: body.model,
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 3, output_tokens: 2 },
              };
            },
          };
        }

        return {
          ok: true,
          status: 200,
          async json() {
            return {
              model: body.model,
              choices: [
                {
                  message: { content: `served by ${providerId}` },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            };
          },
        };
      };

      const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-project-path": "/Users/example/project-provider",
          },
          body: JSON.stringify({
            model: "provider-native-model",
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
        const expectedModel = providerId === "deepseek" ? "deepseek-v4-flash" : "provider-native-model";
        assert.equal(payload.model, expectedModel);
        assert.equal(payload.content[0].text, `served by ${providerId}`);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].url, providerConfig.chatCompletionsUrl || providerConfig.messagesUrl);
        assert.equal(calls[1].model, expectedModel);
      });
    });
  }
});

test("messages endpoint prioritizes vision-capable providers when request contains images", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-vision-priority-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("openai", {
    access_token: "token-openai",
    token_type: "api_key",
    scope: "api_key",
    provider: "openai",
    auth_type: "api_key",
  }, { name: "OpenAI" });

  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const auth = options.headers?.Authorization || options.headers?.["x-api-key"] || "";
    const body = JSON.parse(String(options.body || "{}"));
    calls.push({ url: String(url), auth, model: body.model });

    if (auth === "Bearer token-deepseek") {
      return {
        ok: false,
        status: 400,
        async text() {
          return "deepseek should be skipped for image requests when a vision provider exists";
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [
            {
              message: { content: "served by openai vision" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 4 },
        };
      },
    };
  };

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek:deepseek-v4-flash,openai:gpt-4o-mini",
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Descrivi questa immagine" },
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://example.com/cat.png",
                },
              },
            ],
          },
        ],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.content[0].text, "served by openai vision");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, "Bearer token-openai");
    assert.equal(calls[0].model, "gpt-4o-mini");
  });
});

test("messages endpoint tries a provider default model before moving to the next provider", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-provider-default-model-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    scope: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.5",
  }, { name: "Kimi" });
  tokenStore.saveProvider("zai", {
    access_token: "token-zai",
    token_type: "api_key",
    scope: "api_key",
    provider: "zai",
    auth_type: "api_key",
    default_model: "glm-5",
  }, { name: "Z.ai" });

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body.model);
    if (body.model === "gpt-5.4") {
      return {
        ok: false,
        status: 400,
        async text() {
          return "model_not_supported";
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "served by provider default" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        };
      },
    };
  };

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": "/Users/example/project-default-model",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "kimi-k2.5");
    assert.equal(payload.content[0].text, "served by provider default");
    assert.deepEqual(calls, ["gpt-5.4", "kimi-k2.5"]);
  });
});

test("messages endpoint honors provider/model fallback lists from Claude settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-provider-model-list-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    scope: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.5",
  }, { name: "Kimi" });
  tokenStore.saveProvider("zai", {
    access_token: "token-zai",
    token_type: "api_key",
    scope: "api_key",
    provider: "zai",
    auth_type: "api_key",
    default_model: "glm-5",
  }, { name: "Z.ai" });

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "gpt-5.4",
    env: {
      ANTHROPIC_AUTH_TOKEN: "proxy-local",
      ANTHROPIC_DEFAULT_MODEL: "kimi-k2.5,zai-glm-5",
    },
  }, null, 2));

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body.model);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: `served ${body.model}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        };
      },
    };
  };

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": workspaceRoot,
      },
      body: JSON.stringify({
        model: "ignored-by-settings",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "kimi-k2.5");
    assert.deepEqual(calls, ["kimi-k2.5"]);
  });
});

test("messages endpoint keeps deepseek model names intact from Claude settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-deepseek-model-intact-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash",
  }, { name: "DeepSeek" });

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "ignored-by-settings",
    env: {
      ANTHROPIC_AUTH_TOKEN: "proxy-local",
      ANTHROPIC_DEFAULT_MODEL: "deepseek-v4-flash",
    },
  }, null, 2));

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body.model);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "served by deepseek" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        };
      },
    };
  };

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": workspaceRoot,
      },
      body: JSON.stringify({
        model: "ignored-by-settings",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "deepseek-v4-flash");
    assert.deepEqual(calls, ["deepseek-v4-flash"]);
  });
});

test("messages endpoint uses default models for providers not listed in Claude settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-unlisted-provider-default-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("copilot", {
    access_token: "token-copilot",
    token_type: "bearer",
    scope: "read:user",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "gpt-5.4",
  }, { name: "Copilot" });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    scope: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.5",
  }, { name: "Kimi" });

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "ignored",
    env: {
      ANTHROPIC_AUTH_TOKEN: "proxy-local",
      ANTHROPIC_DEFAULT_MODEL: "copilot:gpt-5.4",
    },
  }, null, 2));

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push(body.model);
    if (body.model === "gpt-5.4") {
      return { ok: false, status: 429, async text() { return "rate limit"; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "served by kimi default" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        };
      },
    };
  };

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-project-path": workspaceRoot },
      body: JSON.stringify({
        model: "ignored-by-settings",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "kimi-k2.5");
    assert.equal(payload.content[0].text, "served by kimi default");
    assert.deepEqual(calls, ["gpt-5.4", "kimi-k2.5"]);
  });
});

test("messages endpoint falls back when DeepSeek returns 402 insufficient balance", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-deepseek-balance-fallback-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("openai", {
    access_token: "token-openai",
    token_type: "api_key",
    scope: "api_key",
    provider: "openai",
    auth_type: "api_key",
    default_model: "gpt-4.1",
  }, { name: "OpenAI" });

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const auth = options.headers?.Authorization || options.headers?.["x-api-key"] || "";
    const body = JSON.parse(String(options.body || "{}"));
    calls.push({ auth, model: body.model });

    if (auth === "Bearer token-deepseek") {
      return {
        ok: false,
        status: 402,
        async text() {
          return JSON.stringify({
            error: {
              message: "Insufficient Balance",
              type: "unknown_error",
              code: "invalid_request_error",
            },
          });
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "served by openai fallback" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        };
      },
    };
  };

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek:deepseek-v4-flash,openai:gpt-4.1",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "gpt-4.1");
    assert.equal(payload.content[0].text, "served by openai fallback");
    assert.deepEqual(calls, [
      { auth: "Bearer token-deepseek", model: "deepseek-v4-flash" },
      { auth: "Bearer token-openai", model: "gpt-4.1" },
    ]);
  });
});

test("messages endpoint prefers the Claude project-configured model over the incoming requested model", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-project-model-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz" });
  const requestBodies = [];
  const loggerCalls = [];
  const logger = {
    logIncomingRequest(entry) {
      loggerCalls.push({ type: "incoming", entry });
    },
    logProviderAttempt(entry) {
      loggerCalls.push({ type: "attempt", entry });
    },
    logProviderResult(entry) {
      loggerCalls.push({ type: "result", entry });
    },
  };

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "yt-monitor" }, null, 2));
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "proxy-local",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3015",
      ANTHROPIC_DEFAULT_MODEL: "gpt-5.4",
    },
  }, null, 2));
  fs.writeFileSync(path.join(tempRoot, "copilot-models.json"), JSON.stringify({
    updatedAt: "2026-03-27T00:00:00.000Z",
    models: ["gpt-5.4", "claude-sonnet-4.5"],
  }, null, 2));

  const fetchFn = async (_url, options = {}) => {
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "gpt-5.4",
          choices: [
            {
              message: { content: "configured model ok" },
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
    logger,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": workspaceRoot,
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

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "gpt-5.4");
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].model, "gpt-5.4");

    const incoming = loggerCalls.find((call) => call.type === "incoming");
    const attempt = loggerCalls.find((call) => call.type === "attempt");
    const result = loggerCalls.find((call) => call.type === "result" && call.entry.success);
    assert.ok(incoming);
    assert.ok(attempt);
    assert.ok(result);
    assert.equal(incoming.entry.configuredModel, "gpt-5.4");
    assert.equal(incoming.entry.requestedModel, "gpt-5.4");
    assert.equal(incoming.entry.effectiveModel, "gpt-5.4");
    assert.equal(attempt.entry.requestedModel, "gpt-5.4");
    assert.equal(attempt.entry.effectiveModel, "gpt-5.4");
    assert.equal(result.entry.actualModel, "gpt-5.4");
    assert.equal(result.entry.requestedModel, "gpt-5.4");
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

test("runtime CLI commands are exposed via REST endpoints", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-runtime-api-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("default", { access_token: "token-default", token_type: "bearer", scope: "read:user" }, { name: "Default" });
  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Backup" });

  const serviceCalls = [];
  const serviceManager = {
    kind: "launchd",
    install() {
      serviceCalls.push("install");
      return {
        ok: true,
        stdout: "",
        stderr: "",
        stdoutPath: path.join(tempRoot, "logs", "service.out.log"),
        stderrPath: path.join(tempRoot, "logs", "service.err.log"),
      };
    },
    start() {
      serviceCalls.push("start");
      return { ok: true, stdout: "", stderr: "" };
    },
    stop() {
      serviceCalls.push("stop");
      return { ok: true, stdout: "", stderr: "" };
    },
    status() {
      serviceCalls.push("status");
      return { ok: true, active: true, stdout: "service-ok", stderr: "" };
    },
  };

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    serviceManager,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: "gpt-4.1", object: "model", model_picker_enabled: true, policy: { state: "enabled" } },
            { id: "o3", object: "model", model_picker_enabled: true, policy: { state: "enabled" } },
          ],
        };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const versionResponse = await fetch(`${baseUrl}/api/version`);
    const versionPayload = await versionResponse.json();
    assert.equal(versionResponse.status, 200);
    assert.equal(versionPayload.success, true);
    assert.equal(typeof versionPayload.data.version, "string");

    const helpResponse = await fetch(`${baseUrl}/api/help?command=status`);
    const helpPayload = await helpResponse.json();
    assert.equal(helpResponse.status, 200);
    assert.equal(helpPayload.success, true);
    assert.match(helpPayload.data.output, /llmproxy status/);

    const setupResponse = await fetch(`${baseUrl}/api/setup`);
    const setupPayload = await setupResponse.json();
    assert.equal(setupResponse.status, 200);
    assert.equal(setupPayload.success, true);
    assert.match(setupPayload.data.output, /Runtime root:/);

    const statusResponse = await fetch(`${baseUrl}/api/service/status`);
    const statusPayload = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusPayload.success, true);
    assert.match(statusPayload.data.output, /Service active: yes/);

    const startResponse = await fetch(`${baseUrl}/api/service/start`, { method: "POST" });
    const startPayload = await startResponse.json();
    assert.equal(startResponse.status, 200);
    assert.equal(startPayload.success, true);

    const restartResponse = await fetch(`${baseUrl}/api/service/restart`, { method: "POST" });
    const restartPayload = await restartResponse.json();
    assert.equal(restartResponse.status, 200);
    assert.equal(restartPayload.success, true);

    const modelsResponse = await fetch(`${baseUrl}/api/models`);
    const modelsPayload = await modelsResponse.json();
    assert.equal(modelsResponse.status, 200);
    assert.equal(modelsPayload.success, true);
    assert.match(modelsPayload.data.output, /gpt-4\.1/);

    const providersResponse = await fetch(`${baseUrl}/api/providers`);
    const providersPayload = await providersResponse.json();
    assert.equal(providersResponse.status, 200);
    assert.equal(providersPayload.success, true);
    assert.match(providersPayload.data.output, /default/);

    const providerStatusResponse = await fetch(`${baseUrl}/api/providers/status`);
    const providerStatusPayload = await providerStatusResponse.json();
    assert.equal(providerStatusResponse.status, 200);
    assert.equal(providerStatusPayload.success, true);
    assert.match(providerStatusPayload.data.output, /Active provider:/);

    const providerOrderResponse = await fetch(`${baseUrl}/api/providers/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "backup", position: 1 }),
    });
    const providerOrderPayload = await providerOrderResponse.json();
    assert.equal(providerOrderResponse.status, 200);
    assert.equal(providerOrderPayload.success, true);

    const providerRenameResponse = await fetch(`${baseUrl}/api/providers/backup/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Backup EU" }),
    });
    const providerRenamePayload = await providerRenameResponse.json();
    assert.equal(providerRenameResponse.status, 200);
    assert.equal(providerRenamePayload.success, true);

    const providerApiKeyResponse = await fetch(`${baseUrl}/api/providers/openrouter/api-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-or-test", name: "OpenRouter", model: "openai/gpt-4o" }),
    });
    const providerApiKeyPayload = await providerApiKeyResponse.json();
    assert.equal(providerApiKeyResponse.status, 200);
    assert.equal(providerApiKeyPayload.success, true);

    const providerRemoveResponse = await fetch(`${baseUrl}/api/providers/backup`, { method: "DELETE" });
    const providerRemovePayload = await providerRemoveResponse.json();
    assert.equal(providerRemoveResponse.status, 200);
    assert.equal(providerRemovePayload.success, true);
  });

  assert.ok(serviceCalls.includes("status"));
  assert.ok(serviceCalls.includes("install"));
  assert.ok(!serviceCalls.includes("start"));
});

test("claude setup is exposed via REST endpoint", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-claude-api-"));
  const projectRoot = path.join(tempRoot, "project-a");
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-xyz", token_type: "bearer", scope: "read:user" });
  fs.mkdirSync(projectRoot, { recursive: true });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: "gpt-4.1", object: "model", model_picker_enabled: true, policy: { state: "enabled" } },
            { id: "o3", object: "model", model_picker_enabled: true, policy: { state: "enabled" } },
          ],
        };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const setupResponse = await fetch(`${baseUrl}/api/claude/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: projectRoot, model: "2" }),
    });
    const setupPayload = await setupResponse.json();

    assert.equal(setupResponse.status, 200);
    assert.equal(setupPayload.success, true);
    assert.match(setupPayload.data.output, /Configurazione Claude scritta/);
  });

  const settingsFile = path.join(projectRoot, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.model, "o3");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_MODEL, "o3");
});

test("logs stream endpoint exposes live logs over SSE", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-logs-sse-"));
  const logsDir = path.join(tempRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "service.out.log"), "linea-sse-iniziale\n", "utf8");
  fs.writeFileSync(path.join(logsDir, "service.err.log"), "", "utf8");

  const app = createApp({ dataRoot: tempRoot });

  await withServer(app, async (baseUrl) => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/logs/stream?intervalMs=50`, {
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (let index = 0; index < 20; index += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: log") && buffer.includes("linea-sse-iniziale")) {
        break;
      }
    }

    controller.abort();
    assert.match(buffer, /event: log/);
    assert.match(buffer, /linea-sse-iniziale/);
  });
});
