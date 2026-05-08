const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCli, resolveServiceEnvironment, resolveServiceEntryFile } = require("../lib/cli");

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
  assert.equal(settings.model, "claude-sonnet-4.5");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "proxy-local");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:5045");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_MODEL, "claude-sonnet-4.5");
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
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "proxy-local");
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
  assert.equal(settings.model, "claude-sonnet-4.5");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3015");
  assert.match(stdout.toString(), /http:\/\/127\.0\.0\.1:3015/);
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

test("provider:add supports api-key providers like openrouter", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-provider-apikey-"));
  const stdout = createWritableBuffer();
  const fetchFn = async () => ({ ok: true, status: 200, async json() { return {}; } });

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "openrouter", "--name", "OpenRouter", "--api-key", "sk-or-test", "--model", "openai/gpt-4o"], {
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

  const exitCode = await runCli(["node", "llmproxy", "provider:add", "openrouter", "--api-key", "sk-or-test", "--model", "bad-model"], {
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
  tokenStore.moveProvider("backup", 1);

  const exitCode = await runCli(["node", "llmproxy", "provider:status"], {
    dataRoot: runtimeRoot,
    stdout,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.toString(), /Active provider: backup/);
  assert.match(stdout.toString(), /1\. backup \(Backup\) \[active\]/);
  assert.match(stdout.toString(), /2\. primary \(Primary\)/);
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
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:5045/v1/messages");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["content-type"], "application/json");

  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 256);
  assert.equal(body.model, "claude-sonnet-4.5");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content[0].text, "Rispondi solo: llmproxy-test-auto");
  assert.match(stdout.toString(), /auto: ok \(claude-sonnet-4\.5\) ciao creatore/);
});

test("test probes every configured provider with its default model", async () => {
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
  assert.deepEqual(requestBodies.map((body) => [body.provider, body.model]), [["copilot", "gpt-5.4"], ["kimi", "kimi-k2.5"]]);
  assert.match(stdout.toString(), /copilot: ok \(gpt-5\.4\)/);
  assert.match(stdout.toString(), /kimi: ok \(kimi-k2\.5\)/);
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
  assert.notEqual(settings.env.ANTHROPIC_DEFAULT_MODEL, "");
  assert.match(stdout.toString(), /Default model:/);
  assert.match(stdout.toString(), new RegExp(settings.env.ANTHROPIC_DEFAULT_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
      ANTHROPIC_AUTH_TOKEN: "proxy-local",
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
  assert.equal(settings.model, "o3");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_MODEL, "o3");
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
  assert.match(stdout.toString(), /llmproxy update\s+scarica e installa l'ultima versione/i);
  assert.match(stdout.toString(), /llmproxy uninstall\s+rimuove l'installazione globale/i);
  assert.match(stdout.toString(), /llmproxy version\s+mostra la versione corrente/i);
  assert.match(stdout.toString(), /Problemi comuni:/);
});

test("package scripts expose install:persistent-it and install:persistent-en", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

  assert.equal(pkg.scripts["install:persistent-it"], "node bin/llmproxy.js install:persistent-it");
  assert.equal(pkg.scripts["install:persistent-en"], "node bin/llmproxy.js install:persistent-en");
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
  const stdout = createWritableBuffer();
  const executed = [];

  const exitCode = await runCli(["node", "llmproxy", "update"], {
    dataRoot: runtimeRoot,
    stdout,
    commandRunner(command, args) {
      executed.push([command, args]);
      return { status: 0, stdout: "changed 69 packages in 3s\n__LLMPROXY_VERSION__=0.1.0\n", stderr: "" };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(executed, [[
    "sh",
    [
      "-c",
      "set -e\ntmpdir=$(mktemp -d)\ncleanup() { rm -rf \"$tmpdir\"; }\ntrap cleanup EXIT\nexisting_bins=$(which -a llmproxy 2>/dev/null | awk '!seen[$0]++')\ngh repo clone alessiobacin/llmProxy \"$tmpdir/repo\" -- --depth=1 >/dev/null\ncd \"$tmpdir/repo\"\npnpm pack --pack-destination \"$tmpdir\" >/dev/null\npackage_file=$(find \"$tmpdir\" -maxdepth 1 -name \"*.tgz\" -print | head -n 1)\n[ -n \"$package_file\" ]\nif ! npm install -g \"$package_file\"; then\n  if command -v sudo >/dev/null 2>&1; then\n    sudo npm install -g \"$package_file\"\n  else\n    exit 1\n  fi\nfi\npnpm remove -g llmproxy >/dev/null 2>&1 || true\npnpm_root=$(pnpm root -g 2>/dev/null || true)\nif [ -n \"$pnpm_root\" ]; then\n  pnpm_home=$(dirname \"$(dirname \"$pnpm_root\")\")\n  rm -f \"$pnpm_home/bin/llmproxy\" >/dev/null 2>&1 || true\nfi\nnpm_prefix=$(npm prefix -g)\nnew_bin=\"$npm_prefix/bin/llmproxy\"\n[ -x \"$new_bin\" ]\nfor installed_bin in $existing_bins; do\n  if [ -n \"$installed_bin\" ] && [ \"$installed_bin\" != \"$new_bin\" ]; then\n    rm -f \"$installed_bin\" >/dev/null 2>&1 || true\n  fi\ndone\n\"$new_bin\" service:restart >/dev/null\ndocker_compose_file=\"$npm_prefix/lib/node_modules/llmproxy/docker-compose.production.yml\"\nif command -v docker >/dev/null 2>&1 && [ -f \"$docker_compose_file\" ]; then\n  if docker compose -f \"$docker_compose_file\" ps --services --status running 2>/dev/null | grep -qx \"llmproxy\"; then\n    docker compose -f \"$docker_compose_file\" up -d --build llmproxy >/dev/null || true\n  fi\nfi\nversion_output=$(\"$new_bin\" version)\nprintf \"__LLMPROXY_VERSION__=%s\\n\" \"$version_output\"",
    ],
  ]]);
  assert.match(stdout.toString(), /Aggiornamento completato/);
  assert.match(stdout.toString(), /Versione corrente: 0\.1\.0/);
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
    "sh",
    [
      "-c",
      "set -e\nnpm uninstall -g llmproxy >/dev/null 2>&1 || true\npnpm remove -g llmproxy >/dev/null 2>&1 || true\npnpm_root=$(pnpm root -g 2>/dev/null || true)\nif [ -n \"$pnpm_root\" ]; then\n  pnpm_home=$(dirname \"$(dirname \"$pnpm_root\")\")\n  rm -f \"$pnpm_home/bin/llmproxy\" >/dev/null 2>&1 || true\nfi",
    ],
  ]]);
  assert.match(stdout.toString(), /Disinstallazione completata/);
});
