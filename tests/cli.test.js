const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCli, resolveServiceEnvironment, resolveServiceEntryFile, resolveCliServiceManagerOptions, runSelfUpdate, runSelfUpdateWindows, buildPersistentInstallScript } = require("../lib/cli");
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
      LLMPROXY_MODE: "standalone",
      LLMPROXY_MONGODB_CONNECTION_STRING: "mongodb://user:pass@localhost:27017/llmproxy",
      DBLAYER_URL: "http://localhost:5001",
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
  assert.equal(serviceEnv.LLMPROXY_RUNTIME_PROFILE, "development");
  assert.equal(serviceEnv.LLMPROXY_MODE, "standalone");
  assert.equal(serviceEnv.LLMPROXY_SERVICE_RUNTIME, "native");
  assert.equal(serviceEnv.LLMPROXY_MONGODB_CONNECTION_STRING, "mongodb://user:pass@localhost:27017/llmproxy");
  assert.equal(serviceEnv.DBLAYER_URL, "http://localhost:5001");
  assert.equal(serviceEnv.EVENTBUS_URL, "http://localhost:5048");
  assert.equal(serviceEnv.LLMPROXY_LOG_RETENTION_DAYS, "7");
  assert.equal(serviceEnv.LLMPROXY_DOCKER_SERVICE, "llmproxy");
  assert.equal(serviceEnv.LLMPROXY_DOCKER_POLL_MS, "30000");
});

test("resolveServiceEntryFile uses native server entrypoint by default even in production", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "production" },
    packageRoot: "/tmp/node_modules/llmproxy",
    targetPlatform: "darwin",
  });

  assert.equal(entryFile, "/tmp/node_modules/llmproxy/server.js");
});

test("resolveServiceEntryFile uses native server entrypoint on Linux in production", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "production" },
    packageRoot: "/tmp/node_modules/llmproxy",
    targetPlatform: "linux",
  });

  assert.equal(entryFile, "/tmp/node_modules/llmproxy/server.js");
});

test("resolveServiceEntryFile uses Docker entrypoint only when explicitly set", () => {
  const entryFile = resolveServiceEntryFile({
    env: { LLMPROXY_ENV: "production", LLMPROXY_SERVICE_RUNTIME: "docker" },
    packageRoot: "/tmp/node_modules/llmproxy",
    targetPlatform: "darwin",
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

test("resolveCliServiceManagerOptions uses native server entrypoint for installed production runtime", () => {
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

  assert.equal(options.entryFile, "/tmp/node_modules/llmproxy/server.js");
  assert.equal(options.environment.PORT, "7045");
  assert.equal(options.environment.HOST, "127.0.0.1");
  assert.equal(options.environment.LLMPROXY_GLOBAL_SERVICE, "1");
});

test("resolveCliServiceManagerOptions uses native server entrypoint on Linux in production", () => {
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

  assert.equal(options.entryFile, "/tmp/node_modules/llmproxy/server.js");
  assert.equal(options.environment.PORT, "7045");
  assert.equal(options.environment.HOST, "127.0.0.1");
  assert.equal(options.environment.LLMPROXY_GLOBAL_SERVICE, "1");
  assert.equal("LLMPROXY_SHARED_PROVIDER_REGISTRY" in options.environment, false);
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
  assert.equal(settings.env.LLMPROXY_LLM_STATS_API_KEY, "");
  assert.equal(settings.env.LLMPROXY_SENDGRID_API_KEY, "");
  assert.equal(settings.env.LLMPROXY_SENDGRID_FROM_EMAIL, "");
  assert.equal(settings.env.LLMPROXY_SENDGRID_TO_EMAIL, "");
  assert.equal(settings.env.LLMPROXY_SENDGRID_TO_MESSAGE_TYPE, "service_unreachable,service_recovered,provider_error,auto_escalation,provider_credit_exhausted,service_update");
  assert.equal(settings.env.LLMPROXY_AUTO_ESCALATE, "1");
  assert.equal(settings.env.LLMPROXY_INFERENCE_INFO_INLINE, "1");
  assert.equal(settings.env.LLMPROXY_METERING_INLINE, "0");
  assert.equal(settings.env.LLMPROXY_PRICE_PERFORMANCE_ROUTING, "1");
  assert.equal(settings.env.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER, "power");
  assert.equal(settings.env.LLMPROXY_PROVIDER_CREDIT_INLINE, "1");
  assert.equal(settings.env.LLMPROXY_SHORT_ANSWER, "0");
  assert.match(stdout.toString(), /settings\.json/);
  assert.match(stdout.toString(), /Supporto globale Claude sincronizzato/);
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
  assert.match(stdout.toString(), /Supporto globale Claude sincronizzato/);
});

test("claude:setup loads HOST and PORT from the llmproxy package .env file", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-dotenv-project-"));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-dotenv-runtime-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-dotenv-package-"));
  const stdout = createWritableBuffer();

  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nHOST=127.0.0.1\n", "utf8");

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
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:5045");
  assert.equal("ANTHROPIC_DEFAULT_MODEL" in settings.env, false);
  assert.match(stdout.toString(), /http:\/\/127\.0\.0\.1:5045/);
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
    fetchFn: async () => ({ ok: false, status: 404, async json() { return {}; } }),
  });

  assert.equal(addExitCode, 0);
  assert.equal(listExitCode, 0);
  assert.match(stdout.toString(), /Login completato/);
  assert.match(listStdout.toString(), /1\. backup \(Backup Copilot\)/);
});

test("provider:list shows the effective project fallback chain when Claude settings override the model routing", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-list-project-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-list-project-workspace-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("default", {
    access_token: "token-copilot",
    token_type: "bearer",
    scope: "read:user",
    provider: "copilot",
    auth_type: "oauth",
    default_model: "gpt-5.4",
  }, { name: "Default Copilot" });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    scope: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.5",
  }, { name: "Kimi" });
  tokenStore.saveProvider("qwen", {
    access_token: "token-qwen",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "Qwen" });

  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:5045",
      ANTHROPIC_DEFAULT_MODEL: "copilot:gpt-5.4,kimi:kimi-k2.5",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "provider:list"], {
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn: async () => ({ ok: false, status: 404, async json() { return {}; } }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Provider effettivi per il progetto/);
  assert.match(stdout.toString(), /1\. default \(Default Copilot\)\n\s+model=gpt-5\.4 coding=n\/a/);
  assert.match(stdout.toString(), /2\. kimi \(Kimi\)\n\s+model=kimi-k2\.5 coding=n\/a/);
  assert.match(stdout.toString(), /3\. qwen \(Qwen\)\n\s+model=qwen3\.7-max coding=n\/a/);
});

test("provider:list keeps provider default models when the project sets a global override model", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-list-global-model-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-list-global-model-workspace-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

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
  tokenStore.saveProvider("commandcode", {
    access_token: "token-commandcode",
    token_type: "api_key",
    scope: "api_key",
    provider: "commandcode",
    auth_type: "api_key",
    default_model: "Qwen/Qwen3.7-Max",
  }, { name: "Command Code" });

  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      ANTHROPIC_DEFAULT_MODEL: "gpt-5.4",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "provider:list"], {
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn: async () => ({ ok: false, status: 404, async json() { return {}; } }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /1\. deepseek \(DeepSeek\)\n\s+model=deepseek-v4-pro coding=n\/a/);
  assert.match(stdout.toString(), /2\. openrouter \(OpenRouter\)\n\s+model=minimax\/minimax-m3 coding=n\/a/);
  assert.match(stdout.toString(), /3\. commandcode \(Command Code\)\n\s+model=Qwen\/Qwen3\.7-Max coding=n\/a/);
  assert.doesNotMatch(stdout.toString(), /model=gpt-5\.4/);
});

test("provider:list shows residual credit plus current and best provider pricing", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-list-credit-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });

  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    scope: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    scope: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.7-code",
  }, { name: "Kimi" });
  tokenStore.saveProvider("openrouter", {
    access_token: "token-openrouter",
    token_type: "api_key",
    scope: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "minimax/minimax-m3",
  }, { name: "OpenRouter" });
  tokenStore.saveProvider("qwen", {
    access_token: "token-qwen",
    token_type: "api_key",
    scope: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-plus",
  }, { name: "Qwen" });

  const fetchFn = async (url) => {
    const target = String(url);
    if (target === "https://api.deepseek.com/user/balance") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            is_available: true,
            balance_infos: [{ currency: "USD", total_balance: "12.34" }],
          };
        },
      };
    }
    if (target === "https://api.moonshot.ai/v1/users/me/balance") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: true,
            data: { available_balance: 49.58894 },
          };
        },
      };
    }
    if (target === "https://openrouter.ai/api/v1/credits") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: { total_credits: 100.5, total_usage: 25.75 },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/deepseek-v4-pro/benchmarks") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              sources: [{ scores: [{ metric: "coding_index", value: 59.4 }] }],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/kimi-k2.7-code/benchmarks") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              sources: [{ scores: [{ metric: "coding_index", value: 48.8 }] }],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/minimax%2Fminimax-m3/benchmarks"
      || target === "https://ai.cloudprice.net/api/v1/models/minimax-m3/benchmarks") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              sources: [{ scores: [{ metric: "coding_index", value: 37.3 }] }],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/qwen3.7-plus/benchmarks") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              sources: [{ scores: [{ metric: "coding_index", value: 52.1 }] }],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/deepseek-v4-pro/pricing/calculate?tier=standard&input_tokens=1000000&output_tokens=1000000") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              result: {
                total_cost: 1.305,
                breakdown: [
                  { dimension: "input", unit_price: 0.435 },
                  { dimension: "output", unit_price: 0.87 },
                ],
                providers: [
                  { provider_id: "deepseek" },
                  { provider_id: "openrouter" },
                  { provider_id: "vercel_ai_gateway" },
                ],
              },
              options: [
                { provider_id: "deepseek", tier: "standard", total_cost: 1.305, breakdown: [{ dimension: "input", unit_price: 0.435 }, { dimension: "output", unit_price: 0.87 }] },
                { provider_id: "openrouter", tier: "standard", total_cost: 1.305, breakdown: [{ dimension: "input", unit_price: 0.435 }, { dimension: "output", unit_price: 0.87 }] },
              ],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/kimi-k2.7-code/pricing/calculate?tier=standard&input_tokens=1000000&output_tokens=1000000") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              result: {
                total_cost: 4.24,
                breakdown: [
                  { dimension: "input", unit_price: 0.74 },
                  { dimension: "output", unit_price: 3.5 },
                ],
                providers: [{ provider_id: "openrouter" }],
              },
              options: [
                { provider_id: "openrouter", tier: "standard", total_cost: 4.24, breakdown: [{ dimension: "input", unit_price: 0.74 }, { dimension: "output", unit_price: 3.5 }] },
              ],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/minimax%2Fminimax-m3/pricing/calculate?tier=standard&input_tokens=1000000&output_tokens=1000000"
      || target === "https://ai.cloudprice.net/api/v1/models/minimax-m3/pricing/calculate?tier=standard&input_tokens=1000000&output_tokens=1000000") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              result: {
                total_cost: 1.5,
                breakdown: [
                  { dimension: "input", unit_price: 0.3 },
                  { dimension: "output", unit_price: 1.2 },
                ],
                providers: [
                  { provider_id: "fireworks_ai" },
                  { provider_id: "huggingface" },
                  { provider_id: "minimax" },
                  { provider_id: "openrouter" },
                ],
              },
              options: [
                { provider_id: "openrouter", tier: "standard", total_cost: 1.5, breakdown: [{ dimension: "input", unit_price: 0.3 }, { dimension: "output", unit_price: 1.2 }] },
              ],
            },
          };
        },
      };
    }
    if (target === "https://ai.cloudprice.net/api/v1/models/qwen3.7-plus/pricing/calculate?tier=standard&input_tokens=1000000&output_tokens=1000000") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              result: {
                total_cost: 1.6,
                breakdown: [
                  { dimension: "input", unit_price: 0.32 },
                  { dimension: "output", unit_price: 1.28 },
                ],
                providers: [{ provider_id: "openrouter" }],
              },
              options: [
                { provider_id: "alibaba_qwen", tier: "standard", total_cost: 2.0, breakdown: [{ dimension: "input", unit_price: 0.4 }, { dimension: "output", unit_price: 1.6 }] },
                { provider_id: "openrouter", tier: "standard", total_cost: 1.6, breakdown: [{ dimension: "input", unit_price: 0.32 }, { dimension: "output", unit_price: 1.28 }] },
              ],
            },
          };
        },
      };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const exitCode = await runCli(["node", "llmproxy", "provider:list"], {
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /1\. deepseek \(DeepSeek\)\n\s+model=deepseek-v4-pro coding=59\.4\n\s+credit=USD 12\.34\n\s+price=in=USD 0\.43\/1M out=USD 0\.87\/1M\n\s+best=openrouter/);
  assert.match(stdout.toString(), /2\. kimi \(Kimi\)\n\s+model=kimi-k2\.7-code coding=48\.8\n\s+credit=49\.59\n\s+price=n\/a\n\s+best=openrouter/);
  assert.match(stdout.toString(), /3\. openrouter \(OpenRouter\)\n\s+model=minimax\/minimax-m3 coding=37\.3\n\s+credit=74\.75 credits\n\s+price=in=USD 0\.30\/1M out=USD 1\.20\/1M\n\s+best=fireworks/);
  assert.match(stdout.toString(), /4\. qwen \(Qwen\)\n\s+model=qwen3\.7-plus coding=52\.1\n\s+credit=n\/a\n\s+price=in=USD 0\.40\/1M out=USD 1\.60\/1M\n\s+best=openrouter/);
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
  assert.match(stdout.toString(), /nvidia \(NVIDIA\) auth=api_key/);
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
  assert.equal(provider.free_model, false);
  assert.match(stdout.toString(), /Provider configurato con API key/);
});

