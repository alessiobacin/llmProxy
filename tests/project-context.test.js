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

test("resolveClaudeProjectSettings ignores proxy UI labels and defers model routing to the proxy", () => {
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

  assert.equal(result.configuredModel, null);
  assert.equal(result.configuredModelSource, "settings.json:model");
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
