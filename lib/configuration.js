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
  { key: "LLMPROXY_LLM_STATS_API_KEY",          scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SENDGRID_API_KEY",           scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SENDGRID_FROM_EMAIL",        scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SENDGRID_TO_EMAIL",          scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE",   scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_METERING_INLINE",            scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_INFERENCE_INFO_INLINE",      scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_PROVIDER_CREDIT_INLINE",     scope: "project", restartRequired: false, hotReloadable: true },
  { key: "LLMPROXY_SHORT_ANSWER",               scope: "project", restartRequired: false, hotReloadable: true },

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
  { key: "LLMPROXY_MONGODB_CONNECTION_STRING",  scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_SECRET",                     scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_GLOBAL_SERVICE",             scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_SERVICE_RUNTIME",            scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_DOCKER_COMPOSE_FILE",        scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_DOCKER_SERVICE",             scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_DOCKER_POLL_MS",             scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_HOME",                       scope: "service", restartRequired: true, hotReloadable: false },
  { key: "LLMPROXY_REORDERING_MINUTES",         scope: "service", restartRequired: true, hotReloadable: false },

  // Service-scope — hot-reloadable (riconfigurabili a runtime senza restart)
  { key: "DBLAYER_URL",                         scope: "service", restartRequired: false, hotReloadable: true, hiddenInList: true },
  { key: "EVENTBUS_URL",                        scope: "service", restartRequired: false, hotReloadable: true, hiddenInList: true },
  { key: "LLMPROXY_REORDERING",                 scope: "service", restartRequired: false, hotReloadable: true },
];

const CONFIG_SPEC_MAP = new Map(CONFIG_SPECS.map((spec) => [spec.key, Object.freeze({ ...spec })]));
const LEGACY_PROJECT_ENV_MAPPINGS = Object.freeze({
  LLM_STATS_API_KEY: "LLMPROXY_LLM_STATS_API_KEY",
  SENDGRID_API_KEY: "LLMPROXY_SENDGRID_API_KEY",
  SENDGRID_FROM_EMAIL: "LLMPROXY_SENDGRID_FROM_EMAIL",
  SENDGRID_TO_EMAIL: "LLMPROXY_SENDGRID_TO_EMAIL",
  SENDGRID_TO_MESSAGE_TYPE: "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE",
});
const LEGACY_PROJECT_ENV_KEYS_TO_REMOVE = Object.freeze([
  "LLMPROXY_SMART_ROUTE",
  "LLMPROXY_SMART_PREFERENCE",
  "LLMPROXY_AUTO_ESCALATE",
  "LLMPROXY_PRICE_PERFORMANCE_ROUTING",
  "LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER",
  "LLMPROXY_PROVIDER_BENCHMARK_MINUTES",
  "BRAVE_API_KEY",
]);
const LEGACY_SERVICE_ENV_KEYS_TO_REMOVE = Object.freeze([
  "LLM_STATS_API_KEY",
  "LLMPROXY_LLM_STATS_API_KEY",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_TO_EMAIL",
  "SENDGRID_TO_MESSAGE_TYPE",
  "LLMPROXY_SENDGRID_API_KEY",
  "LLMPROXY_SENDGRID_FROM_EMAIL",
  "LLMPROXY_SENDGRID_TO_EMAIL",
  "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE",
  "LLMPROXY_METERING_SINK",
  "LLMPROXY_MONGODB_URI",
  "LLMPROXY_MONGODB_DB",
  "LLMPROXY_MONGODB_METERING_COLLECTION",
  "LLMPROXY_SMART_ROUTE",
  "LLMPROXY_SMART_PREFERENCE",
  "BRAVE_API_KEY",
]);

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

function hasAnyOwnKey(target, keys = []) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(target, key));
}

function normalizeScope(scope) {
  const normalized = String(scope || "").trim().toLowerCase();
  if (normalized === "project" || normalized === "service" || normalized === "global") return normalized;
  return "";
}

function listConfigSpecs() {
  return getAllConfigSpecs();
}

function getConfigSpec(key) {
  return CONFIG_SPEC_MAP.get(String(key || "").trim()) || null;
}

function isVisibleInList(key) {
  const spec = getConfigSpec(key);
  if (!spec) return null;
  return spec.hiddenInList !== true;
}