test("provider:add supports api-key providers like nvidia", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-nvidia-"));
  const stdout = createWritableBuffer();
  const requestUrls = [];
  const fetchFn = async (url) => {
    requestUrls.push(url);
    return { ok: true, status: 200, async json() { return {}; } };
  };

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "nvidia", "--name", "NVIDIA", "--api-key", "nvapi-test", "--model", "z-ai/glm-5.2", "--vision", "false"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const provider = tokenStore.getProvider("nvidia");

  assert.equal(exitCode, 0);
  assert.deepEqual(requestUrls, ["https://integrate.api.nvidia.com/v1/chat/completions"]);
  assert.ok(provider);
  assert.equal(provider.access_token, "nvapi-test");
  assert.equal(provider.auth_type, "api_key");
  assert.equal(provider.provider, "nvidia");
  assert.equal(provider.default_model, "z-ai/glm-5.2");
  assert.match(stdout.toString(), /Provider configurato con API key/);
});

test("provider:list loads legacy nvidia api-key entries saved without access_token", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-list-nvidia-legacy-"));
  const stdout = createWritableBuffer();
  const tokenFile = path.join(runtimeRoot, "copilot-token.json");

  fs.writeFileSync(tokenFile, JSON.stringify({
    version: 2,
    providers: [
      {
        id: "nvidia",
        name: "NVIDIA",
        provider: "nvidia",
        auth_type: "api_key",
        api_key: "nvapi-legacy",
        default_model: "z-ai/glm-5.2",
      },
    ],
    order: ["nvidia"],
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "provider:list"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return {}; } }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /nvidia/i);
  assert.match(stdout.toString(), /1\. nvidia \(NVIDIA\)/);
  assert.match(stdout.toString(), /model=z-ai\/glm-5\.2/);
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
  assert.match(stdout.toString(), /Provider configurato con API key: qwen \(default model: qwen3\.7-max, vision: false, free: false, plan: payg\)/);
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
  assert.match(stdout.toString(), /Provider configurato con API key: qwen \(default model: qwen3\.7-max, vision: true, free: false, plan: subscription\)/);
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
  assert.match(stdout.toString(), /Provider configurato con API key: opencode-go \(default model: minimax-m3, vision: false, free: false\)/);
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
  assert.match(stdout.toString(), /API key aggiornata per provider qwen \(default model: qwen3\.7-max(?:, free: false)?, plan: subscription\)/);
});

test("provider:add stores free_model when requested", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-add-free-model-"));
  const stdout = createWritableBuffer();
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return {}; } });

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "opencode", "--api-key", "sk-zen-test", "--model", "deepseek-v4-flash-free", "--vision", "false", "--free-model"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const provider = tokenStore.getProvider("opencode");

  assert.equal(exitCode, 0);
  assert.equal(provider.free_model, true);
  assert.match(stdout.toString(), /free: true/);
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

test("provider:test treats NVIDIA HTTP 429 as a reachable provider", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-test-nvidia-429-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("nvidia-glm-5.2", {
    access_token: "nvapi-test",
    token_type: "api_key",
    scope: "api_key",
    provider: "nvidia",
    auth_type: "api_key",
    default_model: "z-ai/glm-5.2",
    vision: false,
  }, { name: "NVIDIA" });

  const exitCode = await runCli(["node", "llmproxy", "provider:test"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn: async () => ({ ok: false, status: 429, async text() { return "rate limit"; } }),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /NVIDIA \(z-ai\/glm-5\.2\)/i);
  assert.match(stdout.toString(), /PASS - Visione correttamente disabilitata \(errore HTTP 429\)/i);
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

test("service:start verifies Docker runtime and proxy health on production installs", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-start-docker-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-start-docker-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];
  const composeSpawnOptions = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "service:start"], {
    dataRoot: runtimeRoot,
    packageRoot,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_DOCKER_COMPOSE_FILE: composeFile,
      LLMPROXY_SERVICE_RUNTIME: "docker",
    },
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
    commandRunner(command, args, spawnOptions) {
      commandCalls.push([command, ...args]);
      if ((command === "docker" && args[0] === "compose") || command === "docker-compose") {
        composeSpawnOptions.push(spawnOptions);
      }
      const joined = args.join(" ");
      if (joined.includes("ps --status running --services llmproxy")) {
        const wasStarted = commandCalls.some((call) => call.join(" ").includes("up -d --build llmproxy"));
        return { status: 0, stdout: wasStarted ? "llmproxy\n" : "", stderr: "" };
      }
      if (joined.includes("up -d --build llmproxy")) {
        return { status: 0, stdout: "started", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    serviceManager: {
      kind: "launchd",
      install() {
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
  assert.match(stdout.toString(), /Servizio installato con launchd/);
  assert.match(stdout.toString(), /Runtime Docker: container ricreato/);
  assert.match(stdout.toString(), /Health check OK/);
  assert.equal(stderr.toString(), "");
  assert.equal(composeSpawnOptions.some((entry) => entry?.env?.LLMPROXY_HOME === runtimeRoot), true);
});

test("service:start falls back to legacy docker-compose when the plugin is unavailable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-start-legacy-compose-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-start-legacy-compose-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];
  const composeSpawnOptions = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "service:start"], {
    dataRoot: runtimeRoot,
    packageRoot,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_DOCKER_COMPOSE_FILE: composeFile,
      LLMPROXY_SERVICE_RUNTIME: "docker",
    },
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
    commandRunner(command, args, spawnOptions) {
      commandCalls.push([command, ...args]);
      if ((command === "docker" && args[0] === "compose") || command === "docker-compose") {
        composeSpawnOptions.push(spawnOptions);
      }
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 1, stdout: "", stderr: "unknown command\n" };
      }
      if (command === "docker-compose" && args[0] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      const joined = args.join(" ");
      if (command === "docker-compose" && joined.includes("ps --status running --services llmproxy")) {
        const wasStarted = commandCalls.some((call) => call.join(" ").includes("up -d --build llmproxy"));
        return { status: 0, stdout: wasStarted ? "llmproxy\n" : "", stderr: "" };
      }
      if (command === "docker-compose" && joined.includes("up -d --build llmproxy")) {
        return { status: 0, stdout: "started", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    serviceManager: {
      kind: "launchd",
      install() {
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
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Runtime Docker: container ricreato/);
  assert.equal(commandCalls.some((call) => call[0] === "docker-compose" && call[1] === "version"), true);
  assert.equal(composeSpawnOptions.some((entry) => entry?.env?.LLMPROXY_HOME === runtimeRoot), true);
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
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
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
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
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

test("service:restart on windows reinstalls the service directly", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-restart-windows-direct-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const calls = [];

  const exitCode = await runCli(["node", "llmproxy", "service:restart"], {
    dataRoot: runtimeRoot,
    platform: "win32",
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
    serviceManager: {
      kind: "windows",
      stop() {
        calls.push("stop");
        return { ok: true, stdout: "", stderr: "" };
      },
      install() {
        calls.push("install");
        return {
          ok: true,
          stdout: "",
          stderr: "",
          stdoutPath: path.join(runtimeRoot, "service.out.log"),
          stderrPath: path.join(runtimeRoot, "service.err.log"),
        };
      },
      start() {
        calls.push("start");
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["install"]);
  assert.match(stdout.toString(), /Servizio riavviato/);
  assert.equal(stderr.toString(), "");
});

test("service:restart recovers the Docker runtime when the managed container is not running", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-restart-docker-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-restart-docker-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "service:restart"], {
    dataRoot: runtimeRoot,
    packageRoot,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_DOCKER_COMPOSE_FILE: composeFile,
      LLMPROXY_SERVICE_RUNTIME: "docker",
    },
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
    commandRunner(command, args) {
      commandCalls.push([command, ...args]);
      const joined = args.join(" ");
      if (joined.includes("ps --status running --services llmproxy")) {
        const wasRestarted = commandCalls.some((call) => call.join(" ").includes("up -d --build llmproxy"));
        return { status: 0, stdout: wasRestarted ? "llmproxy\n" : "", stderr: "" };
      }
      if (joined.includes("up -d --build llmproxy")) {
        return { status: 0, stdout: "started", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    serviceManager: {
      kind: "launchd",
      install() {
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Runtime Docker: container ricreato/);
  assert.match(stdout.toString(), /Health check OK/);
  assert.equal(stderr.toString(), "");
});

test("service:runtime docker removes native artifacts and starts the docker runtime", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-runtime-docker-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-runtime-docker-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-runtime-docker-home-"));
  const launchAgentFile = path.join(homeDir, "Library", "LaunchAgents", "com.llmproxy.service.plist");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");
  fs.mkdirSync(path.dirname(launchAgentFile), { recursive: true });
  fs.writeFileSync(launchAgentFile, "<plist></plist>", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "service:runtime", "docker"], {
    dataRoot: runtimeRoot,
    packageRoot,
    homeDir,
    platform: "darwin",
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_DOCKER_COMPOSE_FILE: composeFile,
      LLMPROXY_DOCKER_SERVICE: "llmproxy",
      LLMPROXY_SERVICE_RUNTIME: "native",
    },
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
    commandRunner(command, args) {
      commandCalls.push([command, ...args]);
      const joined = args.join(" ");
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (joined.includes("ps --status running --services llmproxy")) {
        const wasStarted = commandCalls.some((call) => call.join(" ").includes("up -d --build llmproxy"));
        return { status: 0, stdout: wasStarted ? "llmproxy\n" : "", stderr: "" };
      }
      if (joined.includes("down --remove-orphans")) {
        return { status: 0, stdout: "removed", stderr: "" };
      }
      if (joined.includes("up -d --build llmproxy")) {
        return { status: 0, stdout: "started", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(launchAgentFile), false);
  assert.match(stdout.toString(), /Runtime attivo: docker/);
  assert.match(stdout.toString(), /Health check OK/);
  assert.equal(stderr.toString(), "");
});

test("service:runtime native stops the docker runtime and installs the native service", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-runtime-native-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-service-runtime-native-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];
  let installCalled = false;

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "service:runtime", "launchd"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "darwin",
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_DOCKER_COMPOSE_FILE: composeFile,
      LLMPROXY_DOCKER_SERVICE: "llmproxy",
      LLMPROXY_SERVICE_RUNTIME: "docker",
    },
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, async json() { return { ok: true }; } }),
    commandRunner(command, args) {
      commandCalls.push([command, ...args]);
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (args.join(" ").includes("down --remove-orphans")) {
        return { status: 0, stdout: "removed", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    serviceManager: {
      kind: "launchd",
      install() {
        installCalled = true;
        return { ok: true, stdout: "", stderr: "", stdoutPath: "/tmp/service.out.log", stderrPath: "/tmp/service.err.log" };
      },
      stop() {
        return { ok: true, stdout: "", stderr: "" };
      },
      start() {
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(installCalled, true);
  assert.equal(commandCalls.some((call) => call.join(" ").includes("down --remove-orphans")), true);
  assert.match(stdout.toString(), /Runtime attivo: native/);
  assert.match(stdout.toString(), /Health check OK/);
  assert.equal(stderr.toString(), "");
});

test("status reports Docker runtime activity when the service runtime is docker", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-status-docker-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-status-docker-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "status"], {
    dataRoot: runtimeRoot,
    packageRoot,
    env: {
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_DOCKER_COMPOSE_FILE: composeFile,
      LLMPROXY_DOCKER_SERVICE: "llmproxy",
      LLMPROXY_SERVICE_RUNTIME: "docker",
    },
    stdout,
    stderr,
    commandRunner(command, args) {
      const joined = args.join(" ");
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (joined.includes("ps --status running --services llmproxy")) {
        return { status: 0, stdout: "llmproxy\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    serviceManager: {
      kind: "launchd",
      status() {
        return { ok: false, active: false, stdout: "", stderr: "launchd inactive" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Service manager: docker/);
  assert.match(stdout.toString(), /Service active: yes/);
  assert.match(stdout.toString(), /llmproxy container active via docker compose/);
  assert.equal(stderr.toString(), "");
});

test("windows status reports inactive cleanly when the service is not installed", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-status-windows-missing-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "status"], {
    dataRoot: runtimeRoot,
    platform: "win32",
    stdout,
    stderr,
    serviceManager: {
      kind: "windows",
      status() {
        return { ok: true, active: false, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Service manager: windows/);
  assert.match(stdout.toString(), /Service active: no/);
  assert.equal(stderr.toString(), "");
});

test("runCli uses the REST wrapper when the local service is reachable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-rest-wrapper-"));
  const stdout = createWritableBuffer();
  const requests = [];

  const exitCode = await runCli(["node", "llmproxy", "provider:list"], {
    dataRoot: runtimeRoot,
    stdout,
    restFetchFn: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/health")) {
        return { ok: true, async json() { return { ok: true }; } };
      }
      return {
        ok: true,
        async json() {
          return {
            success: true,
            exitCode: 0,
            data: {
              output: "1. rest (REST Provider) model=gpt-5.4",
              error: "",
            },
          };
        },
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests, [
    "http://127.0.0.1:5045/health",
    "http://127.0.0.1:5045/api/providers",
  ]);
  assert.match(stdout.toString(), /REST Provider/);
});

test("update bypasses the REST wrapper even when the local service is reachable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-rest-bypass-"));
  const stdout = createWritableBuffer();
  const requests = [];
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    restFetchFn: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/health")) {
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`unexpected REST call: ${url}`);
    },
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner(command, args) {
      commandCalls.push([command, args]);
      if (command === "git") return { status: 0, stdout: "git version 2.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: "/tmp/npm-prefix\n", stderr: "" };
      if (command === "sudo") return { status: 0, stdout: "sudo 1.0\n", stderr: "" };
      return {
        status: 0,
        stdout: "changed 1 package\n__LLMPROXY_VERSION__=0.3.07\n__LLMPROXY_RELEASE_NOTES_START__\nChangelog 0.3.07:\n- release 0.3.07\n__LLMPROXY_RELEASE_NOTES_END__\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests, []);
  assert.equal(commandCalls.some(([command]) => command === "bash"), true);
  assert.match(stdout.toString(), /Versione corrente: 0\.3\.07/);
});

test("version bypasses the REST wrapper even when the local service is reachable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-version-rest-bypass-"));
  const stdout = createWritableBuffer();
  const requests = [];

  const exitCode = await runCli(["node", "llmproxy", "version"], {
    dataRoot: runtimeRoot,
    stdout,
    restFetchFn: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/health")) {
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`unexpected REST call: ${url}`);
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requests, []);
  assert.equal(stdout.toString().trim(), require("../package.json").version);
});

test("config commands bypass the REST wrapper even when the local service is reachable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-rest-bypass-"));
  const runtimeRoot = path.join(root, "runtime");
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "workspace");
  const requests = [];

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  const setStdout = createWritableBuffer();
  let exitCode = await runCli(["node", "llmproxy", "config:set", "LLMPROXY_LLM_STATS_API_KEY", "sk-global-demo", "--scope", "global"], {
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    stdout: setStdout,
    env: { ...process.env, HOME: homeDir },
    restFetchFn: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/health")) {
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`unexpected REST call: ${url}`);
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(requests, []);
  assert.match(setStdout.toString(), /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);

  const globalSettings = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"));
  assert.equal(globalSettings.env.LLMPROXY_LLM_STATS_API_KEY, "sk-global-demo");

  const getStdout = createWritableBuffer();
  exitCode = await runCli(["node", "llmproxy", "config:get", "LLMPROXY_LLM_STATS_API_KEY", "--scope", "global"], {
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    stdout: getStdout,
    env: { ...process.env, HOME: homeDir },
    restFetchFn: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith("/health")) {
        return { ok: true, async json() { return { ok: true }; } };
      }
      throw new Error(`unexpected REST call: ${url}`);
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(requests, []);
  assert.match(getStdout.toString(), /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);
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
  const projectRoot = path.join(runtimeRoot, "workspace");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const requests = [];
  const { createTokenStore } = require("../lib/token-store");
  const tokenStore = createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("auto", { access_token: "token-auto", token_type: "bearer", scope: "read:user", provider: "copilot", default_model: "claude-sonnet-4.5" }, { name: "auto" });
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:5045",
      LLMPROXY_LLM_STATS_API_KEY: "sk-test",
    },
  }, null, 2));

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
    cwd: projectRoot,
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
  assert.match(stdout.toString(), /auto: ok \(claude-sonnet-4\.5\)/);
  assert.doesNotMatch(stdout.toString(), /ciao creatore/);
});

test("test accepts a project-scoped LLMPROXY_LLM_STATS_API_KEY even when Claude proxy markers are absent", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-project-stats-key-"));
  const projectRoot = path.join(runtimeRoot, "workspace");
  const homeDir = path.join(runtimeRoot, "home");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const requests = [];
  const { createTokenStore } = require("../lib/token-store");
  const tokenStore = createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("auto", { access_token: "token-auto", token_type: "bearer", scope: "read:user", provider: "copilot", default_model: "claude-sonnet-4.5" }, { name: "auto" });
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    env: {
      LLMPROXY_LLM_STATS_API_KEY: "sk-project-only",
    },
  }, null, 2));
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({ env: {} }, null, 2));

  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/v1/llm/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v11" };
        },
      };
    }
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
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    env: { ...process.env, HOME: homeDir },
    stdout,
    stderr,
    fetchFn,
    tokenStore,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:5045/v1/llm/health");
  assert.equal(requests[1].url, "http://127.0.0.1:5045/v1/messages");
  assert.match(stdout.toString(), /auto: ok \(claude-sonnet-4\.5\)/);
});

