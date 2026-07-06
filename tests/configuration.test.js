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
  getProjectDefaultValues,
  getServiceDefaultValues,
  isRestartRequired,
  isHotReloadable,
  migrateManagedConfig,
  normalizeClaudeSettingsConfig,
  normalizeServiceConfigPayload,
  listGlobalProjectValues,
  listScopeValues,
  setScopeValue,
  getScopeValue,
  unsetScopeValue,
  getGlobalClaudeSettingsFile,
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
  assert.ok(CONFIG_SPECS.length >= 28, `expected >=28 specs, got ${CONFIG_SPECS.length}`);
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

test("getConfigSpec exposes price/performance routing project variables", () => {
  const routingSpec = getConfigSpec("LLMPROXY_PRICE_PERFORMANCE_ROUTING");
  const tieBreakerSpec = getConfigSpec("LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER");
  const autoEscalateSpec = getConfigSpec("LLMPROXY_AUTO_ESCALATE");
  const meteringInlineSpec = getConfigSpec("LLMPROXY_METERING_INLINE");
  assert.equal(routingSpec.scope, "project");
  assert.equal(routingSpec.hotReloadable, true);
  assert.equal(tieBreakerSpec.scope, "project");
  assert.equal(tieBreakerSpec.restartRequired, false);
  assert.equal(autoEscalateSpec.scope, "project");
  assert.equal(meteringInlineSpec.scope, "project");
});

test("getConfigSpec for LLMPROXY_SENDGRID_API_KEY", () => {
  const spec = getConfigSpec("LLMPROXY_SENDGRID_API_KEY");
  assert.equal(spec.scope, "project");
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

test("listScopeValues inherits global Claude project defaults when local override is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-config-global-fallback-"));
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

  const values = listScopeValues({
    scope: "project",
    cwd: projectRoot,
    env: { ...process.env, HOME: homeDir },
    serviceConfigFile: path.join(tmpDir, "service", "config.json"),
  });

  const statsKey = values.find((entry) => entry.key === "LLMPROXY_LLM_STATS_API_KEY");
  const shortAnswer = values.find((entry) => entry.key === "LLMPROXY_SHORT_ANSWER");
  assert.equal(statsKey.value, "sk-global-demo");
  assert.equal(statsKey.source, "global");
  assert.equal(shortAnswer.value, "1");
  assert.equal(shortAnswer.source, "global");
});

test("getScopeValue returns the effective global Claude fallback for project-scope variables", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-config-get-global-fallback-"));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "workspace");
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    env: {
      LLMPROXY_LLM_STATS_API_KEY: "sk-global-demo",
    },
  }, null, 2));

  const entry = getScopeValue({
    key: "LLMPROXY_LLM_STATS_API_KEY",
    scope: "project",
    cwd: projectRoot,
    env: { ...process.env, HOME: homeDir },
    serviceConfigFile: path.join(tmpDir, "service", "config.json"),
  });

  assert.equal(entry.value, "sk-global-demo");
  assert.equal(entry.scope, "project");
  assert.equal(entry.source, "global");
});

test("listGlobalProjectValues exposes the user-level Claude defaults separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-config-global-view-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
    env: {
      LLMPROXY_LLM_STATS_API_KEY: "sk-global-demo",
    },
  }, null, 2));

  const values = listGlobalProjectValues({
    env: { ...process.env, HOME: homeDir },
    serviceConfigFile: path.join(tmpDir, "service", "config.json"),
    cwd: root,
  });

  const statsKey = values.find((entry) => entry.key === "LLMPROXY_LLM_STATS_API_KEY");
  assert.equal(statsKey.scope, "global");
  assert.equal(statsKey.value, "sk-global-demo");
  assert.equal(statsKey.source, "global");
});

test("setScopeValue writes global project-scope variables to the user's global Claude settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-config-global-set-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const result = setScopeValue({
    key: "LLMPROXY_LLM_STATS_API_KEY",
    value: "sk-global-demo",
    scope: "global",
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.scope, "global");
  const raw = JSON.parse(fs.readFileSync(getGlobalClaudeSettingsFile({ ...process.env, HOME: homeDir }), "utf8"));
  assert.equal(raw.env.LLMPROXY_LLM_STATS_API_KEY, "sk-global-demo");
});

