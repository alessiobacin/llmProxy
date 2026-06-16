const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCli, resolveServiceEnvironment, resolveServiceEntryFile, resolveCliServiceManagerOptions, runSelfUpdate } = require("../lib/cli");
const { deriveUserScopedPort } = require("../lib/runtime-env");

function createWritableBuffer() {
  let output = "";
  return {
    write(chunk) {
      output += String(chunk);
    },
    toString() {
      return output;
    },
  };
}

test("resolveServiceEnvironment aligns service ports with the CLI runtime env", () => {
  const serviceEnv = resolveServiceEnvironment({
    env: {
      PORT: "5045",
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      LLMPROXY_ENV: "development",
      LLMPROXY_MODE: "platform",
      LLMPROXY_METERING_SINK: "dblayer",
      DBLAYER_URL: "http://localhost:5046",
      EVENTBUS_URL: "http://localhost:5048",
      LLMPROXY_LOG_RETENTION_DAYS: "7",
    },
    paths: {
      dataRoot: "/tmp/llmproxy-runtime",
      packageRoot: "/tmp/llmproxy-package",
    },
    dockerComposeFile: "/tmp/llmproxy-package/docker-compose.production.yml",
  });

  assert.equal(serviceEnv.PORT, "5045");
  assert.equal(serviceEnv.HOST, "127.0.0.1");
  assert.equal(serviceEnv.LLMPROXY_GLOBAL_SERVICE, "1");
  assert.equal(serviceEnv.NODE_ENV, "development");
  assert.equal(serviceEnv.LLMPROXY_ENV, "development");
  assert.equal(serviceEnv.DBLAYER_URL, "http://localhost:5046");
  assert.equal(serviceEnv.EVENTBUS_URL, "http://localhost:5048");
  assert.equal(serviceEnv.LLMPROXY_LOG_RETENTION_DAYS, "7");
});

test("resolveServiceEntryFile uses the Docker wrapper for production service mode", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "production" },
    packageRoot: "/tmp/node_modules/llmproxy",
    targetPlatform: "darwin",
  });

  assert.equal(entryFile, "/tmp/node_modules/llmproxy/lib/service/docker-launchd-entry.js");
});

test("resolveServiceEntryFile uses the Docker wrapper on Linux in production", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "production" },
    packageRoot: "/tmp/node_modules/llmproxy",
    targetPlatform: "linux",
  });

  assert.equal(entryFile, "/tmp/node_modules/llmproxy/lib/service/docker-launchd-entry.js");
});

test("resolveServiceEntryFile uses the native server entrypoint in local development", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "development" },
    packageRoot: "/tmp/llmproxy-package",
  });

  assert.equal(entryFile, "/tmp/llmproxy-package/server.js");
});

test("resolveServiceEntryFile allows forcing the native server runtime", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "production", LLMPROXY_SERVICE_RUNTIME: "node" },
    packageRoot: "/tmp/node_modules/llmproxy",
  });

  assert.equal(entryFile, "/tmp/node_modules/llmproxy/server.js");
});

test("resolveCliServiceManagerOptions uses the Docker wrapper for installed production runtime", () => {
  const options = resolveCliServiceManagerOptions({
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
    },
    paths: {
      packageRoot: "/tmp/node_modules/llmproxy",
      dataRoot: "/Users/alessiobacin/Library/Application Support/llmProxy",
      launchAgentFile: "/Users/alessiobacin/Library/LaunchAgents/com.llmproxy.service.plist",
      systemdUnitFile: "/tmp/llmproxy.service",
      stdoutLogFile: "/tmp/service.out.log",
      stderrLogFile: "/tmp/service.err.log",
    },
    targetPlatform: "darwin",
  });

  assert.equal(options.entryFile, "/tmp/node_modules/llmproxy/lib/service/docker-launchd-entry.js");
  assert.equal(options.environment.PORT, "7045");
  assert.equal(options.environment.HOST, "127.0.0.1");
  assert.equal(options.environment.LLMPROXY_GLOBAL_SERVICE, "1");
});

test("resolveCliServiceManagerOptions uses the Docker wrapper on Linux in production", () => {
  const options = resolveCliServiceManagerOptions({
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
    },
    paths: {
      packageRoot: "/tmp/node_modules/llmproxy",
      dataRoot: "/home/aqdas/.local/share/llmProxy",
      launchAgentFile: "/tmp/com.llmproxy.service.plist",
      systemdUnitFile: "/tmp/llmproxy.service",
      stdoutLogFile: "/tmp/service.out.log",
      stderrLogFile: "/tmp/service.err.log",
    },
    targetPlatform: "linux",
  });

  assert.equal(options.entryFile, "/tmp/node_modules/llmproxy/lib/service/docker-launchd-entry.js");
  assert.equal(options.environment.PORT, "7045");
  assert.equal(options.environment.HOST, "127.0.0.1");
  assert.equal(options.environment.LLMPROXY_GLOBAL_SERVICE, "1");
  assert.equal(options.environment.LLMPROXY_SHARED_PROVIDER_REGISTRY, "1");
});

test("claude:setup creates .claude/settings.json for the current project", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-project-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-runtime-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "claude:setup"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    stdout,
    stderr,
  });

  const settingsFile = path.join(tempRoot, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.equal(settings.model, "llmProxy");
  assert.equal("ANTHROPIC_AUTH_TOKEN" in settings.env, false);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:5045");
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.equal(settings.env.API_TIMEOUT_MS, "3000000");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
  assert.match(stdout.toString(), /settings\.json/);
});

test("claude:setup merges env settings without overwriting unrelated project settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-merge-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-runtime-"));
  const claudeDir = path.join(tempRoot, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const stdout = createWritableBuffer();

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    permissions: {
      allow: ["Bash(node:*)"],
    },
    env: {
      EXISTING_FLAG: "keep-me",
      ANTHROPIC_BASE_URL: "http://old-host:9999",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "claude:setup"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    env: {
      PORT: "4242",
      HOST: "0.0.0.0",
    },
    stdout,
  });

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.deepEqual(settings.permissions, { allow: ["Bash(node:*)"] });
  assert.equal(settings.env.EXISTING_FLAG, "keep-me");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://0.0.0.0:4242");
  assert.equal("ANTHROPIC_AUTH_TOKEN" in settings.env, false);
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.match(stdout.toString(), /http:\/\/0\.0\.0\.0:4242/);
});

test("claude:setup loads HOST and PORT from the llmproxy package .env file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-dotenv-project-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-dotenv-runtime-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-dotenv-package-"));
  const stdout = createWritableBuffer();

  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=3015\nHOST=127.0.0.1\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "claude:setup"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    packageRoot,
    stdout,
  });

  const settingsFile = path.join(tempRoot, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(settings.model, "llmProxy");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3015");
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.match(stdout.toString(), /http:\/\/127\.0\.0\.1:3015/);
});