test("test fails when LLMPROXY_LLM_STATS_API_KEY is missing from both project and global Claude settings", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-missing-stats-key-"));
  const projectRoot = path.join(runtimeRoot, "workspace");
  const homeDir = path.join(runtimeRoot, "home");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const requests = [];
  const { createTokenStore } = require("../lib/token-store");
  const tokenStore = createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("nvidia", { api_key: "nvapi-test", provider: "nvidia", default_model: "minimaxai/minimax-m3", vision: true }, { name: "NVIDIA MiniMax M3" });
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
    },
    model: "llmProxy",
  }, null, 2));
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    env: {},
  }, null, 2));

  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, manifest_version: "v11" };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    env: { ...process.env, HOME: homeDir, LLMPROXY_RUNTIME_PROFILE: "production" },
    stdout,
    stderr,
    fetchFn,
  });

  assert.equal(exitCode, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:7045/v1/llm/health");
  assert.match(stdout.toString(), /Proxy stato: OK/i);
  assert.match(stderr.toString(), /LLMPROXY_LLM_STATS_API_KEY is mandatory/i);
});

test("test uses a deterministic per-user port when no explicit PORT is configured", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-user-port-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-package-no-env-"));
  const stdout = createWritableBuffer();
  const requests = [];
  const { createTokenStore } = require("../lib/token-store");
  const tokenStore = createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("auto", { access_token: "token-auto", token_type: "bearer", scope: "read:user", provider: "copilot", default_model: "claude-sonnet-4.5" }, { name: "auto" });

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
  const { createTokenStore } = require("../lib/token-store");
  const tokenStore = createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("auto", { access_token: "token-auto", token_type: "bearer", scope: "read:user", provider: "copilot", default_model: "claude-sonnet-4.5" }, { name: "auto" });

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

test("development runtime uses the fixed local proxy port 5045", async () => {
  const leftRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-port-left-"));
  const rightRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-port-right-"));

  assert.equal(deriveUserScopedPort(leftRuntimeRoot), "5045");
  assert.equal(deriveUserScopedPort(rightRuntimeRoot), "5045");
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

test("test prints provider HTTP error details when the quick inference probe fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-http-error-detail-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("nvidia", {
    access_token: "nvapi-test",
    token_type: "api_key",
    scope: "api_key",
    provider: "nvidia",
    auth_type: "api_key",
    default_model: "minimaxai/minimax-m3",
    vision: true,
  }, { name: "NVIDIA MiniMax M3" });

  const fetchFn = async (url) => {
    if (String(url).endsWith("/v1/llm/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v11" };
        },
      };
    }
    return {
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({ error: { message: "model requires a different endpoint variant" } });
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test"], {
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn,
  });

  assert.equal(exitCode, 1);
  assert.match(stdout.toString(), /nvidia: fail HTTP 400: model requires a different endpoint variant \(minimaxai\/minimax-m3\)/);
});

test("test hides llmproxy metadata lines from the printed assistant reply", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-hide-metadata-"));
  const stdout = createWritableBuffer();
  const { createTokenStore } = require("../lib/token-store");
  const tokenStore = createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("qwen", { access_token: "token-qwen", token_type: "api_key", scope: "api_key", provider: "qwen", default_model: "qwen3.7-max" }, { name: "qwen" });

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
  assert.match(stdout.toString(), /qwen: ok \([^)]+\)/);
  assert.doesNotMatch(stdout.toString(), /llmproxy-test-qwen/);
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
          return { ok: true, manifest_version: "v11" };
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
  assert.match(stdout.toString(), /default: ok \(gpt-5\.4\)/);
  assert.doesNotMatch(stdout.toString(), /llmproxy-test-default/);
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

test("config:set/get/unset manages project-scoped variables in Claude settings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-project-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  let exitCode = await runCli(["node", "llmproxy", "config:set", "LLMPROXY_PRICE_PERFORMANCE_ROUTING", "1", "--project"], {
    cwd: tempRoot,
    stdout,
    stderr,
  });
  assert.equal(exitCode, 0);

  const settings = JSON.parse(fs.readFileSync(path.join(tempRoot, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.env.LLMPROXY_PRICE_PERFORMANCE_ROUTING, "1");

  const getStdout = createWritableBuffer();
  exitCode = await runCli(["node", "llmproxy", "config:get", "LLMPROXY_PRICE_PERFORMANCE_ROUTING", "--project"], {
    cwd: tempRoot,
    stdout: getStdout,
  });
  assert.equal(exitCode, 0);
  assert.match(getStdout.toString(), /project\.LLMPROXY_PRICE_PERFORMANCE_ROUTING=1/);

  const unsetStdout = createWritableBuffer();
  exitCode = await runCli(["node", "llmproxy", "config:unset", "LLMPROXY_PRICE_PERFORMANCE_ROUTING", "--project"], {
    cwd: tempRoot,
    stdout: unsetStdout,
  });
  assert.equal(exitCode, 0);

  const nextSettings = JSON.parse(fs.readFileSync(path.join(tempRoot, ".claude", "settings.json"), "utf8"));
  assert.equal("LLMPROXY_PRICE_PERFORMANCE_ROUTING" in nextSettings.env, false);
});

test("config:list shows effective llmproxy project defaults when values are unset", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-defaults-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "config:list", "--project"], {
    cwd: tempRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /project\.LLMPROXY_AUTO_ESCALATE=1/);
  assert.match(stdout.toString(), /project\.LLMPROXY_LLM_STATS_API_KEY=/);
  assert.match(stdout.toString(), /Global Claude configuration:/);
  assert.match(stdout.toString(), /project\.LLMPROXY_SENDGRID_API_KEY=/);
  assert.match(stdout.toString(), /project\.LLMPROXY_SENDGRID_FROM_EMAIL=/);
  assert.match(stdout.toString(), /project\.LLMPROXY_SENDGRID_TO_EMAIL=/);
  assert.match(stdout.toString(), /project\.LLMPROXY_SENDGRID_TO_MESSAGE_TYPE=service_unreachable,service_recovered,provider_error,auto_escalation,provider_credit_exhausted,service_update/);
  assert.match(stdout.toString(), /project\.LLMPROXY_INFERENCE_INFO_INLINE=1/);
  assert.match(stdout.toString(), /project\.LLMPROXY_METERING_INLINE=0/);
  assert.match(stdout.toString(), /project\.LLMPROXY_PRICE_PERFORMANCE_ROUTING=1/);
  assert.match(stdout.toString(), /project\.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER=power/);
  assert.match(stdout.toString(), /project\.LLMPROXY_PROVIDER_CREDIT_INLINE=1/);
  assert.match(stdout.toString(), /project\.LLMPROXY_SHORT_ANSWER=0/);
});

test("config:list inherits the global Claude defaults when the project has no local override", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-global-fallback-"));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "workspace");
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    env: {
      LLMPROXY_LLM_STATS_API_KEY: "sk-global-demo",
      LLMPROXY_SHORT_ANSWER: "1",
    },
  }, null, 2));

  const stdout = createWritableBuffer();
  const exitCode = await runCli(["node", "llmproxy", "config:list"], {
    cwd: projectRoot,
    stdout,
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Project configuration:/);
  assert.match(stdout.toString(), /project\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);
  assert.match(stdout.toString(), /project\.LLMPROXY_SHORT_ANSWER=1/);
  assert.match(stdout.toString(), /Global Claude configuration:/);
  assert.match(stdout.toString(), /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);
  assert.match(stdout.toString(), /global\.LLMPROXY_SHORT_ANSWER=1/);
  assert.match(stdout.toString(), /Service configuration:/);
});

test("config:list outside a project shows only service configuration", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-service-only-"));
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "config:list"], {
    cwd: tempRoot,
    stdout,
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout.toString(), /Project configuration:/);
  assert.match(stdout.toString(), /Service configuration:/);
});