test("unsetScopeValue removes global project-scope variables from the user's global Claude settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-config-global-unset-"));
  const homeDir = path.join(root, "home");
  const globalFile = getGlobalClaudeSettingsFile({ ...process.env, HOME: homeDir });
  fs.mkdirSync(path.dirname(globalFile), { recursive: true });
  fs.writeFileSync(globalFile, JSON.stringify({
    env: {
      LLMPROXY_LLM_STATS_API_KEY: "sk-global-demo",
    },
  }, null, 2));

  const result = unsetScopeValue({
    key: "LLMPROXY_LLM_STATS_API_KEY",
    scope: "global",
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.scope, "global");
  const raw = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  assert.equal("LLMPROXY_LLM_STATS_API_KEY" in (raw.env || {}), false);
});

test("getProjectDefaultValues returns llmproxy project defaults", () => {
  const defaults = getProjectDefaultValues({ cwd: tmpDir, serviceConfigFile: path.join(tmpDir, "service", "config.json") });
  assert.equal(defaults.LLMPROXY_AUTO_ESCALATE, "1");
  assert.equal(defaults.LLMPROXY_LLM_STATS_API_KEY, "");
  assert.equal(defaults.LLMPROXY_SENDGRID_API_KEY, "");
  assert.equal(defaults.LLMPROXY_SENDGRID_FROM_EMAIL, "");
  assert.equal(defaults.LLMPROXY_SENDGRID_TO_EMAIL, "");
  assert.equal(defaults.LLMPROXY_SENDGRID_TO_MESSAGE_TYPE, "service_unreachable,service_recovered,provider_error,auto_escalation,provider_credit_exhausted,service_update");
  assert.equal(defaults.LLMPROXY_INFERENCE_INFO_INLINE, "1");
  assert.equal(defaults.LLMPROXY_METERING_INLINE, "0");
  assert.equal(defaults.LLMPROXY_PRICE_PERFORMANCE_ROUTING, "1");
  assert.equal(defaults.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER, "power");
  assert.equal(defaults.LLMPROXY_PROVIDER_CREDIT_INLINE, "1");
  assert.equal(defaults.LLMPROXY_SHORT_ANSWER, "0");
});

test("getServiceDefaultValues returns effective service defaults", () => {
  const defaults = getServiceDefaultValues({
    env: {},
    packageRoot: tmpDir,
    dataRoot: tmpDir,
    serviceConfigFile: path.join(tmpDir, "service", "config.json"),
  });
  assert.equal(defaults.LLMPROXY_MODE, "standalone");
  assert.equal(defaults.LLMPROXY_MONGODB_CONNECTION_STRING, "");
  assert.equal(defaults.LLMPROXY_SERVICE_RUNTIME, "native");
  assert.equal(defaults.LLMPROXY_LOG_MAX_BYTES, "5242880");
});

test("normalizeClaudeSettingsConfig removes legacy project variables and injects current llmproxy defaults", () => {
  const normalized = normalizeClaudeSettingsConfig({
    model: "llmProxy",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7045",
      LLM_STATS_API_KEY: "sk-legacy",
      SENDGRID_API_KEY: "sg-legacy",
      SENDGRID_FROM_EMAIL: "from@example.com",
      SENDGRID_TO_EMAIL: "to@example.com",
      SENDGRID_TO_MESSAGE_TYPE: "provider_error",
      LLMPROXY_SMART_ROUTE: "hybrid",
      LLMPROXY_SMART_PREFERENCE: "balanced",
    },
  }, {
    cwd: tmpDir,
    serviceConfigFile: path.join(tmpDir, "service", "config.json"),
    injectDefaults: true,
  });

  assert.equal(normalized.env.LLMPROXY_LLM_STATS_API_KEY, "sk-legacy");
  assert.equal(normalized.env.LLMPROXY_SENDGRID_API_KEY, "sg-legacy");
  assert.equal(normalized.env.LLMPROXY_SENDGRID_FROM_EMAIL, "from@example.com");
  assert.equal(normalized.env.LLMPROXY_SENDGRID_TO_EMAIL, "to@example.com");
  assert.equal(normalized.env.LLMPROXY_SENDGRID_TO_MESSAGE_TYPE, "provider_error");
  assert.equal(normalized.env.LLMPROXY_PRICE_PERFORMANCE_ROUTING, "1");
  assert.equal(normalized.env.LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER, "power");
  assert.equal("LLM_STATS_API_KEY" in normalized.env, false);
  assert.equal("SENDGRID_API_KEY" in normalized.env, false);
  assert.equal("LLMPROXY_SMART_ROUTE" in normalized.env, false);
  assert.equal("LLMPROXY_SMART_PREFERENCE" in normalized.env, false);
});

