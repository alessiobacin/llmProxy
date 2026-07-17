const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.LLMPROXY_METERING_INLINE = "true";
process.env.LLMPROXY_INFERENCE_INFO_INLINE = "true";
const TEST_HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-home-"));
fs.mkdirSync(path.join(TEST_HOME_DIR, ".claude"), { recursive: true });
fs.writeFileSync(path.join(TEST_HOME_DIR, ".claude", "settings.json"), JSON.stringify({
  env: {
    LLMPROXY_LLM_STATS_API_KEY: "sk-test-global",
  },
}, null, 2));
process.env.HOME = TEST_HOME_DIR;

const { createApp } = require("../lib/app");
const { API_KEY_PROVIDER_CONFIGS } = require("../lib/copilot-proxy");
const { createTokenStore } = require("../lib/token-store");
const { createProviderRegistry } = require("../lib/provider-registry");

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

function withInferenceMetadata(text, providerId, modelUsed, promptTokens = 0, completionTokens = 0, options = {}) {
  const { header = true, footer = true, reason } = options;
  const requestTokens = Number(promptTokens || 0) + Number(completionTokens || 0);
  const parts = [];
  if (header) {
    let headerStr = `[llmproxy] provider: ${providerId} | model: ${modelUsed}`;
    if (reason) headerStr += ` : ${reason}`;
    parts.push(headerStr);
  }
  parts.push(text);
  if (footer) {
    // Production format: [llmproxy] provider/model (req X, in Y, out Z) | provider/model (in: Y/d, out: Z/d - in: 0/w, out: 0/w)
    parts.push(`[llmproxy] ${providerId}/${modelUsed} (req ${requestTokens}, in ${promptTokens}, out ${completionTokens}) | ${providerId}/${modelUsed} (in: ${promptTokens}/d, out: ${completionTokens}/d - in: 0/w, out: 0/w)`);
  }
  return parts.join("\n\n");
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

test("auth status is true when only API-key providers are configured", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-auth-provider-registry-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  const providerRegistry = createProviderRegistry({ filePath: path.join(tempRoot, "providers.json") });
  providerRegistry.upsert({
    id: "project:p-1:openrouter",
    provider: "openrouter",
    scope_type: "project",
    scope_id: "p-1",
    default_model: "openai/gpt-4o",
    credentials: { api_key: "sk-or-test" },
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry,
    fetchFn: async () => {
      throw new Error("fetch should not run");
    },
  });

  await withServer(app, async (baseUrl) => {
    const authResponse = await fetch(`${baseUrl}/auth/status`);
    const authPayload = await authResponse.json();
    assert.equal(authResponse.status, 200);
    assert.equal(authPayload.authenticated, true);
  });
});

test("auth status endpoint is also available in platform mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-auth-platform-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  const providerRegistry = createProviderRegistry({ filePath: path.join(tempRoot, "providers.json") });
  providerRegistry.upsert({
    id: "project:p-1:deepseek",
    provider: "deepseek",
    scope_type: "project",
    scope_id: "p-1",
    default_model: "deepseek-v4-flash",
    credentials: { api_key: "sk-ds-test" },
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry,
    mode: "platform",
  });

  await withServer(app, async (baseUrl) => {
    const authResponse = await fetch(`${baseUrl}/auth/status`);
    const authPayload = await authResponse.json();
    assert.equal(authResponse.status, 200);
    assert.equal(authPayload.authenticated, true);
  });
});

test("messages endpoint returns a static non-stream response when project LLMPROXY_LLM_STATS_API_KEY is missing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-llm-stats-required-"));
  const claudeDir = path.join(tempRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "",
    },
  }, null, 2));

  const app = createApp({
    dataRoot: tempRoot,
    fetchFn: async () => {
      throw new Error("fetch should not run when LLMPROXY_LLM_STATS_API_KEY is missing");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": tempRoot,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.type, "message");
    assert.match(payload.content[0].text, /LLMPROXY_LLM_STATS_API_KEY is mandatory/i);
    assert.match(payload.content[0].text, /llm-stats\.com\/developer/i);
  });
});

test("messages endpoint returns a static streaming response when project LLMPROXY_LLM_STATS_API_KEY is missing", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-llm-stats-required-stream-"));
  const claudeDir = path.join(tempRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "",
    },
  }, null, 2));

  const app = createApp({
    dataRoot: tempRoot,
    fetchFn: async () => {
      throw new Error("fetch should not run when LLMPROXY_LLM_STATS_API_KEY is missing");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": tempRoot,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.match(payload, /event: content_block_delta/);
    assert.match(payload, /LLMPROXY_LLM_STATS_API_KEY is mandatory/i);
    assert.match(payload, /llm-stats\.com\/developer/i);
  });
});