test("claude:setup uses the production service port 7045 when the installed CLI profile is active", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-claude-project-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-claude-runtime-"));
  const serviceHome = "/Users/alessiobacin/Library/Application Support/llmProxy";
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "claude:setup"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_HOME: serviceHome,
      HOST: "127.0.0.1",
    },
    stdout,
  });

  const settingsFile = path.join(tempRoot, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7045");
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.match(stdout.toString(), /http:\/\/127\.0\.0\.1:7045/);
});

test("claude:setup writes a local scope auth token when shared provider registry is enabled", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-shared-claude-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-shared-runtime-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "claude:setup"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    env: {
      LLMPROXY_SHARED_PROVIDER_REGISTRY: "1",
      LLMPROXY_SCOPE_USER: "aqdas",
    },
    stdout,
  });

  const settings = JSON.parse(fs.readFileSync(path.join(tempRoot, ".claude", "settings.json"), "utf8"));
  assert.equal(exitCode, 0);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "llmproxy-local-user:aqdas");
  assert.match(stdout.toString(), /ANTHROPIC_BASE_URL/);
});

test("provider:add performs a dedicated Copilot login and provider:list shows fallback order", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-"));
  const stdout = createWritableBuffer();
  const fetchPayloads = [
    {
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-EFGH",
      device_code: "device-code-1",
      interval: 0,
    },
    {
      access_token: "backup-token",
      token_type: "bearer",
      scope: "read:user",
    },
  ];

  const fetchFn = async () => ({
    ok: true,
    async json() {
      return fetchPayloads.shift();
    },
  });

  const addExitCode = await runCli(["node", "llmproxy", "provider:add", "backup", "--name", "Backup Copilot"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
    sleep: async () => {},
  });

  const listStdout = createWritableBuffer();
  const listExitCode = await runCli(["node", "llmproxy", "provider:list"], {
    dataRoot: runtimeRoot,
    stdout: listStdout,
  });

  assert.equal(addExitCode, 0);
  assert.equal(listExitCode, 0);
  assert.match(stdout.toString(), /Login completato/);
  assert.match(listStdout.toString(), /1\. backup \(Backup Copilot\)/);
});

test("provider:available shows supported providers with aliases and auth type", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-available-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "provider:available"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /1\. copilot \(GitHub Copilot\) auth=oauth/);
  assert.match(stdout.toString(), /2\. openrouter \(OpenRouter\) auth=api_key/);
  assert.match(stdout.toString(), /3\. zai \(Z\.AI\) auth=api_key aliases=z\.ai/);
  assert.match(stdout.toString(), /qwen \(Qwen \(DashScope\)\) auth=api_key/);
  assert.match(stdout.toString(), /opencode \(OpenCode Zen\) auth=api_key aliases=zen/);
  assert.match(stdout.toString(), /opencode-go \(OpenCode Go\) auth=api_key aliases=go, opencodego/);
});

test("provider:add supports api-key providers like openrouter", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-apikey-"));
  const stdout = createWritableBuffer();
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return {}; } });

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "openrouter", "--name", "OpenRouter", "--api-key", "sk-or-test", "--model", "openai/gpt-4o", "--vision", "true"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const provider = tokenStore.getProvider("openrouter");

  assert.equal(exitCode, 0);
  assert.ok(provider);
  assert.equal(provider.access_token, "sk-or-test");
  assert.equal(provider.auth_type, "api_key");
  assert.equal(provider.provider, "openrouter");
  assert.equal(provider.default_model, "openai/gpt-4o");
  assert.match(stdout.toString(), /Provider configurato con API key/);
});

test("provider:add stores shared user-scoped providers in provider-registry when enabled", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-shared-provider-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "openrouter", "--api-key", "sk-shared", "--model", "openai/gpt-4.1-mini", "--vision", "false"], {
    dataRoot: runtimeRoot,
    env: {
      LLMPROXY_SHARED_PROVIDER_REGISTRY: "1",
      LLMPROXY_SCOPE_USER: "aqdas",
    },
    stdout,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: "ok" } }] }; } }),
  });

  const registry = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "provider-registry.json"), "utf8"));
  assert.equal(exitCode, 0);
  assert.equal(Array.isArray(registry.entries), true);
  assert.equal(registry.entries[0].scope_type, "user");
  assert.equal(registry.entries[0].scope_id, "aqdas");
  assert.equal(registry.entries[0].provider, "openrouter");
  assert.match(stdout.toString(), /Provider configurato con API key/);
});

test("provider:add supports api-key providers like qwen", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-qwen-"));
  const stdout = createWritableBuffer();
  const requestUrls = [];
  const requestBodies = [];
  const fetchFn = async (url, options = {}) => {
    requestUrls.push(url);
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: "ok" };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "qwen", "--name", "Qwen", "--api-key", "sk-qwen-test", "--model", "qwen3.7-max", "--vision", "false"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const saved = tokenStore.getProvider("qwen");
  assert.equal(exitCode, 0);
  assert.equal(saved.provider, "qwen");
  assert.equal(saved.default_model, "qwen3.7-max");
  assert.equal(saved.endpoint_variant, "dashscope");
  assert.equal(saved.vision, false);
  assert.equal(requestUrls[0], "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(requestBodies[0].model, "qwen3.7-max");
  assert.match(stdout.toString(), /Provider configurato con API key: qwen \(default model: qwen3\.7-max, vision: false, plan: payg\)/);
});

test("provider:add supports qwen subscription plan explicitly", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-qwen-subscription-"));
  const stdout = createWritableBuffer();
  const requestUrls = [];
  const fetchFn = async (url) => {
    requestUrls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: "ok" };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "qwen", "--name", "Qwen", "--api-key", "sk-qwen-test", "--model", "qwen3.7-max", "--vision", "true", "--plan", "subscription"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const saved = tokenStore.getProvider("qwen");
  assert.equal(exitCode, 0);
  assert.equal(saved.endpoint_variant, "token_plan");
  assert.equal(saved.vision, true);
  assert.equal(requestUrls[0], "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.match(stdout.toString(), /Provider configurato con API key: qwen \(default model: qwen3\.7-max, vision: true, plan: subscription\)/);
});

