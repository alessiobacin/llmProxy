const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { detectProjectContext, resolveProjectMetadata, resolveClaudeProjectSettings } = require("../lib/project-context");

test("detectProjectContext prefers explicit header project path", () => {
  const result = detectProjectContext({
    headers: { "x-project-path": "/tmp/workspace-a" },
    body: {
      metadata: { project_path: "/tmp/workspace-b" },
      system: "Primary working directory: /tmp/workspace-c",
    },
  });

  assert.equal(result.projectPath, "/tmp/workspace-a");
  assert.equal(result.source, "header");
});

test("detectProjectContext extracts path from system prompt when headers are missing", () => {
  const result = detectProjectContext({
    headers: {},
    body: {
      system: [
        {
          type: "text",
          text: "Primary working directory: /Users/example/project-alpha\nOther info",
        },
      ],
    },
  });

  assert.equal(result.projectPath, "/Users/example/project-alpha");
  assert.equal(result.source, "system");
});

test("resolveProjectMetadata reads the nearest package.json name from the project tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-project-context-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "yt-monitor" }, null, 2));

  const result = resolveProjectMetadata(nestedDir);

  assert.equal(result.projectName, "yt-monitor");
  assert.equal(result.projectNameSource, "package.json");
});

test("resolveClaudeProjectSettings reads the configured model from the nearest Claude settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      ANTHROPIC_DEFAULT_MODEL: "gpt-5.4",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.configuredModel, "gpt-5.4");
  assert.equal(result.configuredModelSource, "settings.json");
});

test("resolveClaudeProjectSettings prefers the top-level Claude model when present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-model-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "gpt-5.3-codex",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      ANTHROPIC_DEFAULT_MODEL: "gpt-5.4",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.configuredModel, "gpt-5.3-codex");
  assert.equal(result.configuredModelSource, "settings.json:model");
});

test("resolveClaudeProjectSettings gives precedence to ANTHROPIC_DEFAULT_MODEL even when model is llmProxy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-proxy-label-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      ANTHROPIC_DEFAULT_MODEL: "copilot:gpt-5.4,kimi:kimi-k2.5",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.configuredModel, "copilot:gpt-5.4,kimi:kimi-k2.5");
  assert.equal(result.configuredModelSource, "settings.json");
  assert.equal(result.proxyControlsModel, false);
});

test("resolveClaudeProjectSettings treats llm-proxy as a proxy-controlled model label", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-proxy-kebab-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llm-proxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.configuredModel, null);
  assert.equal(result.configuredModelSource, "settings.json:model");
  assert.equal(result.proxyControlsModel, true);
});

test("resolveClaudeProjectSettings reads shortAnswer from Claude env when using local proxy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-short-answer-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_SHORT_ANSWER: "1",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.shortAnswer, true);
});

test("resolveClaudeProjectSettings reads LLMPROXY_METERING_INLINE from Claude env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-inline-metering-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_METERING_INLINE: "1",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.inlineMetering, true);
});

test("resolveClaudeProjectSettings reads LLMPROXY_INFERENCE_INFO_INLINE from Claude env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-inline-inference-info-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_INFERENCE_INFO_INLINE: "1",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.inlineInferenceInfo, true);
});

test("resolveClaudeProjectSettings defaults missing boolean flags in Claude env to false", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-boolean-defaults-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "packages", "api");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.inlineMetering, false);
  assert.equal(result.inlineInferenceInfo, false);
  assert.equal(result.shortAnswer, false);
});

test("resolveClaudeProjectSettings reads LLMPROXY_SMART_ROUTE from env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-smart-route-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "src");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_SMART_ROUTE: "hybrid",
      LLMPROXY_SMART_PREFERENCE: "economy",
      LLMPROXY_SMART_CACHE_TTL: "600000",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.smartRoute, "hybrid");
  assert.equal(result.smartPreference, "economy");
  assert.equal(result.smartCacheTtl, 600000);
});

test("resolveClaudeProjectSettings returns null smartRoute when env var not set", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-no-smart-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "src");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:7045" },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.smartRoute, null);
  assert.equal(result.smartPreference, "balanced");
  assert.equal(result.smartCacheTtl, 300000);
});

test("resolveClaudeProjectSettings validates smart route mode values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-claude-settings-smart-invalid-"));
  const projectRoot = path.join(root, "workspace");
  const nestedDir = path.join(projectRoot, "src");
  const claudeDir = path.join(projectRoot, ".claude");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLMPROXY_SMART_ROUTE: "invalid-mode",
    },
  }, null, 2));

  const result = resolveClaudeProjectSettings(nestedDir);

  assert.equal(result.smartRoute, null, "invalid mode must be rejected");
});