test("messages endpoint accepts the global Claude LLMPROXY_LLM_STATS_API_KEY when the project key is absent", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-global-llm-stats-fallback-"));
  const homeDir = path.join(tempRoot, "home");
  const projectRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(projectRoot, ".claude");
  const globalClaudeDir = path.join(homeDir, ".claude");
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-global-fallback" });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(globalClaudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
    },
  }, null, 2));
  fs.writeFileSync(path.join(globalClaudeDir, "settings.json"), JSON.stringify({
    env: {
      LLMPROXY_LLM_STATS_API_KEY: "sk-global-demo",
    },
  }, null, 2));

  const app = createApp({
    dataRoot: tempRoot,
    env: { ...process.env, HOME: homeDir },
    tokenStore,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          id: "resp-1",
          choices: [{ message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": projectRoot,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.type, "message");
    assert.doesNotMatch(payload.content[0].text, /LLMPROXY_LLM_STATS_API_KEY is mandatory/i);
  });
});

test("messages endpoint blocks inference when LLMPROXY_LLM_STATS_API_KEY is missing from both project and global Claude settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-global-llm-stats-missing-"));
  const homeDir = path.join(tempRoot, "home");
  const projectRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });

  const app = createApp({
    dataRoot: tempRoot,
    env: { ...process.env, HOME: homeDir },
    fetchFn: async () => {
      throw new Error("fetch should not run when LLMPROXY_LLM_STATS_API_KEY is missing everywhere");
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-project-path": projectRoot,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(payload.content[0].text, /LLMPROXY_LLM_STATS_API_KEY is mandatory/i);
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
    assert.equal(payload.content[0].text, withInferenceMetadata("pong from copilot", "default", "claude-sonnet-4.5", 11, 5, { reason: "First in order from provider list" }));
    assert.equal(payload.model, "claude-sonnet-4.5");
  });
});

test("messages endpoint follows the order persisted by an LLMPROXY_REORDERING price cycle", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-reordering-price-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash",
    free_model: false,
  }, { name: "DeepSeek Paid" });
  tokenStore.saveProvider("opencode", {
    access_token: "token-opencode",
    token_type: "api_key",
    scope: "api_key",
    provider: "opencode",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
    free_model: true,
  }, { name: "OpenCode Free" });

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llm-proxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
      LLMPROXY_INFERENCE_INFO_INLINE: "1",
    },
  }, null, 2));

  const fetchFn = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: String(url).includes("opencode.ai") ? "deepseek-v4-flash-free" : "deepseek-v4-flash",
        choices: [{
          message: { content: String(url).includes("opencode.ai") ? "served by opencode" : "served by deepseek" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      };
    },
  });

  const { createProviderReordering } = require("../lib/provider-reordering");
  const reordering = createProviderReordering({
    tokenStore,
    filePath: path.join(tempRoot, "provider-reordering.json"),
    fetchFn: async () => ({ ok: false }), // price lookup fails for the paid provider -> treated as worst, free wins
  });
  await reordering.runCycle({ LLMPROXY_REORDERING: "price" });
  assert.deepEqual(tokenStore.listProviders().map((provider) => provider.id), ["opencode", "deepseek"]);

  const app = createApp({ dataRoot: tempRoot, tokenStore, fetchFn });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-project-path": workspaceRoot },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(payload.content[0].text, /^\[llmproxy\] provider: opencode \| model: deepseek-v4-flash-free : First in order from provider list/m);
    assert.match(payload.content[0].text, /served by opencode/);
  });
});

test("messages endpoint honors LLMPROXY_METERING_INLINE from Claude project settings", async () => {
  const previousInlineEnv = process.env.LLMPROXY_METERING_INLINE;
  const previousInferenceEnv = process.env.LLMPROXY_INFERENCE_INFO_INLINE;
  process.env.LLMPROXY_METERING_INLINE = "0";
  process.env.LLMPROXY_INFERENCE_INFO_INLINE = "0";

  try {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-project-inline-metering-"));
    const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
    tokenStore.save({ access_token: "token-project-inline" });

    const workspaceRoot = path.join(tempRoot, "workspace");
    const claudeDir = path.join(workspaceRoot, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
      model: "llm-proxy",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
        LLMPROXY_LLM_STATS_API_KEY: "sk-test",
        LLMPROXY_METERING_INLINE: "1",
      },
    }, null, 2));

    const fetchFn = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          model: "claude-sonnet-4.5",
          choices: [
            {
              message: { content: "pong from project inline" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
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
          "x-project-path": workspaceRoot,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          stream: false,
          max_tokens: 64,
          messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.content[0].text, withInferenceMetadata("pong from project inline", "default", "claude-sonnet-4.5", 9, 4, {
        header: false,
      }));
    });
  } finally {
    if (previousInlineEnv === undefined) {
      delete process.env.LLMPROXY_METERING_INLINE;
    } else {
      process.env.LLMPROXY_METERING_INLINE = previousInlineEnv;
    }
    if (previousInferenceEnv === undefined) {
      delete process.env.LLMPROXY_INFERENCE_INFO_INLINE;
    } else {
      process.env.LLMPROXY_INFERENCE_INFO_INLINE = previousInferenceEnv;
    }
  }
});