test("config:set/get/unset manages service-scoped variables in the persistent service config", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-service-"));

  let exitCode = await runCli(["node", "llmproxy", "config:set", "LLMPROXY_MODE", "platform", "--service"], {
    dataRoot: runtimeRoot,
    stdout: createWritableBuffer(),
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    fetchFn: async (url) => ({
      ok: String(url).includes("7001/health") || String(url).includes("7048/health"),
      status: 200,
    }),
  });
  assert.equal(exitCode, 0);

  const serviceConfig = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "service", "config.json"), "utf8"));
  assert.equal(serviceConfig.env.LLMPROXY_MODE, "platform");

  const getStdout = createWritableBuffer();
  exitCode = await runCli(["node", "llmproxy", "config:get", "LLMPROXY_MODE", "--service"], {
    dataRoot: runtimeRoot,
    stdout: getStdout,
  });
  assert.equal(exitCode, 0);
  assert.match(getStdout.toString(), /service\.LLMPROXY_MODE=platform/);

  exitCode = await runCli(["node", "llmproxy", "config:unset", "LLMPROXY_MODE", "--service"], {
    dataRoot: runtimeRoot,
    stdout: createWritableBuffer(),
  });
  assert.equal(exitCode, 0);

  const nextServiceConfig = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "service", "config.json"), "utf8"));
  assert.equal("LLMPROXY_MODE" in nextServiceConfig.env, false);
});