test("provider:add supports anthropic-style API-key providers like opencode-go", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-opencode-go-"));
  const stdout = createWritableBuffer();
  const requestUrls = [];
  const requestBodies = [];
  const requestHeaders = [];
  const fetchFn = async (url, options = {}) => {
    requestUrls.push(url);
    requestBodies.push(JSON.parse(String(options.body || "{}")));
    requestHeaders.push(options.headers || {});
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: "msg_opencode_go" };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "opencode-go", "--name", "OpenCode Go", "--api-key", "sk-opencode-go-test", "--model", "minimax-m3", "--vision", "false"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const saved = tokenStore.getProvider("opencode-go");
  assert.equal(exitCode, 0);
  assert.equal(saved.provider, "opencode-go");
  assert.equal(saved.default_model, "minimax-m3");
  assert.equal(saved.vision, false);
  assert.equal(requestUrls[0], "https://opencode.ai/zen/go/v1/messages");
  assert.equal(requestBodies[0].model, "minimax-m3");
  assert.equal(requestHeaders[0]["x-api-key"], "sk-opencode-go-test");
  assert.match(stdout.toString(), /Provider configurato con API key: opencode-go \(default model: minimax-m3, vision: false\)/);
});

test("provider:key routes qwen token-plan keys to the token-plan endpoint", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-key-qwen-token-plan-"));
  const stdout = createWritableBuffer();
  const requestUrls = [];
  const fetchFn = async (url) => {
    requestUrls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: "ok" };
      },
    };
  };

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("qwen", {
    access_token: "sk-old-qwen",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "Qwen" });

  const exitCode = await runCli(["node", "llmproxy", "provider:key", "qwen", "--api-key", "sk-sp-token-plan"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const saved = tokenStore.getProvider("qwen");
  assert.equal(exitCode, 0);
  assert.equal(requestUrls[0], "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(saved.access_token, "sk-sp-token-plan");
  assert.equal(saved.endpoint_variant, "token_plan");
  assert.match(stdout.toString(), /API key aggiornata per provider qwen \(default model: qwen3\.7-max, plan: subscription\)/);
});

test("provider:add rejects invalid qwen plan values", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-qwen-invalid-plan-"));
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "qwen", "--api-key", "sk-qwen-test", "--model", "qwen3.7-max", "--vision", "false", "--plan", "enterprise"], {
    dataRoot: runtimeRoot,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /--plan subscription oppure --plan payg/);
});

test("provider:add requires --vision flag for api-key providers", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-missing-vision-"));
  const stderr = createWritableBuffer();
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return { id: "ok" }; } });

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "qwen", "--api-key", "sk-qwen-test", "--model", "qwen3.7-max"], {
    dataRoot: runtimeRoot,
    stderr,
    fetchFn,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /--vision <true\|false>/);
});

test("provider:add rejects invalid --vision values", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-bad-vision-"));
  const stderr = createWritableBuffer();
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return { id: "ok" }; } });

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "qwen", "--api-key", "sk-qwen-test", "--model", "qwen3.7-max", "--vision", "maybe"], {
    dataRoot: runtimeRoot,
    stderr,
    fetchFn,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /--vision deve essere 'true' oppure 'false'/);
});

test("provider:add rejects api-key providers when the default model probe fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-probe-fails-"));
  const stderr = createWritableBuffer();
  const fetchFn = async () => ({
    ok: false,
    status: 400,
    async text() {
      return "model_not_supported";
    },
  });

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "openrouter", "--api-key", "sk-or-test", "--model", "bad-model", "--vision", "false"], {
    dataRoot: runtimeRoot,
    stderr,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  assert.equal(exitCode, 1);
  assert.equal(tokenStore.getProvider("openrouter"), null);
  assert.match(stderr.toString(), /Test provider fallito/);
});

test("provider:add requires a default model for api-key providers", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-model-required-"));
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "openrouter", "--api-key", "sk-or-test"], {
    dataRoot: runtimeRoot,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /richiede --model/);
});

test("provider:key updates api key for an existing provider", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-key-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("openrouter", {
    access_token: "sk-old",
    token_type: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "openai/gpt-4o",
  }, { name: "OpenRouter" });
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return {}; } });

  const exitCode = await runCli(["node", "llmproxy", "provider:key", "openrouter", "--api-key", "sk-new"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const reloaded = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  assert.equal(exitCode, 0);
  assert.equal(reloaded.getProvider("openrouter").access_token, "sk-new");
  assert.match(stdout.toString(), /API key aggiornata/);
});