test("messages endpoint honors LLMPROXY_INFERENCE_INFO_INLINE from Claude project settings", async () => {
  const previousInlineEnv = process.env.LLMPROXY_METERING_INLINE;
  const previousInferenceEnv = process.env.LLMPROXY_INFERENCE_INFO_INLINE;
  process.env.LLMPROXY_METERING_INLINE = "0";
  process.env.LLMPROXY_INFERENCE_INFO_INLINE = "0";

  try {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-project-inline-inference-info-"));
    const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
    tokenStore.save({ access_token: "token-project-inline-info" });

    const workspaceRoot = path.join(tempRoot, "workspace");
    const claudeDir = path.join(workspaceRoot, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
      model: "llm-proxy",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
        LLMPROXY_LLM_STATS_API_KEY: "sk-test",
        LLMPROXY_INFERENCE_INFO_INLINE: "1",
      },
    }, null, 2));

    const fetchFn = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          model: "claude-sonnet-4.5",
          choices: [
            {
              message: { content: "pong from project inline info" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
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
          "x-project-path": workspaceRoot,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          stream: false,
          max_tokens: 64,
          messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.content[0].text, withInferenceMetadata("pong from project inline info", "default", "claude-sonnet-4.5", 9, 4, {
        footer: false,
        reason: "First in order from provider list",
      }));
    });
  } finally {
    if (previousInlineEnv === undefined) {
      delete process.env.LLMPROXY_METERING_INLINE;
    } else {
      process.env.LLMPROXY_METERING_INLINE = previousInlineEnv;
    }
    if (previousInferenceEnv === undefined) {
      delete process.env.LLMPROXY_INFERENCE_INFO_INLINE;
    } else {
      process.env.LLMPROXY_INFERENCE_INFO_INLINE = previousInferenceEnv;
    }
  }
});

test("messages endpoint does not inherit inline flags from process env when Claude settings omit them", async () => {
  const previousInlineEnv = process.env.LLMPROXY_METERING_INLINE;
  const previousInferenceEnv = process.env.LLMPROXY_INFERENCE_INFO_INLINE;
  process.env.LLMPROXY_METERING_INLINE = "1";
  process.env.LLMPROXY_INFERENCE_INFO_INLINE = "1";

  try {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-project-inline-defaults-off-"));
    const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
    tokenStore.save({ access_token: "token-project-inline-defaults-off" });

    const workspaceRoot = path.join(tempRoot, "workspace");
    const claudeDir = path.join(workspaceRoot, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
      model: "llm-proxy",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
        LLMPROXY_LLM_STATS_API_KEY: "sk-test",
      },
    }, null, 2));

    const fetchFn = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          model: "claude-sonnet-4.5",
          choices: [
            {
              message: { content: "pong without inherited inline flags" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
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
          "x-project-path": workspaceRoot,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          stream: false,
          max_tokens: 64,
          messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
        }),
      });

      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.content[0].text, "pong without inherited inline flags");
    });
  } finally {
    if (previousInlineEnv === undefined) {
      delete process.env.LLMPROXY_METERING_INLINE;
    } else {
      process.env.LLMPROXY_METERING_INLINE = previousInlineEnv;
    }
    if (previousInferenceEnv === undefined) {
      delete process.env.LLMPROXY_INFERENCE_INFO_INLINE;
    } else {
      process.env.LLMPROXY_INFERENCE_INFO_INLINE = previousInferenceEnv;
    }
  }
});

test("messages endpoint appends provider and model footer to streaming responses", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-stream-footer-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-stream" });

  const encoder = new TextEncoder();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "claude-sonnet-4.5",
          choices: [{ delta: { content: "pong stream" } }],
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "claude-sonnet-4.5",
          choices: [{ finish_reason: "stop", delta: {} }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: true,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.match(payload, /event: content_block_delta/);
    assert.match(payload, /pong stream/);
    assert.match(payload, /\[llmproxy\] provider: default \| model: claude-sonnet-4\.5/);
  });
});

test("messages endpoint preserves inline provider and metering metadata for non-stream tool_use replies", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-tool-use-inline-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-tool-use" });
  const meteringSink = {
    records: [],
    async record(record) {
      this.records.push(record);
    },
  };

  const fetchFn = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: "claude-sonnet-4.5",
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: "{\"command\":\"pwd\"}",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
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
    meteringSink,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.stop_reason, "tool_use");
    assert.equal(payload.content[0].type, "text");
    assert.match(payload.content[0].text, /\[llmproxy\] provider: default \| model: claude-sonnet-4\.5/);
    assert.equal(payload.content[1].type, "tool_use");
    assert.equal(payload.content.at(-1).type, "text");
    assert.match(payload.content.at(-1).text, /\[llmproxy\] default\/claude-sonnet-4\.5 \(req 16, in 11, out 5\)/);
    assert.equal(meteringSink.records.length, 1);
    assert.equal(meteringSink.records[0].provider, "default");
  });
});