test("config:set/get/unset manages global Claude variables with --scope global", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-global-"));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "workspace");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  let exitCode = await runCli(["node", "llmproxy", "config:set", "LLMPROXY_LLM_STATS_API_KEY", "sk-global-demo", "--scope", "global"], {
    cwd: projectRoot,
    stdout: createWritableBuffer(),
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(exitCode, 0);

  const getStdout = createWritableBuffer();
  exitCode = await runCli(["node", "llmproxy", "config:get", "LLMPROXY_LLM_STATS_API_KEY", "--scope", "global"], {
    cwd: projectRoot,
    stdout: getStdout,
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(exitCode, 0);
  assert.match(getStdout.toString(), /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);

  const listStdout = createWritableBuffer();
  exitCode = await runCli(["node", "llmproxy", "config:list", "--scope", "global"], {
    cwd: projectRoot,
    stdout: listStdout,
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(exitCode, 0);
  assert.match(listStdout.toString(), /Global Claude configuration:/);
  assert.match(listStdout.toString(), /global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);
  assert.doesNotMatch(listStdout.toString(), /Project configuration:/);
  assert.doesNotMatch(listStdout.toString(), /Service configuration:/);

  exitCode = await runCli(["node", "llmproxy", "config:unset", "LLMPROXY_LLM_STATS_API_KEY", "--scope", "global"], {
    cwd: projectRoot,
    stdout: createWritableBuffer(),
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(exitCode, 0);

  const globalSettings = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"));
  assert.equal("LLMPROXY_LLM_STATS_API_KEY" in (globalSettings.env || {}), false);
});

test("config scope precedence is project over global over service", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-scope-precedence-"));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "workspace");
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  const projectStdout = createWritableBuffer();
  let exitCode = await runCli([
    "node", "llmproxy", "config:set", "LLMPROXY_SHORT_ANSWER", "1",
    "--scope", "global",
    "--service",
    "--project",
  ], {
    cwd: projectRoot,
    stdout: projectStdout,
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(exitCode, 0);
  assert.match(projectStdout.toString(), /Configurazione aggiornata: project\.LLMPROXY_SHORT_ANSWER=1/);

  const projectSettings = JSON.parse(fs.readFileSync(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  assert.equal(projectSettings.env.LLMPROXY_SHORT_ANSWER, "1");

  const globalStdout = createWritableBuffer();
  exitCode = await runCli([
    "node", "llmproxy", "config:set", "LLMPROXY_LLM_STATS_API_KEY", "sk-global-demo",
    "--scope", "global",
    "--service",
  ], {
    cwd: projectRoot,
    stdout: globalStdout,
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(exitCode, 0);
  assert.match(globalStdout.toString(), /Configurazione aggiornata: global\.LLMPROXY_LLM_STATS_API_KEY=sk-global-demo/);
});

test("config:set rejects switching to platform mode when db-layer or event-bus are unavailable", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-platform-validation-"));
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "config:set", "LLMPROXY_MODE", "platform", "--service"], {
    dataRoot: runtimeRoot,
    stderr,
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    fetchFn: async () => ({ ok: false, status: 503 }),
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /Non e' possibile passare a LLMPROXY_MODE=platform/);
  assert.match(stderr.toString(), /db-layer/);
  assert.match(stderr.toString(), /event-bus/);
});

test("config:set rejects scope mismatches", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-scope-mismatch-"));
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "config:set", "LLMPROXY_MODE", "platform", "--project"], {
    dataRoot: runtimeRoot,
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.toString(), /appartiene allo scope service/);
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
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-macos-pkg-"));
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "darwin",
    stdout,
    stderr,
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr/local\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/local/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  const installCall = commandCalls.find((entry) => entry.command === "sh");
  assert.ok(installCall);
  assert.equal(installCall.spawnOptions.encoding, "utf8");
  assert.match(installCall.args[1], /case "\$platform" in/);
  assert.match(installCall.args[1], /darwin\|linux\)/);
  assert.match(installCall.args[1], /npm install -g /);
  assert.match(installCall.args[1], /LLMPROXY_MODE="standalone" LLMPROXY_SERVICE_RUNTIME="native" "\$global_bin" service:start/);
  assert.match(stdout.toString(), /Installazione persistente completata/);
  assert.match(stdout.toString(), /\/usr\/local\/bin\/llmproxy/);
});

test("install:persistent-en installs the current package globally and starts the persistent macOS service in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-macos-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-macos-pkg-"));
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "darwin",
    stdout,
    stderr,
    commandRunner(command, args) {
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr/local\n", stderr: "" };
      }
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
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-linux-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "linux",
    stdout,
    commandRunner(command, args) {
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "--version") {
        return { status: 0, stdout: "systemd 255\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "info") {
        return { status: 0, stdout: "Server:\n Containers: 0\n", stderr: "" };
      }
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
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-linux-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "linux",
    stdout,
    commandRunner(command, args) {
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "--version") {
        return { status: 0, stdout: "systemd 255\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "info") {
        return { status: 0, stdout: "Server:\n Containers: 0\n", stderr: "" };
      }
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
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-linger-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const commandCalls = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "linux",
    stdout,
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "--version") {
        return { status: 0, stdout: "systemd 255\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "info") {
        return { status: 0, stdout: "Server:\n Containers: 0\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  const installCall = commandCalls.find((entry) => entry.command === "sh");
  assert.ok(installCall);
  assert.match(installCall.args[1], /linger_user=\$\{SUDO_USER:-\$USER\}/);
  assert.match(installCall.args[1], /sudo -n loginctl enable-linger "\$linger_user"/);
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

test("install:persistent-it succeeds on Windows", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-win-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-win-pkg-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "win32",
    stdout,
    stderr,
    commandRunner(command, args) {
      commandCalls.push({ command, args });
      if (command === "cmd.exe" && args[3] === "npm.cmd --version") {
        return { status: 0, stdout: "10.0.0\n", stderr: "" };
      }
      if (command === "cmd.exe" && args[3] === "npm.cmd prefix -g") {
        return { status: 0, stdout: `${packageRoot}`, stderr: "" };
      }
      if (command === "powershell.exe") {
        return { status: 0, stdout: "__LLMPROXY_GLOBAL_BIN__=C:\\Users\\test\\AppData\\Roaming\\npm\\llmproxy\n__LLMPROXY_BIN_SCOPE__=user\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Installazione persistente completata/);
  assert.match(stdout.toString(), /Servizio persistente attivato/);
});

test("install:persistent-en succeeds on Windows in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-win-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-en-win-pkg-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "win32",
    stdout,
    stderr,
    commandRunner(command, args) {
      commandCalls.push({ command, args });
      if (command === "cmd.exe" && args[3] === "npm.cmd --version") {
        return { status: 0, stdout: "10.0.0\n", stderr: "" };
      }
      if (command === "cmd.exe" && args[3] === "npm.cmd prefix -g") {
        return { status: 0, stdout: `${packageRoot}`, stderr: "" };
      }
      if (command === "powershell.exe") {
        return { status: 0, stdout: "__LLMPROXY_GLOBAL_BIN__=C:\\Users\\test\\AppData\\Roaming\\npm\\llmproxy\n__LLMPROXY_BIN_SCOPE__=user\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Persistent installation completed/);
  assert.match(stdout.toString(), /Persistent service enabled/);
});

test("windows persistent install script resolves the global cmd wrapper explicitly", () => {
  const script = buildPersistentInstallScript({
    packageRoot: "/tmp/pkg",
    locale: "en",
    platform: "win32",
  });
  assert.match(script, /\$tmpdir = Join-Path/);
  assert.match(script, /& llmproxy service:stop 2>\$null \| Out-Null/);
  assert.match(script, /npm pack \$packageRoot --pack-destination \$tmpdir/);
  assert.match(script, /\$packageFile = Get-ChildItem \(Join-Path \$tmpdir '\*\.tgz'\)/);
  assert.match(script, /npm install -g \$packageFile 2>&1/);
  assert.match(script, /function Resolve-LlmproxyGlobalBin\(\[string\]\$Prefix\)/);
  assert.match(script, /Join-Path \$Prefix "llmproxy\.cmd"/);
  assert.match(script, /\$globalBin = Resolve-LlmproxyGlobalBin \$npmPrefix/);
});

test("runSelfUpdateWindows resolves the global cmd wrapper explicitly", () => {
  const executed = [];
  runSelfUpdateWindows((command, args) => {
    executed.push([command, args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  const windowsScriptText = executed[0][1][2];
  assert.match(windowsScriptText, /\$PSNativeCommandUseErrorActionPreference = \$false/);
  assert.match(windowsScriptText, /function Quote-CmdArgument\(\[string\]\$Value\)/);
  assert.match(windowsScriptText, /function Invoke-QuietNative\(\[string\]\$FilePath, \[string\[\]\]\$ArgumentList\)/);
  assert.match(windowsScriptText, /\$resolvedFilePath = "cmd\.exe"/);
  assert.match(windowsScriptText, /\$resolvedArguments = @\("\/d", "\/s", "\/c", \$cmdLine\)/);
  assert.match(windowsScriptText, /\$resolvedFilePath = "powershell\.exe"/);
  assert.match(windowsScriptText, /\$resolvedArguments = @\("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", \$FilePath\) \+ @\(\$ArgumentList\)/);
  assert.match(windowsScriptText, /\$resolvedFilePath = "node\.exe"/);
  assert.match(windowsScriptText, /& llmproxy service:stop 2>\$null \| Out-Null/);
  assert.match(windowsScriptText, /function Resolve-LlmproxyGlobalBin\(\[string\]\$Prefix\)/);
  assert.match(windowsScriptText, /Join-Path \$Prefix "llmproxy\.cmd"/);
  assert.match(windowsScriptText, /\$newBin = Resolve-LlmproxyGlobalBin \$npmPrefix/);
  assert.match(windowsScriptText, /Invoke-QuietNative "git" @\("clone", "--depth=1"/);
  assert.match(windowsScriptText, /Invoke-QuietNative "npm" @\("install", "-g", "--force", "\$packageFile"\)/);
  assert.match(windowsScriptText, /Invoke-QuietNative "\$newBin" @\("config:migrate"\)/);
});

test("install:persistent-it fails with prerequisite guidance when Docker is missing on Ubuntu", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-preflight-fail-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-preflight-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "linux",
    stdout,
    stderr,
    env: { LLMPROXY_SERVICE_RUNTIME: "docker" },
    osReleaseContent: 'ID=ubuntu\nID_LIKE=debian\n',
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "--version") {
        return { status: 0, stdout: "systemd 255\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 1, stdout: "", stderr: "unknown command\n" };
      }
      if (command === "docker-compose" && args[0] === "version") {
        return { status: 1, stdout: "", stderr: "not found\n" };
      }
      if (command === "docker" && args[0] === "--version") {
        return { status: 1, stdout: "", stderr: "not found\n" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /I prerequisiti per l'installazione persistente non sono soddisfatti/);
  assert.match(stderr.toString(), /Docker non trovato nel PATH/);
  assert.match(stderr.toString(), /sudo apt update && sudo apt install -y docker\.io docker-compose-v2/);
  assert.equal(commandCalls.some((entry) => entry.command === "sh"), false);
});

test("install:persistent-en stops early when the global npm prefix is protected and sudo is not pre-authorized", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-sudo-ticket-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-sudo-ticket-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-protected-prefix-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");
  fs.chmodSync(npmPrefix, 0o555);

  try {
    const exitCode = await runCli(["node", "llmproxy", "install:persistent-en"], {
      dataRoot: runtimeRoot,
      packageRoot,
      platform: "linux",
      stdout,
      stderr,
      env: { LLMPROXY_SERVICE_RUNTIME: "native" },
      commandRunner(command, args) {
        if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
        if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: `${npmPrefix}\n`, stderr: "" };
        if (command === "systemctl" && args[0] === "--version") return { status: 0, stdout: "systemd 255\n", stderr: "" };
        if (command === "bash") return { status: 0, stdout: "", stderr: "" };
        if (command === "sudo" && args[0] === "--version") return { status: 0, stdout: "sudo 1.0\n", stderr: "" };
        if (command === "sudo" && args[0] === "-n") return { status: 1, stdout: "", stderr: "sudo: a password is required" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.toString(), "");
    assert.match(stderr.toString(), /sudo -v/);
    assert.match(stderr.toString(), /rerun the command with `sudo`/i);
  } finally {
    fs.chmodSync(npmPrefix, 0o755);
  }
});

test("install:persistent-it accepts legacy docker-compose during preflight", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-legacy-compose-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-legacy-compose-pkg-")), "node_modules", "llmproxy");
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install:persistent-it"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "linux",
    stdout,
    stderr,
    env: { LLMPROXY_SERVICE_RUNTIME: "docker" },
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "--version") {
        return { status: 0, stdout: "systemd 255\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "compose" && args[1] === "version") {
        return { status: 1, stdout: "", stderr: "unknown command\n" };
      }
      if (command === "docker-compose" && args[0] === "version") {
        return { status: 0, stdout: "Docker Compose version v2.29.0\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "info") {
        return { status: 0, stdout: "Server:\n Containers: 0\n", stderr: "" };
      }
      if (command === "sh") {
        return { status: 0, stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/bin/llmproxy\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Installazione persistente completata/);
  assert.equal(commandCalls.some((entry) => entry.command === "docker-compose" && entry.args[0] === "version"), true);
});

test("install remains an alias for install:persistent-en", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-alias-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-alias-pkg-"));
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  fs.writeFileSync(composeFile, "services:\n  llmproxy:\n    image: llmproxy:test\n", "utf8");

  const exitCode = await runCli(["node", "llmproxy", "install"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "darwin",
    stdout,
    stderr,
    commandRunner(command, args, spawnOptions) {
      commandCalls.push({ command, args, spawnOptions });
      if (command === "npm" && args[0] === "prefix" && args[1] === "-g") {
        return { status: 0, stdout: "/usr/local\n", stderr: "" };
      }
      return {
        status: 0,
        stdout: "__LLMPROXY_GLOBAL_BIN__=/usr/local/bin/llmproxy\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  const installCall = commandCalls.find((entry) => entry.command === "sh");
  assert.ok(installCall);
  assert.match(stdout.toString(), /Persistent installation completed/);
  assert.match(stdout.toString(), /Global binary: \/usr\/local\/bin\/llmproxy/);
  assert.match(stdout.toString(), /Persistent service enabled with launchd/);
});

test("install alias succeeds on Windows in English", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-english-win-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-english-win-pkg-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install"], {
    dataRoot: runtimeRoot,
    packageRoot,
    platform: "win32",
    stdout,
    stderr,
    commandRunner(command, args) {
      commandCalls.push({ command, args });
      if (command === "cmd.exe" && args[3] === "npm.cmd --version") {
        return { status: 0, stdout: "10.0.0\n", stderr: "" };
      }
      if (command === "cmd.exe" && args[3] === "npm.cmd prefix -g") {
        return { status: 0, stdout: `${packageRoot}`, stderr: "" };
      }
      if (command === "powershell.exe") {
        return { status: 0, stdout: "__LLMPROXY_GLOBAL_BIN__=C:\\Users\\test\\AppData\\Roaming\\npm\\llmproxy\n__LLMPROXY_BIN_SCOPE__=user\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Persistent installation completed/);
  assert.match(stdout.toString(), /Persistent service enabled/);
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
  assert.match(stdout.toString(), /llmproxy install:persistent-it\s+\[llmp in:it\]\s+installa globalmente la CLI corrente/i);
  assert.match(stdout.toString(), /llmproxy install:persistent-en\s+\[llmp in:en\]\s+installs the current CLI globally/i);
  assert.match(stdout.toString(), /llmproxy stop\s+\[llmp sto\]\s+ferma solo l'istanza locale\/dev/i);
  assert.match(stdout.toString(), /llmproxy test\s+\[llmp t\]\s+esegue un test rapido di inferenza contro il proxy locale/i);
  assert.doesNotMatch(stdout.toString(), /llmproxy login\s+\[llmp li\]/i);
  assert.doesNotMatch(stdout.toString(), /llmproxy logout\s+\[llmp lo\]/i);
  assert.match(stdout.toString(), /llmproxy stats\s+\[llmp sa\]\s+mostra statistiche aggregate di utilizzo per provider e modello/i);
  assert.match(stdout.toString(), /llmproxy provider:available\s+\[llmp p:av\]\s+elenca i provider supportati dalla CLI/i);
  assert.match(stdout.toString(), /llmproxy update\s+\[llmp up\]\s+scarica e installa l'ultima versione/i);
  assert.match(stdout.toString(), /llmproxy uninstall\s+\[llmp un\]\s+disinstallazione completa/i);
  assert.match(stdout.toString(), /llmproxy version\s+\[llmp v\]\s+mostra la versione corrente/i);
  assert.match(stdout.toString(), /Problemi comuni:/);
});

test("stop terminates only the dev foreground instance on port 5045", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-stop-dev-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const killed = [];

  fs.mkdirSync(path.join(runtimeRoot, "service"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "service", "foreground-run.json"), JSON.stringify({
    pid: 42424,
    host: "127.0.0.1",
    port: 5045,
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "stop"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    execCommand() {
      return {
        status: 0,
        stdout: ["p42424", "cnode", "n127.0.0.1:5045", ""].join("\n"),
        stderr: "",
      };
    },
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(killed, [{ pid: 42424, signal: "SIGTERM" }]);
  assert.match(stdout.toString(), /Istanza dev fermata su http:\/\/127\.0\.0\.1:5045/);
  assert.equal(stderr.toString(), "");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "service", "foreground-run.json")), false);
});

test("stop does not touch the persistent service and reports when no dev instance is running", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-stop-none-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const serviceCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "stop"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    execCommand() {
      return { status: 1, stdout: "", stderr: "" };
    },
    serviceManager: {
      kind: "launchd",
      stop() {
        serviceCalls.push("stop");
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(serviceCalls, []);
  assert.match(stdout.toString(), /Nessuna istanza dev attiva su http:\/\/127\.0\.0\.1:5045/);
  assert.equal(stderr.toString(), "");
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
  assert.doesNotMatch(stdout.toString(), /ok copilot|ok kimi/);
});

test("test --all-providers reports ok when response has no text content but request summary shows success", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-metadata-only-provider-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("opencode", {
    access_token: "token-opencode",
    token_type: "api_key",
    provider: "opencode",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
  }, { name: "OpenCode Zen" });

  const fetchFn = async (url) => {
    if (String(url).endsWith("/health")) {
      return {
        ok: true, status: 200,
        async json() { return { ok: true, manifest_version: "v11" }; },
      };
    }
    // Simula il proxy: risposta con solo metadata e tool_use, nessun testo utile
    const logsDir = path.join(runtimeRoot, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify({
      ts: new Date().toISOString(),
      event: "request_summary",
      requestId: "req-metadata-only",
      success: true,
      finalProvider: "opencode",
      finalModel: "deepseek-v4-flash-free",
      providerSequence: [
        { provider: "opencode", status: 200, success: true, effective_model: "deepseek-v4-flash-free" },
      ],
    }) + "\n", "utf8");
    return {
      ok: true, status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: "deepseek-v4-flash-free",
          content: [
            { type: "text", text: "[llmproxy] provider: opencode | model: deepseek-v4-flash-free\n\n" },
            { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo hello" } },
          ],
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
  assert.match(stdout.toString(), /opencode: ok \(deepseek-v4-flash-free\)/);
  assert.doesNotMatch(stdout.toString(), /fail risposta vuota/);
});

test("test --all-providers waits for a delayed per-provider request summary before declaring empty response", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-delayed-provider-summary-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("opencode", {
    access_token: "token-opencode",
    token_type: "api_key",
    provider: "opencode",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
  }, { name: "OpenCode Zen" });

  const logsDir = path.join(runtimeRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);

  let proxyRequestIndex = 0;
  let delayedSummaryWritten = false;
  const fetchFn = async (url, options = {}) => {
    if (String(url).endsWith("/health")) {
      return {
        ok: true, status: 200,
        async json() { return { ok: true, manifest_version: "v11" }; },
      };
    }

    proxyRequestIndex += 1;
    const body = JSON.parse(String(options.body || "{}"));
    if (proxyRequestIndex === 1) {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-deepseek",
        success: true,
        finalProvider: "deepseek",
        finalModel: "deepseek-v4-flash",
        providerSequence: [
          { provider: "deepseek", status: 200, success: true, effective_model: "deepseek-v4-flash" },
        ],
      }) + "\n", "utf8");
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: body.model,
          content: [
            { type: "text", text: `[llmproxy] provider: ${body.provider} | model: ${body.model}\n\n` },
          ],
        };
      },
    };
  };

  let sleepCalls = 0;
  const sleep = async () => {
    sleepCalls += 1;
    if (!delayedSummaryWritten && sleepCalls >= 12) {
      delayedSummaryWritten = true;
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-opencode",
        success: true,
        finalProvider: "opencode",
        finalModel: "deepseek-v4-flash-free",
        providerSequence: [
          { provider: "opencode", status: 200, success: true, effective_model: "deepseek-v4-flash-free" },
        ],
      }) + "\n", "utf8");
    }
  };

  const exitCode = await runCli(["node", "llmproxy", "test", "--all-providers"], {
    dataRoot: runtimeRoot,
    stdout,
    tokenStore,
    fetchFn,
    sleep,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /deepseek: ok \(deepseek-v4-flash\)/);
  assert.match(stdout.toString(), /opencode: ok \(deepseek-v4-flash-free\)/);
  assert.doesNotMatch(stdout.toString(), /fail risposta vuota/);
  assert.equal(delayedSummaryWritten, true);
});

test("test -i runs a real inference through fallback order and prints final provider plus response", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-inference-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("openrouter", {
    access_token: "token-openrouter",
    token_type: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "minimax/minimax-m3-20260531",
  }, { name: "OpenRouter" });

  const requests = [];
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, options });
    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v11" };
        },
      };
    }
    const logsDir = path.join(runtimeRoot, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify({
      ts: new Date().toISOString(),
      event: "request_summary",
      requestId: "req-inference",
      success: true,
      finalProvider: "openrouter",
      finalModel: "minimax/minimax-m3-20260531",
      providerSequence: [
        { provider: "deepseek", status: 402, success: false, effective_model: "deepseek-v4-pro", actual_model: null },
        { provider: "openrouter", status: 200, success: true, effective_model: "minimax/minimax-m3-20260531", actual_model: "minimax/minimax-m3-20260531" },
      ],
    }) + "\n", "utf8");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: "minimax/minimax-m3-20260531",
          content: [{ type: "text", text: "llmproxy-test-openrouter" }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test", "-i"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 2);
  const body = JSON.parse(String(requests[1].options.body || "{}"));
  assert.equal(body.provider, undefined);
  assert.equal(body.model, undefined);
  assert.equal(body.messages[0].content[0].text, "Rispondi solo: llmproxy-test-inference");
  assert.match(stdout.toString(), /inference: ok \(openrouter \| minimax\/minimax-m3-20260531\)/);
  assert.match(stdout.toString(), /response: llmproxy-test-openrouter/);
  assert.doesNotMatch(stdout.toString(), /^fallback:/m);
});

test("test -i treats metadata-only inline output as a successful inference when the request summary is valid", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-inference-metadata-only-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.7-code",
  }, { name: "Kimi" });
  tokenStore.saveProvider("openrouter", {
    access_token: "token-openrouter",
    token_type: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "minimax/minimax-m3-20260531",
  }, { name: "OpenRouter" });

  const fetchFn = async (url) => {
    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v11" };
        },
      };
    }
    const logsDir = path.join(runtimeRoot, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify({
      ts: new Date().toISOString(),
      event: "request_summary",
      requestId: "req-inference-metadata-only",
      success: true,
      finalProvider: "kimi",
      finalModel: "kimi-k2.7-code",
      providerSequence: [
        { provider: "kimi", status: 200, success: true, effective_model: "kimi-k2.7-code", actual_model: "kimi-k2.7-code" },
      ],
    }) + "\n", "utf8");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          type: "message",
          role: "assistant",
          model: "kimi-k2.7-code",
          content: [{
            type: "text",
            text: "[llmproxy] provider: kimi | model: kimi-k2.7-code\n\n[llmproxy] tokens: req 357 (in 101, out 256) | provider today 2196 week 3422 | model today 2196 week 3422",
          }],
        };
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test", "-i"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /inference: ok \(kimi \| kimi-k2\.7-code\)/);
  assert.doesNotMatch(stdout.toString(), /^response:/m);
});

test("test -i --all-providers prints only validated working fallbacks after the winner", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-inference-all-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("deepseek-v4-flash", {
    access_token: "token-deepseek-flash",
    token_type: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash",
  }, { name: "DeepSeek Flash" });
  tokenStore.saveProvider("openrouter", {
    access_token: "token-openrouter",
    token_type: "api_key",
    provider: "openrouter",
    auth_type: "api_key",
    default_model: "minimax/minimax-m3-20260531",
  }, { name: "OpenRouter" });
  tokenStore.saveProvider("qwen", {
    access_token: "token-qwen",
    token_type: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-plus",
  }, { name: "Qwen" });
  tokenStore.saveProvider("opencode", {
    access_token: "token-opencode",
    token_type: "api_key",
    provider: "opencode",
    auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
  }, { name: "OpenCode" });

  let probeIndex = 0;
  const fetchFn = async (url, options = {}) => {
    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v11" };
        },
      };
    }
    const body = JSON.parse(String(options.body || "{}"));
    const logsDir = path.join(runtimeRoot, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);
    probeIndex += 1;

    if (probeIndex === 1) {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-inference-all",
        success: true,
        finalProvider: "openrouter",
        finalModel: "minimax/minimax-m3-20260531",
        providerSequence: [
          { provider: "deepseek", status: 402, success: false, effective_model: "deepseek-v4-pro", actual_model: null },
          { provider: "deepseek-v4-flash", status: 402, success: false, effective_model: "deepseek-v4-flash", actual_model: null },
          { provider: "openrouter", status: 200, success: true, effective_model: "minimax/minimax-m3-20260531", actual_model: "minimax/minimax-m3-20260531" },
        ],
      }) + "\n", "utf8");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "message",
            role: "assistant",
            model: "minimax/minimax-m3-20260531",
            content: [{ type: "text", text: "llmproxy-test-openrouter" }],
          };
        },
      };
    }

    if (body.provider === "qwen") {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-qwen-fallback",
        success: true,
        finalProvider: "qwen",
        finalModel: "qwen3.7-plus",
        providerSequence: [
          { provider: "qwen", status: 200, success: true, effective_model: "qwen3.7-plus", actual_model: "qwen3.7-plus" },
        ],
      }) + "\n", "utf8");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "message",
            role: "assistant",
            model: "qwen3.7-plus",
            content: [{ type: "text", text: "llmproxy-test-qwen" }],
          };
        },
      };
    }

    if (body.provider === "opencode") {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-opencode-fallback",
        success: true,
        finalProvider: "opencode",
        finalModel: "deepseek-v4-flash-free",
        providerSequence: [
          { provider: "opencode", status: 200, success: true, effective_model: "deepseek-v4-flash-free", actual_model: "deepseek-v4-flash-free" },
        ],
      }) + "\n", "utf8");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "message",
            role: "assistant",
            model: "deepseek-v4-flash-free",
            content: [{ type: "text", text: "llmproxy-test-opencode" }],
          };
        },
      };
    }

    return {
      ok: false,
      status: 400,
      async json() {
        return {};
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test", "-i", "--all-providers"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /inference: ok \(openrouter \| minimax\/minimax-m3-20260531\)/);
  assert.match(stdout.toString(), /1st fallback: qwen \| qwen3\.7-plus/);
  assert.match(stdout.toString(), /2nd fallback: opencode \| deepseek-v4-flash-free/);
  assert.doesNotMatch(stdout.toString(), /^invalid fallback:/m);
  assert.match(stdout.toString(), /response: llmproxy-test-openrouter/);
});