test("provider:order moves providers to the requested fallback position", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-order-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("primary", { access_token: "token-primary", token_type: "bearer", scope: "read:user" }, { name: "Primary" });
  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Backup" });

  const exitCode = await runCli(["node", "llmproxy", "provider:order", "backup", "1"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  const reloaded = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  assert.equal(exitCode, 0);
  assert.deepEqual(reloaded.listProviders().map((provider) => provider.id), ["backup", "primary"]);
  assert.match(stdout.toString(), /backup/);
});

test("provider:rename updates the provider display name", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-rename-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Old Name" });

  const exitCode = await runCli(["node", "llmproxy", "provider:rename", "backup", "New Backup Name"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  const reloaded = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  assert.equal(exitCode, 0);
  assert.equal(reloaded.getProvider("backup").name, "New Backup Name");
  assert.match(stdout.toString(), /New Backup Name/);
});

test("provider:status shows ordered providers and identifies the active one", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-status-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("primary", { access_token: "token-primary", token_type: "bearer", scope: "read:user" }, { name: "Primary" });
  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Backup" });
  tokenStore.saveProvider("qwen", {
    access_token: "token-qwen",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
    endpoint_variant: "token_plan",
  }, { name: "Qwen" });
  tokenStore.moveProvider("backup", 1);

  const exitCode = await runCli(["node", "llmproxy", "provider:status"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Active provider: backup/);
  assert.match(stdout.toString(), /1\. backup \(Backup\) \[active\]/);
  assert.match(stdout.toString(), /2\. primary \(Primary\)/);
  assert.match(stdout.toString(), /3\. qwen \(Qwen\).*plan=subscription/);
});

test("status shows configured fallback provider order", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-status-extended-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("primary", { access_token: "token-primary", token_type: "bearer", scope: "read:user" }, { name: "Primary" });
  tokenStore.saveProvider("backup", { access_token: "token-backup", token_type: "bearer", scope: "read:user" }, { name: "Backup" });
  tokenStore.moveProvider("backup", 1);

  const exitCode = await runCli(["node", "llmproxy", "status"], {
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    serviceManager: {
      kind: "launchd",
      status() {
        return { ok: true, active: true, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Fallback order: backup, primary/);
  assert.match(stdout.toString(), /Active provider: backup/);
});

test("logs prints structured request logs when service stdout and stderr are empty", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-logs-"));
  const logsDir = path.join(runtimeRoot, "logs");
  const stdout = createWritableBuffer();

  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "service.out.log"), "", "utf8");
  fs.writeFileSync(path.join(logsDir, "service.err.log"), "", "utf8");
  fs.writeFileSync(
    path.join(logsDir, "requests-2026-03-27.jsonl"),
    `${JSON.stringify({ event: "request_in", model: "glm-5" })}\n${JSON.stringify({ event: "provider_result", error: "model_not_supported" })}\n`,
    "utf8",
  );

  const exitCode = await runCli(["node", "llmproxy", "logs"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /request_in/);
  assert.match(stdout.toString(), /glm-5/);
  assert.match(stdout.toString(), /model_not_supported/);
});

test("service:start returns an error when the service manager install fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-start-fail-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "service:start"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    serviceManager: {
      kind: "launchd",
      install() {
        return {
          ok: false,
          stderr: "bootstrap failed",
          stdoutPath: "/tmp/service.out.log",
          stderrPath: "/tmp/service.err.log",
        };
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /bootstrap failed/);
});

test("service:restart on launchd reinstalls the agent directly", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-restart-fallback-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const calls = [];

  const exitCode = await runCli(["node", "llmproxy", "service:restart"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    serviceManager: {
      kind: "launchd",
      stop() {
        calls.push("stop");
        return { ok: true, stdout: "", stderr: "" };
      },
      start() {
        calls.push("start");
        return { ok: true, stdout: "", stderr: "" };
      },
      install() {
        calls.push("install");
        return {
          ok: true,
          stdout: "",
          stderr: "",
          stdoutPath: "/tmp/service.out.log",
          stderrPath: "/tmp/service.err.log",
        };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["install"]);
  assert.match(stdout.toString(), /Servizio riavviato/);
  assert.equal(stderr.toString(), "");
});

test("service:restart on launchd falls back to start when install is unavailable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-restart-launchd-direct-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const calls = [];

  const exitCode = await runCli(["node", "llmproxy", "service:restart"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    serviceManager: {
      kind: "launchd",
      stop() {
        calls.push("stop");
        return { ok: true, stdout: "", stderr: "" };
      },
      start() {
        calls.push("start");
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["start"]);
  assert.match(stdout.toString(), /Servizio riavviato/);
  assert.equal(stderr.toString(), "");
});

test("models:list prints a numbered list of available models", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-list-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "models:list"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /1\. /);
  assert.match(stdout.toString(), /claude-sonnet-4\.5|claude-opus-4\.5|gpt-5/);
});

test("models:list uses the live Copilot model catalog when authenticated", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-live-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-live", token_type: "bearer", scope: "read:user" });

  const fetchFn = async () => ({
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
  });

  const exitCode = await runCli(["node", "llmproxy", "models:list"], {
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /1\. gpt-4\.1/);
  assert.match(stdout.toString(), /2\. o3/);
});

test("test sends a fixed inference prompt to the local proxy and prints the assistant reply", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-command-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const requests = [];

  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.5",
          content: [{ type: "text", text: "ciao creatore" }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:5045/v1/llm/health");
  assert.equal(requests[1].url, "http://127.0.0.1:5045/v1/messages");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.headers["content-type"], "application/json");

  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.model, "claude-sonnet-4.5");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content[0].text, "Rispondi solo: llmproxy-test-auto");
  assert.match(stdout.toString(), /auto: ok \(claude-sonnet-4\.5\) ciao creatore/);
});

test("test uses a deterministic per-user port when no explicit PORT is configured", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-user-port-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-package-no-env-"));
  const stdout = createWritableBuffer();
  const requests = [];

  const fetchFn = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.5",
          content: [{ type: "text", text: "ok" }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    packageRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0], `http://127.0.0.1:${deriveUserScopedPort(runtimeRoot)}/v1/llm/health`);
  assert.equal(requests[1], `http://127.0.0.1:${deriveUserScopedPort(runtimeRoot)}/v1/messages`);
});

test("test uses the production service port 7045 when the installed CLI profile is active", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-production-port-"));
  const stdout = createWritableBuffer();
  const requests = [];

  const fetchFn = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.5",
          content: [{ type: "text", text: "ok" }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_HOME: "/Users/alessiobacin/Library/Application Support/llmProxy",
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0], "http://127.0.0.1:7045/v1/llm/health");
  assert.equal(requests[1], "http://127.0.0.1:7045/v1/messages");
});

test("different runtime roots resolve to different default proxy ports", async () => {
  const leftRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-port-left-"));
  const rightRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-port-right-"));

  assert.notEqual(deriveUserScopedPort(leftRuntimeRoot), deriveUserScopedPort(rightRuntimeRoot));
});

test("test probes only the active provider by default", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-providers-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("copilot", {
    access_token: "token-copilot",
    token_type: "bearer",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "gpt-5.4",
  }, { name: "Copilot" });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.5",
  }, { name: "Kimi" });

  const requestBodies = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    requestBodies.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: `ok ${body.provider}` }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requestBodies.filter((body) => body.model).map((body) => [body.provider, body.model]), [["copilot", "gpt-5.4"]]);
  assert.match(stdout.toString(), /copilot: ok \(gpt-5\.4\)/);
  assert.doesNotMatch(stdout.toString(), /kimi: ok \(kimi-k2\.5\)/);
});

test("test hides llmproxy metadata lines from the printed assistant reply", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-hide-metadata-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          content: [{
            type: "text",
            text: "llmproxy-test-qwen\n\n[llmproxy] provider: qwen | model: qwen3.7-max\n[llmproxy] tokens: req 256 (in 20, out 236) | provider today 256 week 256 | model today 256 week 256",
          }],
        };
      },
    }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /auto: ok \([^)]+\) llmproxy-test-qwen/);
  assert.doesNotMatch(stdout.toString(), /\[llmproxy\] provider:/);
  assert.doesNotMatch(stdout.toString(), /\[llmproxy\] tokens:/);
});

test("test retries once after a transient local fetch failure", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-retry-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("default", {
    access_token: "token-copilot",
    token_type: "bearer",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "gpt-5.4",
  }, { name: "Copilot" });

  let messageAttempts = 0;
  const sleepCalls = [];
  const fetchFn = async (url) => {
    if (String(url).includes("/v1/llm/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v8" };
        },
      };
    }
    messageAttempts += 1;
    if (messageAttempts === 1) throw new Error("fetch failed");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{ type: "text", text: "llmproxy-test-default" }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn,
    sleep(ms) {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(messageAttempts, 2);
  assert.deepEqual(sleepCalls, [250]);
  assert.match(stdout.toString(), /default: ok \(gpt-5\.4\) llmproxy-test-default/);
});

test("claude:setup accepts a model index from the numbered model list", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-select-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-runtime-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "claude:setup", "--model", "2"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    stdout,
  });

  const settingsFile = path.join(tempRoot, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.match(stdout.toString(), /Default model:/);
});

test("model:set updates the Claude project model with a raw provider-prefixed value", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-set-"));
  const claudeDir = path.join(tempRoot, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    permissions: {
      allow: ["Bash(node:*)"],
    },
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      ANTHROPIC_DEFAULT_MODEL: "copilot:gpt-5.4",
      KEEP_ME: "yes",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "model:set", "deepseek:deepseek-v4-flash"], {
    cwd: tempRoot,
    stdout,
    stderr,
  });

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.deepEqual(settings.permissions, { allow: ["Bash(node:*)"] });
  assert.equal(settings.model, "deepseek:deepseek-v4-flash");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_MODEL, "deepseek:deepseek-v4-flash");
  assert.equal(settings.env.KEEP_ME, "yes");
  assert.match(stdout.toString(), /Default model: deepseek:deepseek-v4-flash/);
});