test("normalizeServiceConfigPayload removes legacy service variables and migrates Mongo connection string", () => {
  const normalized = normalizeServiceConfigPayload(path.join(tmpDir, "service", "config.json"), {
    env: {
      PORT: "7045",
      HOST: "127.0.0.1",
      LLMPROXY_MODE: "standalone",
      LLMPROXY_SERVICE_RUNTIME: "native",
      LLMPROXY_METERING_SINK: "dblayer",
      LLMPROXY_MONGODB_URI: "mongodb://mongo:27017/llmProxy",
      LLMPROXY_MONGODB_DB: "llmProxy",
      LLMPROXY_MONGODB_METERING_COLLECTION: "metering",
      LLM_STATS_API_KEY: "sk-legacy",
      SENDGRID_API_KEY: "sg-legacy",
    },
  }, {
    injectDefaults: true,
  });

  assert.equal(normalized.env.LLMPROXY_MONGODB_CONNECTION_STRING, "mongodb://mongo:27017/llmProxy");
  assert.equal("LLMPROXY_METERING_SINK" in normalized.env, false);
  assert.equal("LLMPROXY_MONGODB_URI" in normalized.env, false);
  assert.equal("LLMPROXY_MONGODB_DB" in normalized.env, false);
  assert.equal("LLMPROXY_MONGODB_METERING_COLLECTION" in normalized.env, false);
  assert.equal("LLM_STATS_API_KEY" in normalized.env, false);
  assert.equal("SENDGRID_API_KEY" in normalized.env, false);
  assert.equal(normalized.env.LLMPROXY_LOG_MAX_FILES, "5");
});

test("migrateManagedConfig rewrites legacy project and service config in place", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-config-migrate-"));
  const projectRoot = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const serviceConfigFile = path.join(root, "service", "config.json");
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(path.dirname(serviceConfigFile), { recursive: true });
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
  fs.writeFileSync(serviceConfigFile, JSON.stringify({
    env: {
      LLMPROXY_MONGODB_URI: "mongodb://mongo:27017/llmProxy",
      LLMPROXY_METERING_SINK: "dblayer",
    },
  }, null, 2));

  const migrated = migrateManagedConfig({
    cwd: projectRoot,
    serviceConfigFile,
    env: { ...process.env, HOME: homeDir },
    packageRoot: path.join(__dirname, ".."),
    dataRoot: root,
  });

  assert.deepEqual(migrated, { project: true, global: true, service: true });

  const projectPayload = JSON.parse(fs.readFileSync(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  const globalPayload = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude", "settings.json"), "utf8"));
  const servicePayload = JSON.parse(fs.readFileSync(serviceConfigFile, "utf8"));
  assert.equal(projectPayload.env.LLMPROXY_LLM_STATS_API_KEY, "sk-legacy");
  assert.equal("LLMPROXY_SMART_ROUTE" in projectPayload.env, false);
  assert.equal(globalPayload.env.LLMPROXY_LLM_STATS_API_KEY, "sk-global-legacy");
  assert.equal("LLMPROXY_SMART_PREFERENCE" in globalPayload.env, false);
  assert.equal(servicePayload.env.LLMPROXY_MONGODB_CONNECTION_STRING, "mongodb://mongo:27017/llmProxy");
  assert.equal("LLMPROXY_METERING_SINK" in servicePayload.env, false);
});