test("messages endpoint preserves inline provider and metering metadata for streaming tool_use replies", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-stream-tool-use-inline-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-stream-tool-use" });
  const meteringSink = {
    records: [],
    async record(record) {
      this.records.push(record);
    },
  };

  const encoder = new TextEncoder();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "claude-sonnet-4.5",
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" },
                },
              ],
            },
            finish_reason: null,
          }],
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "claude-sonnet-4.5",
          choices: [{ finish_reason: "tool_calls", delta: {} }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
    meteringSink,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.match(payload, /\[llmproxy\] provider: default \| model: claude-sonnet-4\.5/);
    assert.match(payload, /\[llmproxy\] default\/claude-sonnet-4\.5 \(req 10, in 7, out 3\)/);
    assert.match(payload, /"type":"tool_use"/);
    assert.match(payload, /"stop_reason":"tool_use"/);
    assert.equal(meteringSink.records.length, 1);
    assert.equal(meteringSink.records[0].provider, "default");
  });
});

test("messages endpoint preserves inline provider and metering metadata for anthropic tool_use streams", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-anthropic-tool-use-inline-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("opencode-go", {
    access_token: "token-opencode-go",
    token_type: "api_key",
    scope: "api_key",
    provider: "opencode-go",
    auth_type: "api_key",
    default_model: "minimax-m3",
  }, { name: "OpenCode Go" });
  const meteringSink = {
    records: [],
    async record(record) {
      this.records.push(record);
    },
  };

  const encoder = new TextEncoder();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "minimax-m3",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })}\n\n`));
        controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
        })}\n\n`));
        controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{\"command\":\"pwd\"}" },
        })}\n\n`));
        controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0,
        })}\n\n`));
        controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { input_tokens: 4, output_tokens: 2 },
        })}\n\n`));
        controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`));
        controller.close();
      },
    }),
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
    meteringSink,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "opencode-go",
        model: "minimax-m3",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.match(payload, /\[llmproxy\] provider: opencode-go \| model: minimax-m3/);
    assert.match(payload, /\[llmproxy\] opencode-go\/minimax-m3 \(req 6, in 4, out 2\)/);
    assert.match(payload, /"type":"tool_use"/);
    assert.match(payload, /"stop_reason":"tool_use"/);
    assert.equal(meteringSink.records.length, 1);
    assert.equal(meteringSink.records[0].provider, "opencode-go");
  });
});

test("messages endpoint counts tokens from a usage-only final streaming chunk", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-stream-usage-only-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-stream-usage-only" });

  const encoder = new TextEncoder();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "qwen3.7-max",
          choices: [{ delta: { content: "pong stream" } }],
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "qwen3.7-max",
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 236, total_tokens: 256 },
        })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: true,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.match(payload, /pong stream/);
    assert.match(payload, /\[llmproxy\] default\/qwen3\.7-max \(req 256, in 20, out 236\)/);
  });
});

test("messages endpoint rewrites provider metadata once when upstream response already contains llmproxy lines", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-dedup-response-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-dedup" });

  const fetchFn = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: "claude-sonnet-4.5",
        choices: [
          {
            message: {
              content: "build ok\n\n[llmproxy] provider: qwen | model: qwen3.7-max\n[llmproxy] req 0 (in 0, out 0) | today 980728 | week 1196086",
            },
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
      headers: { "content-type": "application/json" },
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
    assert.equal(payload.content[0].text, withInferenceMetadata("build ok", "default", "claude-sonnet-4.5", 11, 5, { reason: "First in order from provider list" }));
  });
});

test("messages endpoint strips llmproxy metadata from streaming provider deltas before appending its own", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-stream-dedup-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-stream-dedup" });

  const encoder = new TextEncoder();
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "claude-sonnet-4.5",
          choices: [{
            delta: {
              content: "build ok\n\n[llmproxy] provider: qwen | model: qwen3.7-max\n[llmproxy] req 0 (in 0, out 0) | today 980728 | week 1196086",
            },
          }],
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          model: "claude-sonnet-4.5",
          choices: [{ finish_reason: "stop", delta: {} }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  });

  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    fetchFn,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: true,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Ping" }],
          },
        ],
      }),
    });

    const payload = await response.text();
    assert.equal(response.status, 200);
    assert.match(payload, /build ok/);
    assert.equal((payload.match(/\[llmproxy\] provider:/g) || []).length, 1);
    assert.doesNotMatch(payload, /today 980728/);
  });
});