test("model:set rewrites ANTHROPIC_BASE_URL to the production service port 7045 for installed CLI profile", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-set-production-"));
  const claudeDir = path.join(tempRoot, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const stdout = createWritableBuffer();

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:12345",
      ANTHROPIC_DEFAULT_MODEL: "copilot:gpt-5.4",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "model:set", "gpt-5.4"], {
    cwd: tempRoot,
    stdout,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_HOME: "/Users/alessiobacin/Library/Application Support/llmProxy",
      HOST: "127.0.0.1",
    },
  });

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:7045");
  assert.match(stdout.toString(), /http:\/\/127\.0\.0\.1:7045/);
});

test("model:set rejects an empty model value", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-set-missing-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "model:set"], {
    cwd: tempRoot,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Uso: llmproxy model:set <model>/);
});

test("claude:setup resolves model indexes from the live Copilot catalog", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-live-select-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-runtime-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "token-live", token_type: "bearer", scope: "read:user" });

  const fetchFn = async () => ({
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
  });

  const exitCode = await runCli(["node", "llmproxy", "claude:setup", "--model", "2"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn,
  });

  const settingsFile = path.join(tempRoot, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));

  assert.equal(exitCode, 0);
  assert.equal(settings.model, "llmProxy");
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.match(stdout.toString(), /Default model: o3/);
});

test("install:persistent-it installs the current package globally and starts the persistent macOS service in Italian", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-macos-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "darwin",
    stdout,
    stderr,
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/local/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.equal(commandCalls.length, 1);
  assert.equal(commandCalls[0].command, "sh");
  assert.equal(commandCalls[0].spawnOptions.encoding, "utf8");
  assert.match(commandCalls[0].args[1], /case "\$platform" in/);
  assert.match(commandCalls[0].args[1], /darwin\|linux\)/);
  assert.match(commandCalls[0].args[1], /npm install -g '\/tmp\/llmproxy-package'/);
  assert.match(commandCalls[0].args[1], /"\$global_bin" service:start/);
  assert.match(stdout.toString(), /Installazione persistente completata/);
  assert.match(stdout.toString(), /\/usr\/local\/bin\/llmproxy/);
});

test("install:persistent-en installs the current package globally and starts the persistent macOS service in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-macos-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "darwin",
    stdout,
    stderr,
    commandRunner() {
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/local/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Persistent installation completed/);
  assert.match(stdout.toString(), /Global binary: \/usr\/local\/bin\/llmproxy/);
  assert.match(stdout.toString(), /Persistent service enabled with launchd/);
});

test("install:persistent-it prints linger guidance on Linux", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-linux-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "linux",
    stdout,
    commandRunner() {
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /loginctl enable-linger/);
  assert.match(stdout.toString(), /loginctl enable-linger/);
});

test("install:persistent-en prints linger guidance on Linux in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-linux-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "linux",
    stdout,
    commandRunner() {
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Linux note:/);
  assert.match(stdout.toString(), /loginctl enable-linger/);
});

test("install:persistent-en best-effort enables linger during Linux bootstrap", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-linger-linux-"));
  const stdout = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "linux",
    stdout,
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(commandCalls[0].args[1], /linger_user=\$\{SUDO_USER:-\$USER\}/);
  assert.match(commandCalls[0].args[1], /sudo -n loginctl enable-linger "\$linger_user"/);
});

test("service:start returns an error when the service manager install fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-start-fail-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "service:start"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    serviceManager: {
      kind: "systemd",
      install() {
        return { ok: false, stderr: "Failed to connect to bus: No medium found\n" };
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Failed to connect to bus: No medium found/);
});

test("install:persistent-it fails fast on unsupported platforms", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-win-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "win32",
    stdout,
    stderr,
    commandRunner() {
      throw new Error("commandRunner should not be called");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Piattaforma non supportata/);
});

test("install:persistent-en fails fast on unsupported platforms in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-win-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "win32",
    stdout,
    stderr,
    commandRunner() {
      throw new Error("commandRunner should not be called");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Unsupported platform for persistent installation: win32/);
});

test("install remains an alias for install:persistent-en", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-alias-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "darwin",
    stdout,
    stderr,
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/local/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.equal(commandCalls.length, 1);
  assert.equal(commandCalls[0].command, "sh");
  assert.match(stdout.toString(), /Persistent installation completed/);
  assert.match(stdout.toString(), /Global binary: \/usr\/local\/bin\/llmproxy/);
  assert.match(stdout.toString(), /Persistent service enabled with launchd/);
});

test("install reports unsupported platform errors in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-english-win-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install"], {
    dataRoot: runtimeRoot,
    packageRoot: "/tmp/llmproxy-package",
    platform: "win32",
    stdout,
    stderr,
    commandRunner() {
      throw new Error("commandRunner should not be called");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Unsupported platform for persistent installation: win32/);
});

test("claude:setup rejects model names and requires a numeric index", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-model-name-rejected-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-runtime-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "claude:setup", "--model", "gpt-4.1"], {
    cwd: tempRoot,
    dataRoot: runtimeRoot,
    stdout,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Usa l'indice numerico di `llmproxy models:list`/);
});

test("version prints the current package version", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-version-"));
  const stdout = createWritableBuffer();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  const exitCode = await runCli(["node", "llmproxy", "version"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.toString(), `${pkg.version}\n`);
});

test("help prints a short description for each command", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /llmproxy install:persistent-it\s+installa globalmente la CLI corrente/i);
  assert.match(stdout.toString(), /llmproxy install:persistent-en\s+installs the current CLI globally/i);
  assert.match(stdout.toString(), /llmproxy test\s+esegue un test rapido di inferenza contro il proxy locale/i);
  assert.match(stdout.toString(), /llmproxy login\s+autentica GitHub Copilot/i);
  assert.match(stdout.toString(), /llmproxy stats\s+mostra statistiche aggregate di utilizzo per provider e modello/i);
  assert.match(stdout.toString(), /llmproxy provider:available\s+elenca i provider supportati dalla CLI/i);
  assert.match(stdout.toString(), /llmproxy update\s+scarica e installa l'ultima versione/i);
  assert.match(stdout.toString(), /llmproxy uninstall\s+rimuove l'installazione globale/i);
  assert.match(stdout.toString(), /llmproxy version\s+mostra la versione corrente/i);
  assert.match(stdout.toString(), /Problemi comuni:/);
});

