"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  CONFIG_SPECS,
  getConfigSpec,
  listConfigSpecs,
  getAllConfigSpecs,
  isRestartRequired,
  isHotReloadable,
  setScopeValue,
  getScopeValue,
  unsetScopeValue,
} = require("../lib/configuration");

const tmpDir = path.join(os.tmpdir(), `llmproxy-config-test-${Date.now()}`);

test.before(() => {
  fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".claude", "settings.json"), "{}");
  fs.mkdirSync(path.join(tmpDir, "service"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "service", "config.json"), JSON.stringify({ env: {} }));
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── CONFIG_SPECS expansion ─────────────────────────────────────────────────

test("CONFIG_SPECS includes all expected variables", () => {
  assert.ok(CONFIG_SPECS.length >= 30, `expected >=30 specs, got ${CONFIG_SPECS.length}`);
});

test("getConfigSpec returns full metadata for DBLAYER_URL", () => {
  const spec = getConfigSpec("DBLAYER_URL");
  assert.equal(spec.key, "DBLAYER_URL");
  assert.equal(spec.scope, "service");
  assert.equal(spec.restartRequired, false);
  assert.equal(spec.hotReloadable, true);
});

test("getConfigSpec returns full metadata for PORT", () => {
  const spec = getConfigSpec("PORT");
  assert.equal(spec.restartRequired, true);
  assert.equal(spec.hotReloadable, false);
});

test("getConfigSpec returns null for unknown key", () => {
  assert.equal(getConfigSpec("NON_EXISTENT_VAR"), null);
});

test("getConfigSpec for project-scope variable", () => {
  const spec = getConfigSpec("ANTHROPIC_BASE_URL");
  assert.equal(spec.scope, "project");
  assert.equal(spec.restartRequired, false);
  assert.equal(spec.hotReloadable, true);
});

test("getConfigSpec for SENDGRID_API_KEY", () => {
  const spec = getConfigSpec("SENDGRID_API_KEY");
  assert.equal(spec.scope, "service");
  assert.equal(spec.restartRequired, false);
  assert.equal(spec.hotReloadable, true);
});

// ─── isRestartRequired / isHotReloadable ────────────────────────────────────

test("isRestartRequired returns true for PORT", () => {
  assert.equal(isRestartRequired("PORT"), true);
});

test("isRestartRequired returns false for DBLAYER_URL", () => {
  assert.equal(isRestartRequired("DBLAYER_URL"), false);
});

test("isRestartRequired returns null for unknown key", () => {
  assert.equal(isRestartRequired("UNKNOWN"), null);
});

test("isHotReloadable returns true for EVENTBUS_URL", () => {
  assert.equal(isHotReloadable("EVENTBUS_URL"), true);
});

test("isHotReloadable returns false for PORT", () => {
  assert.equal(isHotReloadable("PORT"), false);
});

// ─── getAllConfigSpecs ──────────────────────────────────────────────────────

test("getAllConfigSpecs returns a copy", () => {
  const all = getAllConfigSpecs();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 30);
  // Verify it's a shallow copy
  all.push({ key: "test", scope: "project", restartRequired: false, hotReloadable: false });
  assert.notEqual(CONFIG_SPECS.length, all.length);
});

// ─── listConfigSpecs ────────────────────────────────────────────────────────

test("listConfigSpecs returns all specs with metadata", () => {
  const list = listConfigSpecs();
  const dblayer = list.find((s) => s.key === "DBLAYER_URL");
  assert.ok(dblayer, "DBLAYER_URL should be in listConfigSpecs");
  assert.equal(dblayer.restartRequired, false);
  assert.equal(dblayer.hotReloadable, true);
});

// ─── setScopeValue / getScopeValue / unsetScopeValue (service-scope) ────────

test("setScopeValue writes service-scope variable to config.json", () => {
  const serviceConfigFile = path.join(tmpDir, "service", "config.json");
  const result = setScopeValue({
    key: "DBLAYER_URL",
    value: "http://localhost:9999",
    scope: "service",
    serviceConfigFile,
  });
  assert.equal(result.key, "DBLAYER_URL");
  assert.equal(result.value, "http://localhost:9999");
  assert.equal(result.scope, "service");

  const raw = JSON.parse(fs.readFileSync(serviceConfigFile, "utf8"));
  assert.equal(raw.env.DBLAYER_URL, "http://localhost:9999");
});

test("getScopeValue reads service-scope variable", () => {
  const serviceConfigFile = path.join(tmpDir, "service", "config.json");
  const entry = getScopeValue({
    key: "DBLAYER_URL",
    scope: "service",
    serviceConfigFile,
  });
  assert.equal(entry.value, "http://localhost:9999");
});

test("unsetScopeValue removes service-scope variable", () => {
  const serviceConfigFile = path.join(tmpDir, "service", "config.json");
  const result = unsetScopeValue({
    key: "DBLAYER_URL",
    scope: "service",
    serviceConfigFile,
  });
  assert.equal(result.value, null);

  const raw = JSON.parse(fs.readFileSync(serviceConfigFile, "utf8"));
  assert.equal(raw.env.DBLAYER_URL, undefined);
});

// ─── setScopeValue / getScopeValue (project-scope) ──────────────────────────

test("setScopeValue writes project-scope variable to .claude/settings.json", () => {
  const result = setScopeValue({
    key: "ANTHROPIC_BASE_URL",
    value: "http://localhost:7045",
    scope: "project",
    cwd: tmpDir,
  });
  assert.equal(result.scope, "project");
  assert.equal(result.value, "http://localhost:7045");

  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"));
  assert.equal(raw.env.ANTHROPIC_BASE_URL, "http://localhost:7045");
});

test("getScopeValue reads project-scope variable", () => {
  const entry = getScopeValue({
    key: "ANTHROPIC_BASE_URL",
    scope: "project",
    cwd: tmpDir,
  });
  assert.equal(entry.value, "http://localhost:7045");
});