test("messages endpoint falls back to the next Copilot provider when the first one fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-fallback-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("primary", { access_token: "token-primary", token_type: "bearer", scope: "read:user" }, { name: "Primary" });
  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Backup" });

  const attempts = [];
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
    logRequestSummary(entry) {
      loggerCalls.push({ type: "summary", entry });
    },
  };
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
    logger,
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
    assert.equal(payload.content[0].text, withInferenceMetadata("served by backup", "backup", "claude-sonnet-4.5", 11, 4, { reason: "Second in order because claude-sonnet-4.5 (primary) is returning: 503" }));
    assert.deepEqual(attempts, ["Bearer token-primary", "Bearer token-backup"]);
    const summaryLog = loggerCalls.find((entry) => entry.type === "summary");
    assert.ok(summaryLog);
    assert.equal(summaryLog.entry.finalProvider, "backup");
    assert.equal(summaryLog.entry.providerAttempts.length, 2);
    assert.deepEqual(summaryLog.entry.providerAttempts.map((attempt) => attempt.provider), ["primary", "backup"]);
  });
});

test("messages endpoint strips llmproxy metadata from prior conversation turns before proxying", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-strip-metadata-history-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-history" });

  const requestBodies = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    requestBodies.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: "ok",
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: body.model,
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "build ok\n\n[llmproxy] provider: qwen | model: qwen3.7-max\n[llmproxy] req 0 (in 0, out 0) | today 980728 | week 1196086" }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "continua" }],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const proxiedAssistantMessage = requestBodies[0].messages.find((message) => message.role === "assistant");
    assert.ok(proxiedAssistantMessage);
    assert.equal(proxiedAssistantMessage.role, "assistant");
    assert.equal(String(proxiedAssistantMessage.content || "").includes("[llmproxy]"), false);
    assert.match(String(proxiedAssistantMessage.content || ""), /build ok/);
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
    assert.equal(payload.content[0].text, withInferenceMetadata("trim ok", "default", "gpt-5.4", 9, 3, { reason: "First in order from provider list" }));
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

test("messages endpoint trims oldest messages and retries when Copilot rejects prompt token count", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-context-trim-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-trim" });

  const requestBodies = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({
            error: {
              message: "prompt token count of 86627 exceeds the limit of 64000",
              code: "model_max_prompt_tokens_exceeded",
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
          choices: [
            {
              message: { content: "context trimmed ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [
          { role: "user", content: [{ type: "text", text: "oldest user" }] },
          { role: "assistant", content: [{ type: "text", text: "assistant reply" }] },
          { role: "user", content: [{ type: "text", text: "latest user" }] },
        ],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.content[0].text, withInferenceMetadata("context trimmed ok", "default", "claude-sonnet-4.5", 100, 5, { reason: "First in order from provider list" }));
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].messages.length, 4);
    assert.equal(requestBodies[1].messages.length, 3);
    assert.match(JSON.stringify(requestBodies[1].messages), /assistant reply/);
    assert.match(JSON.stringify(requestBodies[1].messages), /latest user/);
    assert.doesNotMatch(JSON.stringify(requestBodies[1].messages), /oldest user/);
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
    assert.equal(payload.content[0].text, withInferenceMetadata("retry success", "default", "claude-sonnet-4.5", 10, 3, { reason: "First in order from provider list" }));
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
    assert.equal(payload.content[0].text, withInferenceMetadata("served by backup after safety block", "backup", "gpt-5.4", 11, 4, { reason: "Second in order because claude-sonnet-4.5 (primary) is returning: 400" }));
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
    assert.equal(payload.content[0].text, withInferenceMetadata("served by z.ai", "zai", "glm-5", 9, 4, { reason: "Second in order because glm-5 (copilot) is returning: 400" }));
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
        const expectedModel = providerId === "deepseek"
          ? "deepseek-v4-flash"
          : providerId === "qwen"
            ? "qwen3.7-max"
            : providerId === "opencode"
              ? "deepseek-v4-flash"
              : providerId === "opencode-go"
                ? "minimax-m3"
            : "provider-native-model";
        assert.equal(payload.model, expectedModel);
        // Il copilot model nel reason può essere provider-native-model o
        // claude-sonnet-4.5. Verifichiamo la struttura completa con regex.
        const fullPat =
          `^\\[llmproxy\\] provider: ${providerId} \\| model: ${expectedModel}` +
          ` : Second in order because .+ \\(copilot\\) is returning: 400\\n\\n` +
          `served by ${providerId}\\n\\n` +
          `\\[llmproxy\\] ${providerId}\\/${String(expectedModel).replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")} \\(req 5, in 3, out 2\\).+`;
        assert.match(payload.content[0].text, new RegExp(fullPat));
        assert.equal(calls.length, 2);
        assert.equal(calls[1].url, providerConfig.chatCompletionsUrl || providerConfig.messagesUrl);
        assert.equal(calls[1].model, expectedModel);
      });
    });
  }
});