test("test probes every configured provider with --all-providers", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-all-providers-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("copilot", {
    access_token: "token-copilot",
    token_type: "bearer",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "gpt-5.4",
  }, { name: "Copilot" });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.5",
  }, { name: "Kimi" });

  const requestBodies = [];
  const fetchFn = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    requestBodies.push(body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: `ok ${body.provider}` }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test", "--all-providers"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requestBodies.filter((body) => body.model).map((body) => [body.provider, body.model]), [["copilot", "gpt-5.4"], ["kimi", "kimi-k2.5"]]);
  assert.match(stdout.toString(), /copilot: ok \(gpt-5\.4\)/);
  assert.match(stdout.toString(), /kimi: ok \(kimi-k2\.5\)/);
});

test("stats prints provider and model token breakdown from local metering data", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-stats-"));
  const stdout = createWritableBuffer();
  const logsDir = path.join(runtimeRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "metering.jsonl"), [
    JSON.stringify({ timestamp: "2026-05-01T10:00:00Z", provider: "qwen", model_used: "qwen3.7-max", success: true, tokens_input: 100, tokens_output: 20 }),
    JSON.stringify({ timestamp: "2026-05-02T10:00:00Z", provider: "deepseek", model_used: "deepseek-v4-pro", success: true, tokens_input: 50, tokens_output: 10 }),
    JSON.stringify({ timestamp: "2026-05-03T10:00:00Z", provider: "qwen", model_used: "qwen3.7-max", success: false, tokens_input: 25, tokens_output: 0 }),
  ].join("\n") + "\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "stats"], {
    dataRoot: runtimeRoot,
    stdout,
    env: {
      LLMPROXY_METERING_SINK: "jsonl",
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Requests: 3 \| Success: 2 \| Errors: 1/);
  assert.match(stdout.toString(), /Tokens: total=205 in=175 out=30/);
  assert.match(stdout.toString(), /Providers:/);
  assert.match(stdout.toString(), /1\. qwen requests=2 total=145 in=125 out=20/);
  assert.match(stdout.toString(), /2\. deepseek requests=1 total=60 in=50 out=10/);
  assert.match(stdout.toString(), /Models:/);
  assert.match(stdout.toString(), /1\. qwen3\.7-max requests=2 total=145 in=125 out=20/);
  assert.match(stdout.toString(), /2\. deepseek-v4-pro requests=1 total=60 in=50 out=10/);
});

test("help stats prints detailed guidance", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-stats-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "stats"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /^llmproxy stats/m);
  assert.match(stdout.toString(), /breakdown per provider e modello/i);
});

test("package scripts expose install:persistent-it and install:persistent-en", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.equal(pkg.scripts["install:persistent-it"], "node bin/llmproxy.js install:persistent-it");
  assert.equal(pkg.scripts["install:persistent-en"], "node bin/llmproxy.js install:persistent-en");
});

test("package files include the Docker runtime assets for production service mode", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.ok(pkg.files.includes("Dockerfile"));
  assert.ok(pkg.files.includes("docker-compose.production.yml"));
});

test("help <command> prints detailed guidance for a specific command", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-command-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "claude:setup"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /llmproxy claude:setup \[--model <indice>\]/);
  assert.match(stdout.toString(), /Quando usarlo:/);
  assert.match(stdout.toString(), /Scrive \.claude\/settings\.json/);
  assert.match(stdout.toString(), /Esempio:/);
  assert.match(stdout.toString(), /llmproxy claude:setup --model 2/);
});

test("help model:set prints detailed guidance for the model switch command", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-model-set-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "model:set"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /^llmproxy model:set <model>/m);
  assert.match(stdout.toString(), /Aggiorna il modello Claude del progetto/);
  assert.match(stdout.toString(), /deepseek:deepseek-v4-flash/);
});

test("help covers release-notes and provider subcommands", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-provider-commands-"));
  const commands = [
    ["release-notes", /changelog/i],
    ["provider:add", /aggiunge un provider noto/i],
    ["provider:key", /API key/i],
    ["provider:available", /provider supportati dalla CLI/i],
    ["provider:list", /provider configurati/i],
    ["provider:status", /provider attivo/i],
    ["provider:order", /posizione di fallback desiderata/i],
    ["provider:rename", /rinomina un provider/i],
    ["provider:remove", /rimuove un provider/i],
  ];

  for (const [command, expectedPattern] of commands) {
    const stdout = createWritableBuffer();
    const exitCode = await runCli(["node", "llmproxy", "help", command], {
      dataRoot: runtimeRoot,
      stdout,
    });

    assert.equal(exitCode, 0, `help ${command} should succeed`);
    assert.match(stdout.toString(), expectedPattern, `help ${command} should mention its purpose`);
  }
});

test("help install prints English guidance for the English install command", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-install-english-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "install"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /^llmproxy install/m);
  assert.match(stdout.toString(), /Description: English alias for install:persistent/i);
  assert.match(stdout.toString(), /When to use: Use it when you want a shorter, English-first command/i);
  assert.match(stdout.toString(), /Example: llmproxy install/i);
});

test("help install:persistent-en prints English guidance", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-install-persistent-en-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /^llmproxy install:persistent-en/m);
  assert.match(stdout.toString(), /Description: Installs the current CLI globally/i);
  assert.match(stdout.toString(), /When to use: Use it when you want the explicit English install path/i);
});

test("help install:persistent-it prints Italian guidance", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-install-persistent-it-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /^llmproxy install:persistent-it/m);
  assert.match(stdout.toString(), /Descrizione: Installa globalmente la CLI corrente/i);
  assert.match(stdout.toString(), /Quando usarlo: Usalo come percorso esplicito in italiano/i);
});

test("--help is an alias for help", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-help-alias-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "--help"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Comandi principali:/);
});

test("--version is an alias for version", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-version-alias-"));
  const stdout = createWritableBuffer();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  const exitCode = await runCli(["node", "llmproxy", "--version"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.toString(), `${pkg.version}\n`);
});

