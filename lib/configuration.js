"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_SPECS = [
  // Project-scope — effetto immediato, nessun restart
  { key: "ANTHROPIC_BASE_URL",                  scope: "project", restartRequired: false, hotReloadable: true },
  { key: "ANTHROPIC_DEFAULT_MODEL",             scope: "project", restartRequired: false, hotReloadable: true },
  { key: "ANTHROPIC_AUTH_TOKEN",                scope: "project", restartRequired: false, hotReloadable: true },
  { key: "API_TIMEOUT_MS",                      scope: "project", restartRequired: false, hotReloadable: true },
  { key: "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SHORT_ANSWER",               scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SMART_ROUTE",                scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SMART_PREFERENCE",           scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SMART_CACHE_TTL",            scope: "project", restartRequired: false, hotReloadable: true },

  // Service-scope — infrastrutturali, richiedono restart del servizio
  { key: "PORT",                                scope: "service", restartRequired: true, hotReloadable: false },
  { key: "HOST",                                scope: "service", restartRequired: true, hotReloadable: false },
  { key: "NODE_ENV",                            scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_ENV",                        scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_RUNTIME_PROFILE",            scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_MODE",                       scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_LOG_RETENTION_DAYS",         scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_LOG_MAX_BYTES",              scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_LOG_MAX_FILES",              scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_METERING_SINK",              scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_METERING_INLINE",            scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_MONGODB_URI",                scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_MONGODB_DB",                 scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_MONGODB_METERING_COLLECTION", scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_SECRET",                     scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_GLOBAL_SERVICE",             scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_SERVICE_RUNTIME",            scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_DOCKER_COMPOSE_FILE",        scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_DOCKER_SERVICE",             scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_DOCKER_POLL_MS",             scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLM_STATS_API_KEY",                   scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_HOME",                       scope: "service", restartRequired: true, hotReloadable: false },

  // Service-scope — hot-reloadable (riconfigurabili a runtime senza restart)
  { key: "DBLAYER_URL",                         scope: "service", restartRequired: false, hotReloadable: true },
  { key: "EVENTBUS_URL",                        scope: "service", restartRequired: false, hotReloadable: true },
  { key: "SENDGRID_API_KEY",                    scope: "service", restartRequired: false, hotReloadable: true },
  { key: "SENDGRID_FROM_EMAIL",                 scope: "service", restartRequired: false, hotReloadable: true },
  { key: "SENDGRID_TO_EMAIL",                   scope: "service", restartRequired: false, hotReloadable: true },
];

const CONFIG_SPEC_MAP = new Map(CONFIG_SPECS.map((spec) => [spec.key, Object.freeze({ ...spec })]));

function isRestartRequired(key) {
  const spec = getConfigSpec(key);
  return spec ? spec.restartRequired : null;
}

function isHotReloadable(key) {
  const spec = getConfigSpec(key);
  return spec ? spec.hotReloadable : null;
}

function getAllConfigSpecs() {
  return CONFIG_SPECS.map((spec) => ({ ...spec }));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeScope(scope) {
  const normalized = String(scope || "").trim().toLowerCase();
  if (normalized === "project" || normalized === "service") return normalized;
  return "";
}

function listConfigSpecs() {
  return getAllConfigSpecs();
}

function getConfigSpec(key) {
  return CONFIG_SPEC_MAP.get(String(key || "").trim()) || null;
}

function inferScopeFromKey(key, explicitScope) {
  const normalizedScope = normalizeScope(explicitScope);
  const spec = getConfigSpec(key);
  if (!spec) {
    throw new Error(`Variabile non supportata: ${key}`);
  }
  if (!normalizedScope) return spec.scope;
  if (normalizedScope !== spec.scope) {
    throw new Error(`La variabile ${spec.key} appartiene allo scope ${spec.scope}, non ${normalizedScope}`);
  }
  return normalizedScope;
}

function resolveProjectRoot(cwd) {
  return path.resolve(String(cwd || process.cwd()));
}

function getClaudeSettingsFile(cwd) {
  return path.join(resolveProjectRoot(cwd), ".claude", "settings.json");
}

function readClaudeSettings(cwd) {
  const settingsFile = getClaudeSettingsFile(cwd);
  return {
    settingsFile,
    config: readJsonFile(settingsFile) || {},
  };
}

function writeClaudeSettings(cwd, config) {
  writeJsonFile(getClaudeSettingsFile(cwd), config);
}

function readServiceConfig(filePath) {
  const payload = readJsonFile(filePath);
  const env = payload?.env && typeof payload.env === "object" && !Array.isArray(payload.env)
    ? payload.env
    : {};
  return { env: { ...env } };
}

function writeServiceConfig(filePath, payload) {
  const env = payload?.env && typeof payload.env === "object" && !Array.isArray(payload.env)
    ? payload.env
    : {};
  writeJsonFile(filePath, { env });
}

function listScopeValues(options = {}) {
  const scope = normalizeScope(options.scope);
  if (scope === "project") {
    const { config } = readClaudeSettings(options.cwd);
    const env = config.env && typeof config.env === "object" ? config.env : {};
    return CONFIG_SPECS
      .filter((spec) => spec.scope === "project")
      .map((spec) => ({ key: spec.key, scope: spec.scope, value: Object.prototype.hasOwnProperty.call(env, spec.key) ? env[spec.key] : null }));
  }

  if (scope === "service") {
    const serviceConfig = readServiceConfig(options.serviceConfigFile);
    return CONFIG_SPECS
      .filter((spec) => spec.scope === "service")
      .map((spec) => ({
        key: spec.key,
        scope: spec.scope,
        value: Object.prototype.hasOwnProperty.call(serviceConfig.env, spec.key) ? serviceConfig.env[spec.key] : null,
      }));
  }

  const projectValues = listScopeValues({ ...options, scope: "project" });
  const serviceValues = listScopeValues({ ...options, scope: "service" });
  return [...projectValues, ...serviceValues];
}

function getScopeValue(options = {}) {
  const key = String(options.key || "").trim();
  if (!key) throw new Error("Variabile richiesta");
  const scope = inferScopeFromKey(key, options.scope);
  const values = listScopeValues({ ...options, scope });
  const entry = values.find((candidate) => candidate.key === key);
  return entry || { key, scope, value: null };
}

function setScopeValue(options = {}) {
  const key = String(options.key || "").trim();
  if (!key) throw new Error("Variabile richiesta");
  const value = options.value == null ? "" : String(options.value);
  const scope = inferScopeFromKey(key, options.scope);

  if (scope === "project") {
    const { config } = readClaudeSettings(options.cwd);
    const nextEnv = config.env && typeof config.env === "object" ? { ...config.env } : {};
    nextEnv[key] = value;
    writeClaudeSettings(options.cwd, { ...config, env: nextEnv });
    return { key, scope, value };
  }

  const serviceConfig = readServiceConfig(options.serviceConfigFile);
  serviceConfig.env[key] = value;
  writeServiceConfig(options.serviceConfigFile, serviceConfig);
  return { key, scope, value };
}

function unsetScopeValue(options = {}) {
  const key = String(options.key || "").trim();
  if (!key) throw new Error("Variabile richiesta");
  const scope = inferScopeFromKey(key, options.scope);

  if (scope === "project") {
    const { config } = readClaudeSettings(options.cwd);
    const nextEnv = config.env && typeof config.env === "object" ? { ...config.env } : {};
    delete nextEnv[key];
    const nextConfig = { ...config, env: nextEnv };
    writeClaudeSettings(options.cwd, nextConfig);
    return { key, scope, value: null };
  }

  const serviceConfig = readServiceConfig(options.serviceConfigFile);
  delete serviceConfig.env[key];
  writeServiceConfig(options.serviceConfigFile, serviceConfig);
  return { key, scope, value: null };
}

function resolveHomeDir(env = process.env) {
  return path.resolve(String(env.HOME || os.homedir()));
}

module.exports = {
  CONFIG_SPECS,
  getConfigSpec,
  listConfigSpecs,
  getAllConfigSpecs,
  isRestartRequired,
  isHotReloadable,
  inferScopeFromKey,
  readClaudeSettings,
  writeClaudeSettings,
  readServiceConfig,
  writeServiceConfig,
  listScopeValues,
  getScopeValue,
  setScopeValue,
  unsetScopeValue,
  getClaudeSettingsFile,
  resolveHomeDir,
};