test("messages endpoint still tries providers in configured order when request contains images", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-vision-priority-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    vision: true,
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
    calls.push({ url: String(url), auth, model: body.model, messages: body.messages });

    if (auth === "Bearer token-deepseek") {
      return {
        ok: false,
        status: 400,
        async text() {
          return "deepseek does not support vision input directly";
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
    assert.equal(payload.content[0].text, withInferenceMetadata("served by openai vision", "openai", "gpt-4o-mini", 7, 4, { reason: "Second in order because deepseek-v4-flash (deepseek) is returning: 400" }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].auth, "Bearer token-deepseek");
    assert.equal(calls[0].model, "deepseek-v4-flash");
    assert.match(JSON.stringify(calls[0].messages), /image_url/);
    assert.equal(calls[1].auth, "Bearer token-openai");
    assert.equal(calls[1].model, "gpt-4o-mini");
  });
});

test("messages endpoint routes qwen token-plan keys to the token-plan endpoint", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-qwen-token-plan-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("qwen", {
    access_token: "sk-sp-qwen-token-plan",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "Qwen" });

  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push({ url, model: body.model });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [
            {
              message: { content: "served by qwen token plan" },
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
        "x-project-path": "/Users/example/project-qwen-token-plan",
      },
      body: JSON.stringify({
        model: "qwen3.7-max",
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
    assert.equal(payload.model, "qwen3.7-max");
    assert.equal(payload.content[0].text, withInferenceMetadata("served by qwen token plan", "qwen", "qwen3.7-max", 3, 2, { reason: "First in order from provider list" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(calls[0].model, "qwen3.7-max");
  });
});

test("messages endpoint honors an explicit local provider variant id", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-explicit-provider-variant-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("qwen3.7-max", {
    access_token: "sk-sp-qwen-token-plan",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "Qwen 3.7 Max" });

  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    calls.push({ url: String(url), model: body.model });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [
            {
              message: { content: "served by explicit local variant" },
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
        "x-project-path": "/Users/example/project-explicit-provider-variant",
      },
      body: JSON.stringify({
        provider: "qwen3.7-max",
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
    assert.equal(payload.model, "qwen3.7-max");
    assert.equal(payload.content[0].text, withInferenceMetadata("served by explicit local variant", "qwen3.7-max", "qwen3.7-max", 3, 2, { reason: "First in order from provider list" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(calls[0].model, "qwen3.7-max");
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
    assert.equal(payload.content[0].text, withInferenceMetadata("served by provider default", "kimi", "kimi-k2.5", 1, 2, { reason: "Second in order because gpt-5.4 is returning: 400" }));
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
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
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
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
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
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
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
    assert.equal(payload.content[0].text, withInferenceMetadata("served by openai fallback", "openai", "gpt-4.1", 3, 2, { reason: "Second in order because deepseek-v4-flash (deepseek) is returning: 402" }));
    assert.deepEqual(calls, [
      { auth: "Bearer token-deepseek", model: "deepseek-v4-flash" },
      { auth: "Bearer token-openai", model: "gpt-4.1" },
    ]);
  });
});

test("messages endpoint ignores llmProxy UI labels when project settings are unavailable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-ignore-ui-label-"));
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

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    const auth = String(options.headers?.Authorization || "");
    calls.push({ auth, model: body.model });
    if (auth === "Bearer token-copilot") {
      return { ok: false, status: 429, async text() { return "quota exceeded"; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "served by kimi default" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
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
        model: "llmProxy",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "kimi-k2.5");
    assert.deepEqual(calls, [
      { auth: "Bearer token-copilot", model: "gpt-5.4" },
      { auth: "Bearer token-kimi", model: "kimi-k2.5" },
    ]);
  });
});

test("messages endpoint ignores llm-proxy UI labels when project settings are unavailable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-ignore-ui-kebab-label-"));
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

  const calls = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    const auth = String(options.headers?.Authorization || "");
    calls.push({ auth, model: body.model });
    if (auth === "Bearer token-copilot") {
      return { ok: false, status: 429, async text() { return "quota exceeded"; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: body.model,
          choices: [{ message: { content: "served by kimi default" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
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
        model: "llm-proxy",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "kimi-k2.5");
    assert.deepEqual(calls, [
      { auth: "Bearer token-copilot", model: "gpt-5.4" },
      { auth: "Bearer token-kimi", model: "kimi-k2.5" },
    ]);
  });
});

test("messages endpoint ignores sticky Claude models when project settings delegate model routing to llm-proxy", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-proxy-controlled-kebab-model-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("openrouter", {
    access_token: "token-openrouter",
    token_type: "api_key",
    scope: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "minimax/minimax-m3",
  }, { name: "OpenRouter" });
  tokenStore.setProviderOrder(["deepseek", "openrouter"]);

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llm-proxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
    },
  }, null, 2));

  const requestBodies = [];
  const authHeaders = [];
  const fetchFn = async (_url, options = {}) => {
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    authHeaders.push(String(options.headers?.Authorization || ""));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "deepseek-v4-pro",
          choices: [
            {
              message: { content: "proxy order respected" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
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
        model: "minimax/minimax-m3",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "deepseek-v4-pro");
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].model, "deepseek-v4-pro");
    assert.deepEqual(authHeaders, ["Bearer token-deepseek"]);
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
      ANTHROPIC_BASE_URL: "http://127.0.0.1:5045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
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

test("messages endpoint ignores sticky Claude models when project settings delegate model routing to llmproxy", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-proxy-controlled-model-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("openrouter", {
    access_token: "token-openrouter",
    token_type: "api_key",
    scope: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "minimax/minimax-m3",
  }, { name: "OpenRouter" });
  tokenStore.setProviderOrder(["deepseek", "openrouter"]);

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
    },
  }, null, 2));

  const requestBodies = [];
  const authHeaders = [];
  const fetchFn = async (_url, options = {}) => {
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    authHeaders.push(String(options.headers?.Authorization || ""));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "deepseek-v4-pro",
          choices: [
            {
              message: { content: "proxy order respected" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
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
        model: "minimax/minimax-m3",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.model, "deepseek-v4-pro");
    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].model, "deepseek-v4-pro");
    assert.deepEqual(authHeaders, ["Bearer token-deepseek"]);
  });
});