test("test -i --all-providers skips broken remaining fallbacks and fails the command", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-test-inference-broken-remaining-"));
  const stdout = createWritableBuffer();
  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  tokenStore.saveProvider("deepseek", {
    access_token: "token-deepseek",
    token_type: "api_key",
    provider: "deepseek",
    auth_type: "api_key",
    default_model: "deepseek-v4-pro",
  }, { name: "DeepSeek" });
  tokenStore.saveProvider("commandcode", {
    access_token: "token-commandcode",
    token_type: "api_key",
    provider: "commandcode",
    auth_type: "api_key",
    default_model: "Qwen/Qwen3.7-Max",
  }, { name: "CommandCode" });
  tokenStore.saveProvider("qwen", {
    access_token: "token-qwen",
    token_type: "api_key",
    provider: "qwen",
    auth_type: "api_key",
    default_model: "qwen3.7-plus",
  }, { name: "Qwen" });
  tokenStore.saveProvider("kimi", {
    access_token: "token-kimi",
    token_type: "api_key",
    provider: "kimi",
    auth_type: "api_key",
    default_model: "kimi-k2.7-code",
  }, { name: "Kimi" });

  const fetchFn = async (url, options = {}) => {
    if (String(url).endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, manifest_version: "v11" };
        },
      };
    }
    const body = JSON.parse(String(options.body || "{}"));
    const logsDir = path.join(runtimeRoot, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);

    if (!body.provider) {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-inference-deepseek",
        success: true,
        finalProvider: "deepseek",
        finalModel: "deepseek-v4-pro",
        providerSequence: [
          { provider: "deepseek", status: 200, success: true, effective_model: "deepseek-v4-pro", actual_model: "deepseek-v4-pro" },
        ],
      }) + "\n", "utf8");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "message",
            role: "assistant",
            model: "deepseek-v4-pro",
            content: [{ type: "text", text: "llmproxy-test-deepseek" }],
          };
        },
      };
    }

    if (body.provider === "qwen") {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-fallback-qwen",
        success: true,
        finalProvider: "qwen",
        finalModel: "qwen3.7-plus",
        providerSequence: [
          { provider: "qwen", status: 200, success: true, effective_model: "qwen3.7-plus", actual_model: "qwen3.7-plus" },
        ],
      }) + "\n", "utf8");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "message",
            role: "assistant",
            model: "qwen3.7-plus",
            content: [{ type: "text", text: "llmproxy-test-qwen" }],
          };
        },
      };
    }

    if (body.provider === "kimi") {
      fs.appendFileSync(logFile, JSON.stringify({
        ts: new Date().toISOString(),
        event: "request_summary",
        requestId: "req-fallback-kimi",
        success: true,
        finalProvider: "kimi",
        finalModel: "kimi-k2.7-code",
        providerSequence: [
          { provider: "kimi", status: 200, success: true, effective_model: "kimi-k2.7-code", actual_model: "kimi-k2.7-code" },
        ],
      }) + "\n", "utf8");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "message",
            role: "assistant",
            model: "kimi-k2.7-code",
            content: [{ type: "text", text: "llmproxy-test-kimi" }],
          };
        },
      };
    }

    return {
      ok: false,
      status: 400,
      async json() {
        return {};
      },
    };
  };

  const exitCode = await runCli(["node", "llmproxy", "test", "-i", "--all-providers"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  assert.equal(exitCode, 1);
  assert.match(stdout.toString(), /inference: ok \(deepseek \| deepseek-v4-pro\)/);
  assert.match(stdout.toString(), /1st fallback: qwen \| qwen3\.7-plus/);
  assert.match(stdout.toString(), /2nd fallback: kimi \| kimi-k2\.7-code/);
  assert.match(stdout.toString(), /invalid fallback: commandcode -> HTTP 400 \(Qwen\/Qwen3\.7-Max\)/);
  assert.match(stdout.toString(), /response: llmproxy-test-deepseek/);
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
      LLMPROXY_MODE: "standalone",
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
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner(command, args) {
      executed.push([command, args]);
      if (["git", "pnpm"].includes(command)) {
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
    ["git", ["--version"]],
    ["npm", ["--version"]],
    ["npm", ["prefix", "-g"]],
  ]);
  assert.ok(executed.some(([command, args]) => command === "npm" && args[0] === "prefix" && args[1] === "-g"));
  assert.equal(executed.at(-1)[0], "bash");
  assert.equal(executed.at(-1)[1][0], "-c");
  const scriptText = executed.at(-1)[1][1];
  assert.match(scriptText, /original_npm_prefix=\$\(npm prefix -g 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /original_global_bin_path="\$original_npm_prefix\/bin\/llmproxy"/);
  assert.match(scriptText, /original_global_short_bin_path="\$original_npm_prefix\/bin\/llmp"/);
  assert.match(scriptText, /current_bin=\$\(command -v llmproxy 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /current_short_bin=\$\(command -v llmp 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /npm install -g --force "\$package_file"/);
  assert.match(scriptText, /ensure_global_short_bin >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /preserved_bin_paths=\$\(printf "%s\\n" "\$current_bin" "\$current_short_bin" "\$global_bin_path" "\$global_short_bin_path" "\$original_global_bin_path" "\$original_global_short_bin_path" "\/usr\/bin\/llmproxy" "\/usr\/local\/bin\/llmproxy" "\/usr\/bin\/llmp" "\/usr\/local\/bin\/llmp" \$existing_bins \| awk 'NF && !seen\[\$0\]\+\+'\)/);
  assert.match(scriptText, /for preserved_bin in \$preserved_bin_paths; do/);
  assert.match(scriptText, /ensure_wrapper_path "\$preserved_bin" >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /done/);
  assert.match(scriptText, /if \[ -n "\$installed_bin" \] && \[ "\$installed_bin" != "\$new_bin" \] && ! is_preserved_bin_path "\$installed_bin"; then/);
  assert.match(scriptText, /if \[ -n "\$current_bin" \] && \[ "\$current_bin" != "\$new_bin" \] && \[ "\$current_bin" != "\$global_bin_path" \]; then/);
  assert.match(scriptText, /if \[ -n "\$current_short_bin" \] && \[ "\$current_short_bin" != "\$new_bin" \] && \[ "\$current_short_bin" != "\$global_short_bin_path" \]; then/);
  assert.match(scriptText, /printf "%s\\n" "\$current_wrapper_payload" > "\$current_bin"/);
  assert.match(scriptText, /printf "%s\\n" "\$current_short_wrapper_payload" > "\$current_short_bin"/);
  assert.match(scriptText, /exec \\"\$new_bin\\" \\"\\\$@\\"" \)/);
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
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner(command, args) {
      executed.push([command, args]);
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
  assert.match(stderr.toString(), /Git \(`git`\) non trovato/i);
  assert.doesNotMatch(stderr.toString(), /pnpm non trovato/i);
  assert.equal(executed.some(([command]) => command === "bash"), false);
});

test("update stops early when the global npm prefix is protected and sudo is not pre-authorized", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-sudo-ticket-"));
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-protected-prefix-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  fs.chmodSync(npmPrefix, 0o555);

  try {
    const exitCode = await runCli(["node", "llmproxy", "update"], {
      dataRoot: runtimeRoot,
      stdout,
      stderr,
      env: { ...process.env, LLMPROXY_ENV: "development" },
      fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
      commandRunner(command, args) {
        if (command === "git") return { status: 0, stdout: "git version 2.0.0\n", stderr: "" };
        if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
        if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: `${npmPrefix}\n`, stderr: "" };
        if (command === "sudo" && args[0] === "--version") return { status: 0, stdout: "sudo 1.0\n", stderr: "" };
        if (command === "sudo" && args[0] === "-n") return { status: 1, stdout: "", stderr: "sudo: a password is required" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(stdout.toString(), "");
    assert.match(stderr.toString(), /sudo -v/);
    assert.match(stderr.toString(), /sudo llmproxy update/);
  } finally {
    fs.chmodSync(npmPrefix, 0o755);
  }
});

test("update keeps going when the remote version probe times out", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-version-timeout-"));
  const stdout = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    remoteVersionTimeoutMs: 10,
    fetchFn: async () => new Promise(() => {}),
    commandRunner(command, args) {
      executed.push([command, args]);
      if (command === "git") return { status: 0, stdout: "git version 2.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: "/tmp/npm-prefix\n", stderr: "" };
      if (command === "sudo") return { status: 0, stdout: "sudo 1.0\n", stderr: "" };
      return {
        status: 0,
        stdout: "changed 1 package\n__LLMPROXY_VERSION__=0.3.07\n__LLMPROXY_RELEASE_NOTES_START__\nChangelog 0.3.07:\n- release 0.3.07\n__LLMPROXY_RELEASE_NOTES_END__\n",
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(executed.some(([command]) => command === "bash"), true);
  assert.match(stdout.toString(), /Versione corrente: 0\.3\.07/);
});

test("update on Windows accepts npm.cmd during preflight", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-win-npmcmd-"));
  const stdout = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    platform: "win32",
    stdout,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner(command, args) {
      executed.push([command, args]);
      if (command === "git") return { status: 0, stdout: "git version 2.0.0\n", stderr: "" };
      if (command === "npm") return { status: 1, stdout: "", stderr: "'npm' is not recognized" };
      if (command === "cmd.exe" && args[3] === "npm.cmd --version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
      if (command === "cmd.exe" && args[3] === "npm.cmd prefix -g") return { status: 0, stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\n", stderr: "" };
      return { status: 0, stdout: "changed 1 package\n__LLMPROXY_VERSION__=0.3.11\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(executed.some(([command, args]) => command === "cmd.exe" && args[3] === "npm.cmd --version"), true);
  assert.equal(executed.some(([command]) => command === "powershell.exe"), true);
  assert.match(stdout.toString(), /Versione corrente: 0\.3\.11/);
});

test("update on Windows stops early with admin guidance when the llmproxy service is active", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-win-service-admin-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    platform: "win32",
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner(command, args) {
      if (command === "git") return { status: 0, stdout: "git version 2.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "--version") return { status: 0, stdout: "10.0.0\n", stderr: "" };
      if (command === "npm" && args[0] === "prefix") return { status: 0, stdout: "C:\\Users\\test\\AppData\\Roaming\\npm\n", stderr: "" };
      if (command === "sc.exe" && args[0] === "query" && args[1] === "llmproxy") {
        return { status: 0, stdout: "STATE              : 4  RUNNING\n", stderr: "" };
      }
      if (command === "powershell.exe" && args.includes("WindowsBuiltInRole")) {
        return { status: 0, stdout: "0\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /PowerShell.*Amministratore/i);
  assert.match(stderr.toString(), /llmp up/);
  assert.match(stderr.toString(), /llmp service:stop/);
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
    env: { ...process.env, LLMPROXY_ENV: "production", LLMPROXY_SERVICE_RUNTIME: "docker" },
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
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
  assert.match(scriptText, /current_short_bin=\$\(command -v llmp 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /current_version=\$\(llmproxy version 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /used_sudo=0/);
  assert.match(scriptText, /original_npm_prefix=\$\(npm prefix -g 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /original_global_short_bin_path="\$original_npm_prefix\/bin\/llmp"/);
  assert.match(scriptText, /rollback_manifest="\$tmpdir\/rollback-manifest\.txt"/);
  assert.match(scriptText, /backup_install_dir\(\) \{/);
  assert.match(scriptText, /restore_backups\(\) \{/);
  assert.match(scriptText, /rollback_and_exit\(\) \{/);
  assert.match(scriptText, /safe_remove_path\(\) \{/);
  assert.match(scriptText, /purge_installation_targets\(\) \{/);
  assert.match(scriptText, /purge_existing_wrappers\(\) \{/);
  assert.match(scriptText, /ensure_runtime_home_permissions\(\) \{/);
  assert.match(scriptText, /target_version=\$\(node -p "require\('\.\/package\.json'\)\.version"\)/);
  assert.match(scriptText, /cleanup_global_service_port "\$\{PORT:-7045\}"\nnpm uninstall -g llmproxy >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /if command -v sudo >\/dev\/null 2>&1; then\n\s+sudo npm uninstall -g llmproxy >\/dev\/null 2>&1 \|\| true\nfi/);
  assert.match(scriptText, /pnpm remove -g llmproxy >\/dev\/null 2>&1 \|\| true\npurge_installation_targets\npurge_existing_wrappers/);
  assert.match(scriptText, /if sudo npm install -g --force "\$package_file" 2>\/dev\/null; then\n\s+used_sudo=1/);
  assert.match(scriptText, /if \[ "\$used_sudo" -eq 1 \]; then\n\s+npm_prefix=\$\(sudo npm prefix -g 2>\/dev\/null \|\| echo "\/usr\/local"\)\nelse\n\s+npm_prefix=\$\(npm prefix -g 2>\/dev\/null \|\| echo "\/usr\/local"\)\nfi/);
  assert.match(scriptText, /install_dir="\$npm_prefix\/lib\/node_modules\/llmproxy"/);
  assert.match(scriptText, /package_cli="\$install_dir\/bin\/llmproxy\.js"/);
  assert.match(scriptText, /global_bin_path="\$npm_prefix\/bin\/llmproxy"/);
  assert.match(scriptText, /global_short_bin_path="\$npm_prefix\/bin\/llmp"/);
  assert.match(scriptText, /run_new_llmproxy\(\) \{/);
  assert.match(scriptText, /elif \[ -f "\$package_cli" \]; then\n\s+node "\$package_cli" "\$@"/);
  assert.match(scriptText, /build_wrapper_payload\(\) \{/);
  assert.match(scriptText, /ensure_wrapper_path\(\) \{/);
  assert.match(scriptText, /ensure_global_bin\(\) \{/);
  assert.match(scriptText, /cleanup_global_service_port\(\) \{/);
  assert.match(scriptText, /collect_install_target "\/usr\/lib\/node_modules\/llmproxy"/);
  assert.match(scriptText, /collect_install_target "\/usr\/local\/lib\/node_modules\/llmproxy"/);
  assert.match(scriptText, /collect_install_target "\/opt\/homebrew\/lib\/node_modules\/llmproxy"/);
  assert.match(scriptText, /wrapper_targets=\$\(printf "%s\\n" "\$current_bin" "\$current_short_bin" "\$original_global_bin_path" "\$original_global_short_bin_path" "\/usr\/bin\/llmproxy" "\/usr\/local\/bin\/llmproxy" "\/opt\/homebrew\/bin\/llmproxy" "\/usr\/bin\/llmp" "\/usr\/local\/bin\/llmp" "\/opt\/homebrew\/bin\/llmp" \$existing_bins \| awk 'NF && !seen\[\$0\]\+\+'\)/);
  assert.match(scriptText, /run_new_llmproxy config:migrate >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /touch "\$runtime_home\/logs\/service\.out\.log" "\$runtime_home\/logs\/service\.err\.log" "\$runtime_home\/logs\/metering\.jsonl"/);
  assert.match(scriptText, /sudo chown -R "\$runtime_owner":"\$runtime_owner" "\$runtime_home" >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /ensure_runtime_home_permissions "\$LLMPROXY_HOME" "\$runtime_owner"/);
  assert.match(scriptText, /if \[ -f "\$package_cli" \]; then/);
  assert.match(scriptText, /package_cli_version=\$\(node "\$package_cli" version 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /if \[ "\$version_output" != "\$target_version" \] && \[ -x "\$global_bin_path" \]; then/);
  assert.match(scriptText, /new_bin_mode="node"/);
  assert.match(scriptText, /sudo -u "\$SUDO_USER" XDG_RUNTIME_DIR=.*DBUS_SESSION_BUS_ADDRESS=.*node "\$new_bin" service:restart/);
  assert.match(scriptText, /resolved_bins=\$\( \(which -a llmproxy 2>\/dev\/null; which -a llmp 2>\/dev\/null\) \| awk '!seen\[\$0\]\+\+'\)/);
  assert.match(scriptText, /if \[ "\$version_output" != "\$target_version" \] && \[ -x "\$global_bin_path" \]; then/);
  assert.match(scriptText, /global_bin_version=\$\(\"\$global_bin_path\" version 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /candidate_version=\$\(\"\$candidate_bin\" version 2>\/dev\/null \|\| true\)/);
  assert.match(scriptText, /ensure_global_bin >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /ensure_global_short_bin >\/dev\/null 2>&1 \|\| true/);
  assert.match(scriptText, /preserved_bin_paths=\$\(printf "%s\\n" "\$current_bin" "\$current_short_bin" "\$global_bin_path" "\$global_short_bin_path" "\$original_global_bin_path" "\$original_global_short_bin_path" "\/usr\/bin\/llmproxy" "\/usr\/local\/bin\/llmproxy" "\/usr\/bin\/llmp" "\/usr\/local\/bin\/llmp" \$existing_bins \| awk 'NF && !seen\[\$0\]\+\+'\)/);
  assert.match(scriptText, /is_preserved_bin_path\(\) \{/);
  assert.match(scriptText, /if \[ -n "\$current_bin" \] && \[ "\$current_bin" != "\$new_bin" \] && \[ "\$current_bin" != "\$global_bin_path" \]; then/);
  assert.match(scriptText, /if \[ -n "\$current_short_bin" \] && \[ "\$current_short_bin" != "\$new_bin" \] && \[ "\$current_short_bin" != "\$global_short_bin_path" \]; then/);
  assert.match(scriptText, /current_wrapper_payload=\$\(printf '%s\\n' '#!\/bin\/sh' "exec node \\"\$new_bin\\" \\"\\\$@\\"" \)/);
  assert.match(scriptText, /current_wrapper_payload=\$\(printf '%s\\n' '#!\/bin\/sh' "exec \\"\$new_bin\\" \\"\\\$@\\"" \)/);
  assert.match(scriptText, /printf "%s\\n" "\$current_wrapper_payload" > "\$current_bin"/);
  assert.match(scriptText, /current_short_wrapper_payload=\$\(printf '%s\\n' '#!\/bin\/sh' "exec node \\"\$new_bin\\" \\"\\\$@\\"" \)/);
  assert.match(scriptText, /current_short_wrapper_payload=\$\(printf '%s\\n' '#!\/bin\/sh' "exec \\"\$new_bin\\" \\"\\\$@\\"" \)/);
  assert.match(scriptText, /printf "%s\\n" "\$current_short_wrapper_payload" > "\$current_short_bin"/);
  assert.match(scriptText, /printf "%s\\n" "\$current_wrapper_payload" \| sudo tee "\$current_bin" >\/dev\/null/);
  assert.match(scriptText, /printf "%s\\n" "\$current_short_wrapper_payload" \| sudo tee "\$current_short_bin" >\/dev\/null/);
  assert.match(scriptText, /sudo rm -f \"\$installed_bin\"/);
  assert.match(scriptText, /cleanup_global_service_port "\$\{PORT:-7045\}"/);
  assert.match(scriptText, /post_update_check\(\) \{/);
  assert.match(scriptText, /if ! post_update_check; then\n\s+rollback_and_exit "post-update smoke test failed for \$target_version"/);
  assert.match(scriptText, /printf "__LLMPROXY_ROLLBACK__=1\\n"/);
  assert.match(scriptText, /printf "__LLMPROXY_ROLLBACK_VERSION__=%s\\n" "\$restored_version"/);
  assert.match(scriptText, /printf "__LLMPROXY_ROLLBACK_REASON__=%s\\n" "\$rollback_reason"/);
  assert.match(scriptText, /release_notes_output=\$\(run_new_llmproxy release-notes --version "\$version_output"/);
});

test("buildPersistentInstallScript includes sudo-to-user D-Bus delegation on Linux", () => {
  const installScript = buildPersistentInstallScript({
    packageRoot: "/tmp/pkg",
    locale: "it",
    platform: "linux",
  });
  assert.match(installScript, /used_sudo=0/);
  assert.match(installScript, /if sudo npm install -g/);
  assert.match(installScript, /used_sudo=1/);
  assert.match(installScript, /cleanup_global_service_port\(\) \{/);
  assert.match(installScript, /ensure_runtime_home_permissions\(\) \{/);
  assert.match(installScript, /cleanup_global_service_port "\$\{PORT:-7045\}"/);
  assert.match(installScript, /touch "\$runtime_home\/logs\/service\.out\.log" "\$runtime_home\/logs\/service\.err\.log" "\$runtime_home\/logs\/metering\.jsonl"/);
  assert.match(installScript, /sudo chown -R "\$runtime_owner":"\$runtime_owner" "\$runtime_home" >\/dev\/null 2>&1 \|\| true/);
  assert.match(installScript, /ensure_runtime_home_permissions "\$LLMPROXY_HOME" "\$runtime_owner"/);
  assert.match(installScript, /if \[ "\$used_sudo" -eq 1 \] && \[ "\$platform" = "linux" \] && \[ -n "\$\{SUDO_USER:-\}" \] && command -v sudo >\/dev\/null 2>&1; then\n\s+sudo -u "\$SUDO_USER" XDG_RUNTIME_DIR="\/run\/user\/\$\(id -u "\$SUDO_USER"\)" DBUS_SESSION_BUS_ADDRESS="unix:path=\/run\/user\/\$\(id -u "\$SUDO_USER"\)\/bus" LLMPROXY_MODE="standalone" LLMPROXY_SERVICE_RUNTIME="native" "\$global_bin" service:start/);
  assert.match(installScript, /else\n\s+LLMPROXY_MODE="standalone" LLMPROXY_SERVICE_RUNTIME="native" "\$global_bin" service:start\nfi/);
});

test("buildPersistentInstallScript includes used_sudo path for update service:restart after sudo install", () => {
  const script = buildPersistentInstallScript({
    packageRoot: "/tmp/pkg",
    locale: "en",
    platform: "linux",
  });
  assert.match(script, /used_sudo=0/);
  assert.match(script, /if sudo npm install -g/);
  assert.match(script, /used_sudo=1/);
  assert.match(script, /sudo -u "\$SUDO_USER"/);
});

test("buildPersistentInstallScript persists home-local npm bins in login shell profiles", () => {
  const script = buildPersistentInstallScript({
    packageRoot: "/tmp/pkg",
    locale: "en",
    platform: "linux",
  });
  assert.match(script, /append_path_export_once\(\) \{/);
  assert.match(script, /persist_user_npm_bin_path\(\) \{/);
  assert.match(script, /append_path_export_once "\$HOME\/\.profile" "\$bin_dir"/);
  assert.match(script, /append_path_export_once "\$HOME\/\.bash_profile" "\$bin_dir"/);
  assert.match(script, /append_path_export_once "\$HOME\/\.zprofile" "\$bin_dir"/);
  assert.match(script, /persist_user_npm_bin_path "\$npm_prefix"/);
});

test("one-line installer reaps the global service port before starting llmproxy", () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "scripts", "install.sh"), "utf8");
  assert.match(installer, /cleanup_global_service_port\(\) \{/);
  assert.match(installer, /cleanup_global_service_port "\$\{PORT:-7045\}"/);
});

test("persistent install script also cleans and preserves the llmp alias", () => {
  const script = buildPersistentInstallScript({
    packageRoot: "/tmp/pkg",
    locale: "en",
    platform: "linux",
  });
  assert.match(script, /for candidate in \$\( \(which -a llmproxy 2>\/dev\/null; which -a llmp 2>\/dev\/null\) \| awk '!seen\[\$0\]\+\+'\); do/);
  assert.match(script, /existing_bins=\$\( \(which -a llmproxy 2>\/dev\/null; which -a llmp 2>\/dev\/null\) \| awk '!seen\[\$0\]\+\+'\)/);
  assert.match(script, /rm -f "\$pnpm_home\/bin\/llmp"/);
  assert.match(script, /global_short_bin="\$npm_prefix\/bin\/llmp"/);
  assert.match(script, /if \[ -n "\$installed_bin" \] && \[ "\$installed_bin" != "\$global_bin" \] && \[ "\$installed_bin" != "\$global_short_bin" \]; then/);
});

test("update keeps success when package install succeeds but service restart fails", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-restart-warning-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
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

test("config:migrate rewrites legacy project and service variables to the current schema", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-migrate-"));
  const projectRoot = path.join(runtimeRoot, "workspace");
  const homeDir = path.join(runtimeRoot, "home");
  const stdout = createWritableBuffer();
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLM_STATS_API_KEY: "sk-legacy",
      LLMPROXY_SMART_ROUTE: "hybrid",
    },
  }, null, 2));
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      LLM_STATS_API_KEY: "sk-global-legacy",
      LLMPROXY_SMART_PREFERENCE: "balanced",
    },
  }, null, 2));
  fs.mkdirSync(path.join(runtimeRoot, "service"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "service", "config.json"), JSON.stringify({
    env: {
      LLMPROXY_MONGODB_URI: "mongodb://mongo:27017/llmProxy",
      LLMPROXY_METERING_SINK: "dblayer",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "config:migrate"], {
    cwd: projectRoot,
    dataRoot: runtimeRoot,
    env: { ...process.env, HOME: homeDir },
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Config migration completed: project, global, service/);

  const projectPayload = JSON.parse(fs.readFileSync(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  const globalPayload = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"));
  const servicePayload = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "service", "config.json"), "utf8"));
  assert.equal(projectPayload.env.LLMPROXY_LLM_STATS_API_KEY, "sk-legacy");
  assert.equal("LLM_STATS_API_KEY" in projectPayload.env, false);
  assert.equal("LLMPROXY_SMART_ROUTE" in projectPayload.env, false);
  assert.equal(globalPayload.env.LLMPROXY_LLM_STATS_API_KEY, "sk-global-legacy");
  assert.equal("LLMPROXY_SMART_PREFERENCE" in globalPayload.env, false);
  assert.equal(servicePayload.env.LLMPROXY_MONGODB_CONNECTION_STRING, "mongodb://mongo:27017/llmProxy");
  assert.equal("LLMPROXY_METERING_SINK" in servicePayload.env, false);
});

test("config:migrate rewrites the global Claude settings even when cwd has no local .claude folder", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-config-migrate-global-"));
  const homeDir = path.join(runtimeRoot, "home");
  const cwd = path.join(runtimeRoot, "plain-dir");
  const stdout = createWritableBuffer();
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      LLM_STATS_API_KEY: "sk-global-only",
      LLMPROXY_SMART_ROUTE: "hybrid",
    },
  }, null, 2));

  const exitCode = await runCli(["node", "llmproxy", "config:migrate"], {
    cwd,
    dataRoot: runtimeRoot,
    env: { ...process.env, HOME: homeDir },
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Config migration completed: global/);

  const globalPayload = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"));
  assert.equal(globalPayload.env.LLMPROXY_LLM_STATS_API_KEY, "sk-global-only");
  assert.equal("LLM_STATS_API_KEY" in globalPayload.env, false);
  assert.equal("LLMPROXY_SMART_ROUTE" in globalPayload.env, false);
});

test("update reports rollback details when the installed build fails post-update verification", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-rollback-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    stderr,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner() {
      return {
        status: 0,
        stdout: [
          "__LLMPROXY_ROLLBACK__=1",
          "__LLMPROXY_ROLLBACK_VERSION__=0.2.77",
          "__LLMPROXY_ROLLBACK_REASON__=post-update smoke test failed for 0.3.01",
          "",
        ].join("\n"),
        stderr: "",
      };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Aggiornamento fallito dopo l'installazione/);
  assert.match(stderr.toString(), /Motivo rollback: post-update smoke test failed for 0\.3\.01/);
  assert.match(stderr.toString(), /Versione ripristinata: 0\.2\.77/);
});

test("update prints changelog notes for known versions", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-notes-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
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
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner() {
      return { status: 0, stdout: "changed 10 packages in 1s\n__LLMPROXY_VERSION__=0.2.57\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 0\.2\.57:/);
  assert.match(stdout.toString(), /profilo runtime esplicito/i);
});

test("update exits early when the installed version already matches the online version", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-update-up-to-date-"));
  const stdout = createWritableBuffer();
  const currentVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  let commandRunnerCalled = false;

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    packageRoot: "/Users/alessiobacin/Development/llmProxy",
    stdout,
    fetchFn: async (url) => {
      assert.match(String(url), /raw\.githubusercontent\.com\/alessiobacin\/llmProxy\/main\/package\.json/);
      return {
        ok: true,
        status: 200,
        async json() {
          return { version: currentVersion };
        },
      };
    },
    commandRunner() {
      commandRunnerCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(commandRunnerCalled, false);
  assert.equal(stdout.toString(), `Gia' aggiornato. Versione corrente: ${currentVersion}\n`);
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
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
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
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
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
    fetchFn: async () => ({ ok: true, status: 200, async json() { return { version: "9.9.9" }; } }),
    commandRunner() {
      return { status: 0, stdout: "changed 82 packages in 2s\n__LLMPROXY_VERSION__=9.9.9\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Changelog 9\.9\.9:/);
  assert.match(stdout.toString(), /Note di rilascio non disponibili/);
});

test("uninstall stops service, removes service file, data dir, and npm/pnpm global installs", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-pkg-")), "node_modules", "llmproxy");
  fs.mkdirSync(packageRoot, { recursive: true });
  const serviceFile = path.join(runtimeRoot, "com.llmproxy.service.plist");
  fs.writeFileSync(serviceFile, "<plist></plist>");
  const dataSubDir = path.join(runtimeRoot, "logs");
  fs.mkdirSync(dataSubDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "copilot-token.json"), "{}");
  fs.writeFileSync(path.join(dataSubDir, "service.out.log"), "log");
  const stdout = createWritableBuffer();
  const executed = [];
  let serviceStopped = false;

  const exitCode = await runCli(["node", "llmproxy", "uninstall"], {
    dataRoot: runtimeRoot,
    packageRoot,
    stdout,
    platform: "darwin",
    serviceManager: {
      kind: "launchd",
      serviceFile,
      stop() {
        serviceStopped = true;
        return { ok: true, stdout: "", stderr: "" };
      },
    },
    commandRunner(command, args) {
      executed.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(serviceStopped, true);
  assert.equal(fs.existsSync(serviceFile), false, "service plist should be removed");
  assert.equal(fs.existsSync(runtimeRoot), false, "data root should be removed");
  const bashCall = executed.find(([cmd]) => cmd === "bash");
  assert.ok(bashCall, "bash uninstall script should run");
  assert.match(bashCall[1][1], /npm uninstall -g llmproxy/);
  assert.match(bashCall[1][1], /pnpm remove -g llmproxy/);
  assert.match(bashCall[1][1], /rm -f "\$npm_prefix\/bin\/llmp"/);
  assert.match(bashCall[1][1], /rm -f "\$pnpm_home\/bin\/llmp"/);
  assert.match(stdout.toString(), /Disinstallazione completata/);
});

test("uninstall removes docker containers when docker managed runtime", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-docker-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-docker-pkg-")), "node_modules", "llmproxy");
  fs.mkdirSync(packageRoot, { recursive: true });
  const composeFile = path.join(packageRoot, "docker-compose.production.yml");
  fs.writeFileSync(composeFile, "version: '3'");
  const serviceFile = path.join(runtimeRoot, "com.llmproxy.service.plist");
  fs.writeFileSync(serviceFile, "<plist></plist>");
  const stdout = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "uninstall"], {
    dataRoot: runtimeRoot,
    packageRoot,
    stdout,
    platform: "darwin",
    env: { LLMPROXY_ENV: "production", LLMPROXY_SERVICE_RUNTIME: "docker" },
    serviceManager: {
      kind: "launchd",
      serviceFile,
      stop() {
        return { ok: true, stdout: "", stderr: "" };
      },
    },
    commandRunner(command, args) {
      executed.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  const dockerComposeCall = executed.find(([_cmd, args]) =>
    args && args.includes("down"),
  );
  assert.ok(dockerComposeCall, "docker compose down should be called");
  assert.equal(fs.existsSync(runtimeRoot), false, "data root should be removed");
  assert.match(stdout.toString(), /Disinstallazione completata/);
});

test("uninstall on linux stops systemd service and removes unit file", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-linux-"));
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-linux-pkg-")), "node_modules", "llmproxy");
  fs.mkdirSync(packageRoot, { recursive: true });
  const serviceFile = path.join(runtimeRoot, "llmproxy.service");
  fs.writeFileSync(serviceFile, "[Unit]\nDescription=test");
  const stdout = createWritableBuffer();
  let serviceStopped = false;

  const exitCode = await runCli(["node", "llmproxy", "uninstall"], {
    dataRoot: runtimeRoot,
    packageRoot,
    stdout,
    platform: "linux",
    serviceManager: {
      kind: "systemd",
      serviceFile,
      stop() {
        serviceStopped = true;
        return { ok: true, stdout: "", stderr: "" };
      },
    },
    commandRunner() {
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(serviceStopped, true);
  assert.equal(fs.existsSync(serviceFile), false, "systemd unit file should be removed");
  assert.equal(fs.existsSync(runtimeRoot), false, "data root should be removed");
  assert.match(stdout.toString(), /Disinstallazione completata/);
});

test("uninstall on windows removes the service and all npm wrappers", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-windows-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-uninstall-windows-pkg-"));
  const stdout = createWritableBuffer();
  let serviceStopped = false;
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "uninstall"], {
    dataRoot: runtimeRoot,
    packageRoot,
    stdout,
    platform: "win32",
    serviceManager: {
      kind: "windows",
      stop() {
        serviceStopped = true;
        return { ok: true, stdout: "", stderr: "" };
      },
    },
    commandRunner(command, args) {
      executed.push([command, args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(serviceStopped, true);
  const powershellCall = executed.find(([cmd]) => cmd === "powershell.exe");
  assert.ok(powershellCall, "powershell uninstall script should run");
  assert.match(powershellCall[1][2], /llmproxy\.cmd/);
  assert.match(powershellCall[1][2], /llmproxy\.ps1/);
  assert.match(powershellCall[1][2], /llmp\.cmd/);
  assert.match(powershellCall[1][2], /llmp\.ps1/);
  assert.match(stdout.toString(), /Disinstallazione completata/);
});

test("provider:add allows multiple entries of the same provider with different models", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-multi-model-"));
  const stdout = createWritableBuffer();
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return { id: "ok" }; } });

  // First: add deepseek-v4-flash
  const exitCode1 = await runCli(["node", "llmproxy", "provider:add", "deepseek", "--api-key", "sk-ds-test", "--model", "deepseek-v4-flash", "--vision", "false"], {
    dataRoot: runtimeRoot,
    stdout,
    fetchFn,
  });

  // Second: add deepseek-v4-pro — must NOT overwrite the first
  const stdout2 = createWritableBuffer();
  const exitCode2 = await runCli(["node", "llmproxy", "provider:add", "deepseek", "--api-key", "sk-ds-test", "--model", "deepseek-v4-pro", "--vision", "false"], {
    dataRoot: runtimeRoot,
    stdout: stdout2,
    fetchFn,
  });

  const tokenStore = require("../lib/token-store").createTokenStore({ filePath: path.join(runtimeRoot, "copilot-token.json") });
  const allProviders = tokenStore.listProviders();

  assert.equal(exitCode1, 0);
  assert.equal(exitCode2, 0);
  assert.equal(allProviders.length, 2);
  assert.equal(allProviders[0].provider, "deepseek");
  assert.equal(allProviders[1].provider, "deepseek");

  const models = allProviders.map((p) => p.default_model).sort();
  assert.deepEqual(models, ["deepseek-v4-flash", "deepseek-v4-pro"]);

  // The second entry should have a model-derived ID
  assert.match(stdout.toString(), /deepseek-v4-flash/);
  assert.match(stdout2.toString(), /deepseek-v4-pro/);
});
