const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runCli } = require("../lib/cli");

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
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3015");
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

test("install:persistent installs the current package globally and starts the persistent macOS service", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-macos-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();
  const commandCalls = [];

  const exitCode = await runCli(["node", "llmproxy", "install:persistent"], {
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

test("install:persistent prints linger guidance on Linux", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-linux-"));
  const stdout = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent"], {
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

test("install:persistent fails fast on unsupported platforms", async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-cli-install-persistent-win-"));
  const stdout = createWritableBuffer();
  const stderr = createWritableBuffer();

  const exitCode = await runCli(["node", "llmproxy", "install:persistent"], {
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
  assert.match(stdout.toString(), /llmproxy login\s+autentica GitHub Copilot/i);
  assert.match(stdout.toString(), /llmproxy update\s+scarica e installa l'ultima versione/i);
  assert.match(stdout.toString(), /llmproxy uninstall\s+rimuove l'installazione globale/i);
  assert.match(stdout.toString(), /llmproxy version\s+mostra la versione corrente/i);
  assert.match(stdout.toString(), /Problemi comuni:/);
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
      "set -e\ntmpdir=$(mktemp -d)\ncleanup() { rm -rf \"$tmpdir\"; }\ntrap cleanup EXIT\nexisting_bins=$(which -a llmproxy 2>/dev/null | awk '!seen[$0]++')\ngh repo clone alessiobacin/llmProxy \"$tmpdir/repo\" -- --depth=1 >/dev/null\ncd \"$tmpdir/repo\"\npnpm pack --pack-destination \"$tmpdir\" >/dev/null\npackage_file=$(find \"$tmpdir\" -maxdepth 1 -name \"*.tgz\" -print | head -n 1)\n[ -n \"$package_file\" ]\nnpm install -g \"$package_file\"\npnpm remove -g llmproxy >/dev/null 2>&1 || true\npnpm_root=$(pnpm root -g 2>/dev/null || true)\nif [ -n \"$pnpm_root\" ]; then\n  pnpm_home=$(dirname \"$(dirname \"$pnpm_root\")\")\n  rm -f \"$pnpm_home/bin/llmproxy\"\nfi\nnpm_prefix=$(npm prefix -g)\nnew_bin=\"$npm_prefix/bin/llmproxy\"\n[ -x \"$new_bin\" ]\nfor installed_bin in $existing_bins; do\n  if [ -n \"$installed_bin\" ] && [ \"$installed_bin\" != \"$new_bin\" ]; then\n    rm -f \"$installed_bin\"\n  fi\ndone\nversion_output=$(\"$new_bin\" version)\nprintf \"__LLMPROXY_VERSION__=%s\\n\" \"$version_output\"",
    ],
  ]]);
  assert.match(stdout.toString(), /Aggiornamento completato/);
  assert.match(stdout.toString(), /Versione corrente: 0\.1\.0/);
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
      "set -e\nnpm uninstall -g llmproxy >/dev/null 2>&1 || true\npnpm remove -g llmproxy >/dev/null 2>&1 || true\npnpm_root=$(pnpm root -g 2>/dev/null || true)\nif [ -n \"$pnpm_root\" ]; then\n  pnpm_home=$(dirname \"$(dirname \"$pnpm_root\")\")\n  rm -f \"$pnpm_home/bin/llmproxy\"\nfi",
    ],
  ]]);
  assert.match(stdout.toString(), /Disinstallazione completata/);
});