test("update runs the package manager command for the latest llmproxy release", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-"));
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-prefix-"));
  const stdout = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    env: { ...process.env, LLMPROXY_ENV: "development" },
    commandRunner(command, args) {
      executed.push([command, args]);
      if (["gh", "git", "pnpm"].includes(command)) {
        return { status: 0, stdout: "ok\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "--version") {
        return { status: 0, stdout: "10.0.0\n", stderr: "" };
      }
      if (command === "npm" && args[0] === "prefix") {
        return { status: 0, stdout: `${npmPrefix}\n`, stderr: "" };
      }
      if (command === "sudo") {
        return { status: 0, stdout: "sudo 1.0\n", stderr: "" };
      }
      return { status: 0, stdout: "changed 69 packages in 3s\n__LLMPROXY_VERSION__=0.1.0\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(executed.slice(0, 3), [
    ["gh", ["--version"]],
    ["git", ["--version"]],
    ["npm", ["--version"]],
  ]);
  assert.ok(executed.some(([command, args]) => command === "npm" && args[0] === "prefix" && args[1] === "-g"));
  assert.equal(executed.at(-1)[0], "bash");
  assert.equal(executed.at(-1)[1][0], "-c");
  const scriptText = executed.at(-1)[1][1];
  assert.match(scriptText, /current_bin=\$\(command -v llmproxy 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /if \[ -n "\$installed_bin" \] && \[ "\$installed_bin" != "\$new_bin" \] && \[ "\$installed_bin" != "\$current_bin" \]; then/);
  assert.match(scriptText, /if \[ -n "\$current_bin" \] && \[ "\$current_bin" != "\$new_bin" \]; then/);
  assert.match(scriptText, /cat > "\$current_bin" <<EOF/);
  assert.match(scriptText, /exec "\$new_bin" "\$@"/);
  assert.match(stdout.toString(), /Aggiornamento completato/);
  assert.match(stdout.toString(), /Versione corrente: 0\.1\.0/);
});

test("update stops early and reports missing base prerequisites", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-preflight-missing-"));
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-prefix-missing-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    env: { ...process.env, LLMPROXY_ENV: "development" },
    commandRunner(command, args) {
      executed.push([command, args]);
      if (command === "gh") return { status: 1, stdout: "", stderr: "gh missing" };
      if (command === "git") return { status: 1, stdout: "", stderr: "git missing" };
      if (command === "pnpm") return { status: 1, stdout: "", stderr: "pnpm missing" };
      if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: `${npmPrefix}\n`, stderr: "" };
      if (command === "sudo") return { status: 0, stdout: "sudo 1.0\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /prerequisiti.*non sono soddisfatti/i);
  assert.match(stderr.toString(), /GitHub CLI \(`gh`\) non trovato/i);
  assert.match(stderr.toString(), /Git \(`git`\) non trovato/i);
  assert.doesNotMatch(stderr.toString(), /pnpm non trovato/i);
  assert.equal(executed.some(([command]) => command === "bash"), false);
});

test("update reports Docker prerequisites when the service runtime uses Docker", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-preflight-docker-"));
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-prefix-docker-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    env: { ...process.env, LLMPROXY_ENV: "production" },
    commandRunner(command, args) {
      executed.push([command, args]);
      if (["gh", "git", "pnpm"].includes(command)) return { status: 0, stdout: "ok\n", stderr: "" };
      if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: `${npmPrefix}\n`, stderr: "" };
      if (command === "docker") return { status: 1, stdout: "", stderr: "docker missing" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Docker non trovato nel PATH/i);
  assert.equal(executed.some(([command]) => command === "bash"), false);
});