test("messages endpoint injects a short-answer system instruction from Claude project settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-short-answer-project-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-short-answer-project" });
  const requestBodies = [];

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
      LLMPROXY_SHORT_ANSWER: "1",
    },
  }, null, 2));

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
              message: { content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
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
        "x-project-path": workspaceRoot,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestBodies.length, 1);
    assert.match(String(requestBodies[0].messages[0].content || ""), /Respond as briefly as possible/);
    assert.match(String(requestBodies[0].messages[0].content || ""), /At the start of every assistant reply/);
    assert.equal("shortAnswer" in requestBodies[0], false);
  });
});

test("messages endpoint defaults LLMPROXY_SHORT_ANSWER to off when unset", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-short-answer-default-off-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-short-answer-default-off" });
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
              message: { content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
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
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestBodies.length, 1);
    assert.doesNotMatch(String(requestBodies[0].messages[0].content || ""), /Respond as briefly as possible/);
    assert.match(String(requestBodies[0].messages[0].content || ""), /At the start of every assistant reply/);
  });
});

test("messages endpoint lets a request disable project shortAnswer with shortAnswer false", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-short-answer-override-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-short-answer-override" });
  const requestBodies = [];

  const workspaceRoot = path.join(tempRoot, "workspace");
  const claudeDir = path.join(workspaceRoot, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
      LLMPROXY_SHORT_ANSWER: "true",
    },
  }, null, 2));

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
              message: { content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
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
        "x-project-path": workspaceRoot,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        shortAnswer: false,
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text: "Ping" }] }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requestBodies.length, 1);
    assert.doesNotMatch(String(requestBodies[0].messages[0].content || ""), /Respond as briefly as possible/);
    assert.equal("shortAnswer" in requestBodies[0], false);
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
      return { ok: true, stdoutPath: path.join(tempRoot, "logs", "service.out.log"), stderrPath: path.join(tempRoot, "logs", "service.err.log") };
    },
    start() {
      serviceCalls.push("start");
      return { ok: true, stdout: "", stderr: "" };
    },
    restart() {
      serviceCalls.push("restart");
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

    const releaseNotesResponse = await fetch(`${baseUrl}/api/release-notes?version=0.2.62`);
    const releaseNotesPayload = await releaseNotesResponse.json();
    assert.equal(releaseNotesResponse.status, 200);
    assert.equal(releaseNotesPayload.success, true);
    assert.match(releaseNotesPayload.data.output, /0\.2\.62/);

    const providersResponse = await fetch(`${baseUrl}/api/providers`);
    const providersPayload = await providersResponse.json();
    assert.equal(providersResponse.status, 200);
    assert.equal(providersPayload.success, true);
    assert.match(providersPayload.data.output, /default/);

    const providersAvailableResponse = await fetch(`${baseUrl}/api/providers/available`);
    const providersAvailablePayload = await providersAvailableResponse.json();
    assert.equal(providersAvailableResponse.status, 200);
    assert.equal(providersAvailablePayload.success, true);
    assert.match(providersAvailablePayload.data.output, /copilot/);

    const providerStatusResponse = await fetch(`${baseUrl}/api/providers/status`);
    const providerStatusPayload = await providerStatusResponse.json();
    assert.equal(providerStatusResponse.status, 200);
    assert.equal(providerStatusPayload.success, true);
    assert.match(providerStatusPayload.data.output, /Active provider:/);

    const providerUsageResponse = await fetch(`${baseUrl}/api/providers/usage`);
    const providerUsagePayload = await providerUsageResponse.json();
    assert.equal(providerUsageResponse.status, 200);
    assert.equal(providerUsagePayload.success, true);

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

    const statsResponse = await fetch(`${baseUrl}/api/stats`);
    const statsPayload = await statsResponse.json();
    assert.equal(statsResponse.status, 200);
    assert.equal(statsPayload.success, true);
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
  assert.equal(settings.model, "llmProxy");
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
});