function inferScopeFromKey(key, explicitScope) {
  const normalizedScope = normalizeScope(explicitScope);
  const spec = getConfigSpec(key);
  if (!spec) {
    throw new Error(`Variabile non supportata: ${key}`);
  }
  if (!normalizedScope) return spec.scope;
  if (normalizedScope === "global") {
    if (spec.scope !== "project") {
      throw new Error(`La variabile ${spec.key} appartiene allo scope ${spec.scope}, non global`);
    }
    return "global";
  }
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

function hasLocalClaudeFolder(cwd) {
  const projectRoot = resolveProjectRoot(cwd);
  return fs.existsSync(path.join(projectRoot, ".claude"));
}

function readClaudeSettings(cwd) {
  const settingsFile = getClaudeSettingsFile(cwd);
  return {
    settingsFile,
    config: readJsonFile(settingsFile) || {},
  };
}

function writeClaudeSettings(cwd, config) {
  writeJsonFile(getClaudeSettingsFile(cwd), normalizeClaudeSettingsConfig(config, { cwd, injectDefaults: false }));
}

function getGlobalClaudeSettingsFile(env = process.env) {
  const homeDir = path.resolve(String(env.HOME || os.homedir()));
  return path.join(homeDir, ".claude", "settings.json");
}

function writeGlobalClaudeSettings(env = process.env, config = {}) {
  writeJsonFile(
    getGlobalClaudeSettingsFile(env),
    normalizeClaudeSettingsConfig(config, { env, injectDefaults: false }),
  );
}

function readGlobalClaudeSettings(options = {}) {
  const settingsFile = getGlobalClaudeSettingsFile(options.env);
  const config = readJsonFile(settingsFile) || {};
  const rawEnv = config.env && typeof config.env === "object" && !Array.isArray(config.env)
    ? config.env
    : {};
  return {
    settingsFile,
    config,
    env: normalizeProjectEnv(rawEnv, { ...options, injectDefaults: false }).env,
  };
}

function readServiceConfig(filePath) {
  const payload = readJsonFile(filePath);
  const env = payload?.env && typeof payload.env === "object" && !Array.isArray(payload.env)
    ? payload.env
    : {};
  return { env: { ...env } };
}

function writeServiceConfig(filePath, payload) {
  writeJsonFile(filePath, normalizeServiceConfigPayload(filePath, payload, { injectDefaults: false }));
}

function deriveDataRootFromServiceConfigFile(serviceConfigFile, env = process.env) {
  const explicit = String(env.LLMPROXY_HOME || "").trim();
  if (explicit) return path.resolve(explicit);
  const filePath = String(serviceConfigFile || "").trim();
  if (!filePath) return "";
  return path.dirname(path.dirname(path.resolve(filePath)));
}

function getProjectDefaultValues(options = {}) {
  const env = options.env || process.env;
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const dataRoot = path.resolve(String(
    options.dataRoot
    || deriveDataRootFromServiceConfigFile(options.serviceConfigFile, env)
    || path.join(resolveHomeDir(env), ".llmproxy")
  ));
  const { loadRuntimeEnv, resolveProxyHostPort } = require("./runtime-env");
  const runtimeEnv = loadRuntimeEnv({ env, packageRoot, dataRoot });
  const binding = resolveProxyHostPort({ env: runtimeEnv, dataRoot });
  return {
    ANTHROPIC_BASE_URL: `http://${binding.host}:${binding.port}`,
    ANTHROPIC_DEFAULT_MODEL: "",
    ANTHROPIC_AUTH_TOKEN: "",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    LLMPROXY_LLM_STATS_API_KEY: "",
    LLMPROXY_SENDGRID_API_KEY: "",
    LLMPROXY_SENDGRID_FROM_EMAIL: "",
    LLMPROXY_SENDGRID_TO_EMAIL: "",
    LLMPROXY_SENDGRID_TO_MESSAGE_TYPE: "service_unreachable,service_recovered,provider_error,auto_escalation,provider_credit_exhausted,service_update",
    LLMPROXY_METERING_INLINE: "0",
    LLMPROXY_INFERENCE_INFO_INLINE: "1",
    LLMPROXY_PROVIDER_CREDIT_INLINE: "1",
    LLMPROXY_SHORT_ANSWER: "0",
  };
}

function getServiceDefaultValues(options = {}) {
  const env = options.env || process.env;
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const dataRoot = path.resolve(String(
    options.dataRoot
    || deriveDataRootFromServiceConfigFile(options.serviceConfigFile, env)
    || path.join(resolveHomeDir(env), ".llmproxy")
  ));
  const { loadRuntimeEnv, resolveProxyHostPort, resolveRuntimeProfile } = require("./runtime-env");
  const { getDockerHostProjectsRoot } = require("./paths");
  const runtimeEnv = loadRuntimeEnv({ env, packageRoot, dataRoot });
  const binding = resolveProxyHostPort({ env: runtimeEnv, dataRoot });
  const profile = resolveRuntimeProfile({ env: runtimeEnv, packageRoot });
  return {
    PORT: String(binding.port),
    HOST: String(binding.host),
    NODE_ENV: String(runtimeEnv.NODE_ENV || profile || "production"),
    LLMPROXY_ENV: String(runtimeEnv.LLMPROXY_ENV || profile || "production"),
    LLMPROXY_RUNTIME_PROFILE: String(runtimeEnv.LLMPROXY_RUNTIME_PROFILE || profile || "production"),
    LLMPROXY_MODE: String(runtimeEnv.LLMPROXY_MODE || "standalone"),
    LLMPROXY_LOG_RETENTION_DAYS: String(runtimeEnv.LLMPROXY_LOG_RETENTION_DAYS || (profile === "production" ? "30" : "7")),
    LLMPROXY_LOG_MAX_BYTES: String(runtimeEnv.LLMPROXY_LOG_MAX_BYTES || "5242880"),
    LLMPROXY_LOG_MAX_FILES: String(runtimeEnv.LLMPROXY_LOG_MAX_FILES || "5"),
    LLMPROXY_MONGODB_CONNECTION_STRING: String(runtimeEnv.LLMPROXY_MONGODB_CONNECTION_STRING || ""),
    LLMPROXY_SECRET: String(runtimeEnv.LLMPROXY_SECRET || ""),
    LLMPROXY_GLOBAL_SERVICE: String(runtimeEnv.LLMPROXY_GLOBAL_SERVICE || "1"),
    LLMPROXY_SERVICE_RUNTIME: String(runtimeEnv.LLMPROXY_SERVICE_RUNTIME || "native"),
    LLMPROXY_DOCKER_COMPOSE_FILE: String(runtimeEnv.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(packageRoot, "docker-compose.production.yml")),
    LLMPROXY_DOCKER_SERVICE: String(runtimeEnv.LLMPROXY_DOCKER_SERVICE || "llmproxy"),
    LLMPROXY_DOCKER_POLL_MS: String(runtimeEnv.LLMPROXY_DOCKER_POLL_MS || "30000"),
    LLMPROXY_HOME: String(runtimeEnv.LLMPROXY_HOME || dataRoot),
    DBLAYER_URL: String(runtimeEnv.DBLAYER_URL || ""),
    EVENTBUS_URL: String(runtimeEnv.EVENTBUS_URL || ""),
  };
}

function normalizeProjectEnv(env = {}, options = {}) {
  const nextEnv = env && typeof env === "object" && !Array.isArray(env) ? { ...env } : {};
  const defaults = getProjectDefaultValues(options);
  let changed = false;

  for (const [legacyKey, nextKey] of Object.entries(LEGACY_PROJECT_ENV_MAPPINGS)) {
    if (!Object.prototype.hasOwnProperty.call(nextEnv, legacyKey)) continue;
    if (!Object.prototype.hasOwnProperty.call(nextEnv, nextKey)) {
      nextEnv[nextKey] = nextEnv[legacyKey];
      changed = true;
    }
    delete nextEnv[legacyKey];
    changed = true;
  }

  for (const legacyKey of LEGACY_PROJECT_ENV_KEYS_TO_REMOVE) {
    if (!Object.prototype.hasOwnProperty.call(nextEnv, legacyKey)) continue;
    delete nextEnv[legacyKey];
    changed = true;
  }

  if (options.injectDefaults === true) {
    for (const spec of CONFIG_SPECS) {
      if (spec.scope !== "project") continue;
      if (Object.prototype.hasOwnProperty.call(nextEnv, spec.key)) continue;
      nextEnv[spec.key] = defaults[spec.key] ?? "";
      changed = true;
    }
  }

  return { env: nextEnv, changed };
}

function normalizeServiceEnv(env = {}, options = {}) {
  const nextEnv = env && typeof env === "object" && !Array.isArray(env) ? { ...env } : {};
  const defaults = getServiceDefaultValues(options);
  let changed = false;

  if (!Object.prototype.hasOwnProperty.call(nextEnv, "LLMPROXY_MONGODB_CONNECTION_STRING")
    && Object.prototype.hasOwnProperty.call(nextEnv, "LLMPROXY_MONGODB_URI")) {
    nextEnv.LLMPROXY_MONGODB_CONNECTION_STRING = String(nextEnv.LLMPROXY_MONGODB_URI || "");
    changed = true;
  }

  for (const legacyKey of LEGACY_SERVICE_ENV_KEYS_TO_REMOVE) {
    if (!Object.prototype.hasOwnProperty.call(nextEnv, legacyKey)) continue;
    delete nextEnv[legacyKey];
    changed = true;
  }

  if (options.injectDefaults === true) {
    for (const spec of CONFIG_SPECS) {
      if (spec.scope !== "service" || spec.hiddenInList === true) continue;
      if (Object.prototype.hasOwnProperty.call(nextEnv, spec.key)) continue;
      nextEnv[spec.key] = defaults[spec.key] ?? "";
      changed = true;
    }
  }

  return { env: nextEnv, changed };
}

function normalizeClaudeSettingsConfig(config = {}, options = {}) {
  const nextConfig = config && typeof config === "object" ? { ...config } : {};
  const rawEnv = nextConfig.env && typeof nextConfig.env === "object" && !Array.isArray(nextConfig.env)
    ? nextConfig.env
    : {};
  const shouldMigrate = hasAnyOwnKey(rawEnv, [
    ...Object.keys(LEGACY_PROJECT_ENV_MAPPINGS),
    ...LEGACY_PROJECT_ENV_KEYS_TO_REMOVE,
    ...CONFIG_SPECS.filter((spec) => spec.scope === "project").map((spec) => spec.key),
  ]) || String(nextConfig.model || "").trim().toLowerCase().includes("llmproxy");
  if (!shouldMigrate) {
    nextConfig.env = rawEnv;
    return nextConfig;
  }
  nextConfig.env = normalizeProjectEnv(rawEnv, options).env;
  return nextConfig;
}

function normalizeServiceConfigPayload(filePath, payload = {}, options = {}) {
  const env = payload?.env && typeof payload.env === "object" && !Array.isArray(payload.env)
    ? payload.env
    : {};
  return {
    env: normalizeServiceEnv(env, { ...options, serviceConfigFile: filePath }).env,
  };
}

function migrateManagedConfig(options = {}) {
  const migrated = {
    project: false,
    global: false,
    service: false,
  };

  const projectCwd = String(options.cwd || process.cwd() || "").trim();
  let projectSettingsFile = "";

  if (projectCwd) {
    const { settingsFile, config } = readClaudeSettings(projectCwd);
    projectSettingsFile = settingsFile;
    if (fs.existsSync(settingsFile)) {
      const normalized = normalizeClaudeSettingsConfig(config, { ...options, injectDefaults: true });
      if (JSON.stringify(normalized) !== JSON.stringify(config)) {
        writeJsonFile(settingsFile, normalized);
        migrated.project = true;
      }
    }
  }

  const globalSettingsFile = getGlobalClaudeSettingsFile(options.env);
  const projectAndGlobalCoincide = projectSettingsFile
    ? path.resolve(globalSettingsFile) === path.resolve(projectSettingsFile)
    : false;
  if (fs.existsSync(globalSettingsFile) && !projectAndGlobalCoincide) {
    const globalConfig = readJsonFile(globalSettingsFile) || {};
    const normalizedGlobalConfig = normalizeClaudeSettingsConfig(globalConfig, { ...options, injectDefaults: true });
    if (JSON.stringify(normalizedGlobalConfig) !== JSON.stringify(globalConfig)) {
      writeJsonFile(globalSettingsFile, normalizedGlobalConfig);
      migrated.global = true;
    }
  }

  if (options.serviceConfigFile) {
    const currentServiceConfig = readServiceConfig(options.serviceConfigFile);
    const normalizedServiceConfig = normalizeServiceConfigPayload(options.serviceConfigFile, currentServiceConfig, { injectDefaults: true });
    if (JSON.stringify(normalizedServiceConfig) !== JSON.stringify(currentServiceConfig)) {
      writeJsonFile(options.serviceConfigFile, normalizedServiceConfig);
      migrated.service = true;
    }
  }

  return migrated;
}

function listProjectScopeValues(options = {}) {
  const includeHidden = options.includeHidden === true;
  const { config } = readClaudeSettings(options.cwd);
  const localEnv = normalizeProjectEnv(
    config.env && typeof config.env === "object" ? config.env : {},
    { ...options, injectDefaults: false },
  ).env;
  const globalEnv = readGlobalClaudeSettings(options).env;
  const defaults = getProjectDefaultValues(options);
  return CONFIG_SPECS
    .filter((spec) => spec.scope === "project" && (includeHidden || spec.hiddenInList !== true))
    .map((spec) => ({
      key: spec.key,
      scope: spec.scope,
      value: Object.prototype.hasOwnProperty.call(localEnv, spec.key)
        ? localEnv[spec.key]
        : Object.prototype.hasOwnProperty.call(globalEnv, spec.key)
          ? globalEnv[spec.key]
          : (defaults[spec.key] ?? null),
      source: Object.prototype.hasOwnProperty.call(localEnv, spec.key)
        ? "project"
        : Object.prototype.hasOwnProperty.call(globalEnv, spec.key)
          ? "global"
          : "default",
    }));
}

function listGlobalProjectValues(options = {}) {
  const includeHidden = options.includeHidden === true;
  const globalEnv = readGlobalClaudeSettings(options).env;
  const defaults = getProjectDefaultValues(options);
  return CONFIG_SPECS
    .filter((spec) => spec.scope === "project" && (includeHidden || spec.hiddenInList !== true))
    .map((spec) => ({
      key: spec.key,
      scope: "global",
      value: Object.prototype.hasOwnProperty.call(globalEnv, spec.key)
        ? globalEnv[spec.key]
        : (defaults[spec.key] ?? null),
      source: Object.prototype.hasOwnProperty.call(globalEnv, spec.key) ? "global" : "default",
    }));
}

function listScopeValues(options = {}) {
  const scope = normalizeScope(options.scope);
  const includeHidden = options.includeHidden === true;
  if (scope === "project") {
    return listProjectScopeValues(options);
  }

  if (scope === "global") {
    return listGlobalProjectValues(options);
  }

  if (scope === "service") {
    const serviceConfig = readServiceConfig(options.serviceConfigFile);
    const defaults = getServiceDefaultValues(options);
    return CONFIG_SPECS
      .filter((spec) => spec.scope === "service" && (includeHidden || spec.hiddenInList !== true))
      .map((spec) => ({
        key: spec.key,
        scope: spec.scope,
        value: Object.prototype.hasOwnProperty.call(serviceConfig.env, spec.key) ? serviceConfig.env[spec.key] : (defaults[spec.key] ?? null),
      }));
  }

  const projectValues = listScopeValues({ ...options, scope: "project" });
  const globalValues = listScopeValues({ ...options, scope: "global" });
  const serviceValues = listScopeValues({ ...options, scope: "service" });
  return [...projectValues, ...globalValues, ...serviceValues];
}

function getScopeValue(options = {}) {
  const key = String(options.key || "").trim();
  if (!key) throw new Error("Variabile richiesta");
  const scope = inferScopeFromKey(key, options.scope);
  const values = listScopeValues({ ...options, scope, includeHidden: true });
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

  if (scope === "global") {
    const { config } = readGlobalClaudeSettings(options);
    const nextEnv = config.env && typeof config.env === "object" ? { ...config.env } : {};
    nextEnv[key] = value;
    writeGlobalClaudeSettings(options.env, { ...config, env: nextEnv });
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

  if (scope === "global") {
    const { config } = readGlobalClaudeSettings(options);
    const nextEnv = config.env && typeof config.env === "object" ? { ...config.env } : {};
    delete nextEnv[key];
    writeGlobalClaudeSettings(options.env, { ...config, env: nextEnv });
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
  getProjectDefaultValues,
  getServiceDefaultValues,
  getConfigSpec,
  isVisibleInList,
  listConfigSpecs,
  getAllConfigSpecs,
  isRestartRequired,
  isHotReloadable,
  inferScopeFromKey,
  readClaudeSettings,
  writeClaudeSettings,
  readServiceConfig,
  writeServiceConfig,
  normalizeProjectEnv,
  normalizeServiceEnv,
  normalizeClaudeSettingsConfig,
  normalizeServiceConfigPayload,
  migrateManagedConfig,
  listScopeValues,
  listGlobalProjectValues,
  getScopeValue,
  setScopeValue,
  unsetScopeValue,
  getClaudeSettingsFile,
  getGlobalClaudeSettingsFile,
  writeGlobalClaudeSettings,
  hasLocalClaudeFolder,
  resolveHomeDir,
};