test("runSelfUpdate resolves the refreshed llmproxy binary by matching the target version", () => {
  const executed = [];
  runSelfUpdate((command, args) => {
    executed.push([command, args]);
    return { status: 0, stdout: "", stderr: "" };
  });

  const scriptText = executed[0][1][1];
  assert.equal(typeof runSelfUpdate, "function");
  assert.match(scriptText, /current_bin=\$\(command -v llmproxy 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /used_sudo=0/);
  assert.match(scriptText, /target_version=\$\(node -p "require\('\.\/package\.json'\)\.version"\)/);
  assert.match(scriptText, /if sudo npm install -g "\$package_file" 2>\/dev\/null; then\n\s+used_sudo=1/);
  assert.match(scriptText, /if \[ "\$used_sudo" -eq 1 \]; then\n\s+npm_prefix=\$\(sudo npm prefix -g 2>\/dev\/null \|\| echo "\/usr\/local"\)\nelse\n\s+npm_prefix=\$\(npm prefix -g 2>\/dev\/null \|\| echo "\/usr\/local"\)\nfi/);
  assert.match(scriptText, /resolved_bins=\$\(which -a llmproxy 2>\/dev\/null \| awk '!seen\[\$0\]\+\+'\)/);
  assert.match(scriptText, /candidate_version=\$\(\"\$candidate_bin\" version 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /if \[ \"\$candidate_version\" = \"\$target_version\" \]; then\n      new_bin=\"\$candidate_bin\"/);
  assert.match(scriptText, /version_output=\$\(\"\$new_bin\" version\)\n\[ \"\$version_output\" = \"\$target_version\" \]/);
  assert.match(scriptText, /if \[ -n "\$current_bin" \] && \[ "\$current_bin" != "\$new_bin" \]; then/);
  assert.match(scriptText, /cat > "\$current_bin" <<EOF/);
  assert.match(scriptText, /sudo rm -f \"\$installed_bin\"/);
});

test("update keeps success when package install succeeds but service restart fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-restart-warning-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    commandRunner() {
      return {
        status: 0,
        stdout: [
          "changed 10 packages in 1s",
          "__LLMPROXY_VERSION__=0.2.60",
          "__LLMPROXY_RELEASE_NOTES_START__",
          "Changelog 0.2.60:",
          "- release 0.2.60",
          "__LLMPROXY_RELEASE_NOTES_END__",
          "__LLMPROXY_SERVICE_RESTART_WARNING__=Bootstrap failed: 5: Input/output error",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Aggiornamento completato/);
  assert.match(stdout.toString(), /Versione corrente: 0\.2\.60/);
  assert.match(stdout.toString(), /Bootstrap failed: 5: Input\/output error/);
  assert.equal(stderr.toString(), "");
});

test("update prints changelog notes for known versions", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-notes-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    commandRunner() {
      return { status: 0, stdout: "changed 82 packages in 2s\n__LLMPROXY_VERSION__=0.2.53\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.53:/);
  assert.match(stdout.toString(), /rebuild\+recreate/i);
});

test("update prints changelog notes for release 0.2.57", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-notes-0257-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    commandRunner() {
      return { status: 0, stdout: "changed 10 packages in 1s\n__LLMPROXY_VERSION__=0.2.57\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.57:/);
  assert.match(stdout.toString(), /profilo runtime esplicito/i);
});

test("release-notes prints changelog notes for release 0.2.58", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-release-notes-0258-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "release-notes", "--version", "0.2.58", "--locale", "it"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.58:/);
  assert.match(stdout.toString(), /binario appena installato/i);
});

test("release-notes formats notes from a commit message when provided", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-release-notes-commit-message-"));
  const stdout = createWritableBuffer();
  const commitMessageBase64 = Buffer.from("fix fallback chain\nensure update reads release notes from git commit\nkeep Docker rebuild in self-update\n", "utf8").toString("base64");

  const exitCode = await runCli(["node", "llmproxy", "release-notes", "--version", "0.2.60", "--locale", "it", "--commit-message-base64", commitMessageBase64], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.60:/);
  assert.match(stdout.toString(), /- fix fallback chain/);
  assert.match(stdout.toString(), /- ensure update reads release notes from git commit/);
  assert.match(stdout.toString(), /- keep Docker rebuild in self-update/);
  assert.doesNotMatch(stdout.toString(), /Note di rilascio non disponibili/);
});

test("release-notes reads embedded package notes when commit message is unavailable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-release-notes-embedded-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "release-notes", "--version", "0.2.60", "--locale", "it"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.60:/);
  assert.match(stdout.toString(), /- release 0\.2\.60/);
  assert.match(stdout.toString(), /- embed current release notes in the installed package for first-update compatibility/);
  assert.doesNotMatch(stdout.toString(), /Note di rilascio non disponibili/);
});

test("update prefers release notes emitted by the newly installed binary", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-notes-installed-binary-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    commandRunner() {
      return {
        status: 0,
        stdout: [
          "changed 10 packages in 1s",
          "__LLMPROXY_VERSION__=9.9.9",
          "__LLMPROXY_RELEASE_NOTES_START__",
          "Changelog 9.9.9:",
          "- release notes from installed package",
          "__LLMPROXY_RELEASE_NOTES_END__",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 9\.9\.9:/);
  assert.match(stdout.toString(), /release notes from installed package/);
  assert.doesNotMatch(stdout.toString(), /Note di rilascio non disponibili/);
});

test("update prints changelog in English when LLMPROXY_LOCALE=en", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-notes-en-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    env: { ...process.env, LLMPROXY_LOCALE: "en" },
    commandRunner() {
      return { status: 0, stdout: "changed 82 packages in 2s\n__LLMPROXY_VERSION__=0.2.54\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.54:/);
  assert.match(stdout.toString(), /Provider network: automatic retry/i);
});

test("update prints fallback changelog line when release notes are missing", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-notes-missing-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    env: { ...process.env, LLMPROXY_LOCALE: "it" },
    commandRunner() {
      return { status: 0, stdout: "changed 82 packages in 2s\n__LLMPROXY_VERSION__=9.9.9\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 9\.9\.9:/);
  assert.match(stdout.toString(), /Note di rilascio non disponibili/);
});

test("uninstall removes both npm and pnpm global installs", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-"));
  const stdout = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "uninstall"], {
    dataRoot: runtimeRoot,
    stdout,
    commandRunner(command, args) {
      executed.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(executed, [[
    "bash",
    [
      "-c",
      "set -e\nnpm uninstall -g llmproxy >/dev/null 2>&1 || true\npnpm remove -g llmproxy >/dev/null 2>&1 || true\npnpm_root=$(pnpm root -g 2>/dev/null || true)\nif [ -n \"$pnpm_root\" ]; then\n  pnpm_home=$(dirname \"$(dirname \"$pnpm_root\")\")\n  rm -f \"$pnpm_home/bin/llmproxy\" >/dev/null 2>&1 || true\nfi",
    ],
  ]]);
  assert.match(stdout.toString(), /Disinstallazione completata/);
});

test("smart:add salva configurazione classifier con provider, model e api-key", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-config-"));
  const stdout = createWritableBuffer();
  const { createSmartRouterStore } = require("../lib/smart-router-store");

  const exitCode = await runCli(["node", "llmproxy", "smart:add", "--provider", "openrouter", "--model", "deepseek-chat", "--api-key", "sk-or-classifier-key"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  const store = createSmartRouterStore({ filePath: path.join(runtimeRoot, "smart-router.json") });
  const config = store.getConfig();

  assert.equal(exitCode, 0);
  assert.equal(config.classifierProvider, "openrouter");
  assert.equal(config.classifierModel, "deepseek-chat");
  assert.equal(config.classifierApiKey, "sk-or-classifier-key");
  assert.equal(config.enabled, true);
  assert.match(stdout.toString(), /Smart router configurato/);
  assert.match(stdout.toString(), /openrouter/);
  assert.match(stdout.toString(), /deepseek-chat/);
  assert.doesNotMatch(stdout.toString(), /sk-or-classifier-key/);
});

test("smart:add richiede tutti e tre i flag obbligatori", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-config-missing-"));
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "smart:add", "--provider", "openrouter"], {
    dataRoot: runtimeRoot,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /--model/);
  assert.match(stderr.toString(), /--api-key/);
});

test("smart:add rifiuta provider non supportati", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-config-bad-provider-"));
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "smart:add", "--provider", "unknown-provider", "--model", "deepseek-chat", "--api-key", "sk-key"], {
    dataRoot: runtimeRoot,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /Provider non supportato/);
});

test("smart:add mostra la guida con --help", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-config-help-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "help", "smart:add"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /smart:add/);
});

test("smart:status mostra stato quando non configurato", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-status-empty-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "smart:status"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /non configurato/i);
  assert.match(stdout.toString(), /Enabled: no/i);
});

test("smart:status mostra stato con config attivo e API key mascherata", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-status-configured-"));
  const stdout = createWritableBuffer();
  const { createSmartRouterStore } = require("../lib/smart-router-store");

  const store = createSmartRouterStore({ filePath: path.join(runtimeRoot, "smart-router.json") });
  store.setConfig({
    classifierProvider: "openrouter",
    classifierModel: "deepseek-chat",
    classifierApiKey: "sk-or-secret-key-1234",
    enabled: true,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("copilot", {
    access_token: "token-copilot",
    token_type: "bearer",
    scope: "read:user",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "claude-sonnet-4",
  }, { name: "Copilot" });

  const exitCode = await runCli(["node", "llmproxy", "smart:status"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Enabled: yes/i);
  assert.match(stdout.toString(), /openrouter/);
  assert.match(stdout.toString(), /deepseek-chat/);
  assert.match(stdout.toString(), /sk-or-\*\*\*\*/);
  assert.doesNotMatch(stdout.toString(), /sk-or-secret-key-1234/);
});

test("smart:test mostra simulazione routing con scenari esempio", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-test-"));
  const stdout = createWritableBuffer();
  const { createSmartRouterStore } = require("../lib/smart-router-store");

  const store = createSmartRouterStore({ filePath: path.join(runtimeRoot, "smart-router.json") });
  store.setConfig({
    classifierProvider: "openrouter",
    classifierModel: "deepseek-chat",
    classifierApiKey: "sk-or-key",
    enabled: true,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("copilot", {
    access_token: "token-copilot",
    token_type: "bearer",
    scope: "read:user",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "claude-sonnet-4",
  }, { name: "Copilot" });

  const exitCode = await runCli(["node", "llmproxy", "smart:test"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /simple/i);
  assert.match(stdout.toString(), /complex/i);
});

test("smart:test avvisa quando smart router non e configurato", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-test-not-configured-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "smart:test"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /non configurato/i);
});

test("smart:refresh forza invalidamento cache availability", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-smart-refresh-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "smart:refresh"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /cache.*invalidata|refresh.*completato/i);
});