test("model:set and config endpoints are exposed via REST", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-config-api-"));
  const projectRoot = path.join(tempRoot, "project-b");
  fs.mkdirSync(projectRoot, { recursive: true });

  const app = createApp({
    dataRoot: tempRoot,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const modelResponse = await fetch(`${baseUrl}/api/model/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: projectRoot, model: "deepseek:deepseek-v4-flash" }),
    });
    const modelPayload = await modelResponse.json();
    assert.equal(modelResponse.status, 200);
    assert.equal(modelPayload.success, true);

    const configSetResponse = await fetch(`${baseUrl}/api/config/LLMPROXY_SHORT_ANSWER`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: projectRoot, scope: "project", value: "1" }),
    });
    const configSetPayload = await configSetResponse.json();
    assert.equal(configSetResponse.status, 200);
    assert.equal(configSetPayload.success, true);

    const configGetResponse = await fetch(`${baseUrl}/api/config/LLMPROXY_SHORT_ANSWER?scope=project&projectPath=${encodeURIComponent(projectRoot)}`);
    const configGetPayload = await configGetResponse.json();
    assert.equal(configGetResponse.status, 200);
    assert.equal(configGetPayload.success, true);
    assert.match(configGetPayload.data.output, /project\.LLMPROXY_SHORT_ANSWER=1/);

    const configListResponse = await fetch(`${baseUrl}/api/config?scope=project&projectPath=${encodeURIComponent(projectRoot)}`);
    const configListPayload = await configListResponse.json();
    assert.equal(configListResponse.status, 200);
    assert.equal(configListPayload.success, true);
    assert.match(configListPayload.data.output, /Project configuration:/);
    assert.match(configListPayload.data.output, /project\.LLMPROXY_SHORT_ANSWER=1/);
    assert.match(configListPayload.data.output, /project\.LLMPROXY_INFERENCE_INFO_INLINE=1/);

    const configUnsetResponse = await fetch(`${baseUrl}/api/config/LLMPROXY_SHORT_ANSWER`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath: projectRoot, scope: "project" }),
    });
    const configUnsetPayload = await configUnsetResponse.json();
    assert.equal(configUnsetResponse.status, 200);
    assert.equal(configUnsetPayload.success, true);
  });

  const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "deepseek:deepseek-v4-flash");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_MODEL, "deepseek:deepseek-v4-flash");
  assert.equal("LLMPROXY_SHORT_ANSWER" in settings.env, false);
});

test("REST config endpoints support the global Claude scope", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-app-config-global-api-"));
  const projectRoot = path.join(tempRoot, "project-global");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const app = createApp({
      dataRoot: tempRoot,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      }),
    });

    await withServer(app, async (baseUrl) => {
      const configSetResponse = await fetch(`${baseUrl}/api/config/LLMPROXY_LLM_STATS_API_KEY`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: projectRoot, scope: "global", value: "sk-global-demo" }),
      });
      const configSetPayload = await configSetResponse.json();
      assert.equal(configSetResponse.status, 200);
      assert.equal(configSetPayload.success, true);
      assert.match(configSetPayload.data.output, /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);

      const configGetResponse = await fetch(`${baseUrl}/api/config/LLMPROXY_LLM_STATS_API_KEY?scope=global&projectPath=${encodeURIComponent(projectRoot)}`);
      const configGetPayload = await configGetResponse.json();
      assert.equal(configGetResponse.status, 200);
      assert.equal(configGetPayload.success, true);
      assert.match(configGetPayload.data.output, /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);

      const configListResponse = await fetch(`${baseUrl}/api/config?scope=global&projectPath=${encodeURIComponent(projectRoot)}`);
      const configListPayload = await configListResponse.json();
      assert.equal(configListResponse.status, 200);
      assert.equal(configListPayload.success, true);
      assert.match(configListPayload.data.output, /Global Claude configuration:/);
      assert.match(configListPayload.data.output, /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);

      const configUnsetResponse = await fetch(`${baseUrl}/api/config/LLMPROXY_LLM_STATS_API_KEY`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath: projectRoot, scope: "global" }),
      });
      const configUnsetPayload = await configUnsetResponse.json();
      assert.equal(configUnsetResponse.status, 200);
      assert.equal(configUnsetPayload.success, true);
    });
  } finally {
    process.env.HOME = originalHome;
  }
});

test("REST surface covers the CLI command families that are meant to have HTTP equivalents", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "lib", "app.js"), "utf8");
  const requiredRoutes = [
    "/api/release-notes",
    "/api/model/set",
    "/api/providers/available",
    "/api/providers/usage",
    "/api/stats",
    "/api/config",
    "/api/config/:key",
    "/api/service/runtime",
    "/api/update",
    "/api/uninstall",
  ];

  for (const route of requiredRoutes) {
    assert.match(appSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
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
