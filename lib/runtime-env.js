const fs = require("node:fs");
const path = require("node:path");
const { getDataRoot } = require("./paths");
const { readServiceConfig } = require("./configuration");

const PROFILE_DEFAULTS = {
  development: {
    NODE_ENV: "development",
    LLMPROXY_ENV: "development",
    LLMPROXY_MODE: "standalone",
    LLMPROXY_METERING_SINK: "dblayer",
    LLMPROXY_LOG_RETENTION_DAYS: "7",
  },
  staging: {
    NODE_ENV: "staging",
    LLMPROXY_ENV: "staging",
    LLMPROXY_MODE: "standalone",
    LLMPROXY_METERING_SINK: "dblayer",
    LLMPROXY_LOG_RETENTION_DAYS: "7",
  },
  production: {
    NODE_ENV: "production",
    LLMPROXY_ENV: "production",
    LLMPROXY_MODE: "standalone",
    LLMPROXY_METERING_SINK: "dblayer",
    LLMPROXY_LOG_RETENTION_DAYS: "30",
  },
};

const PROFILE_PROXY_PORTS = {
  staging: "6045",
  production: "7045",
};

function normalizeRuntimeProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "dev") return "development";
  if (normalized === "prod") return "production";
  if (normalized === "development" || normalized === "staging" || normalized === "production") return normalized;
  return "";
}

function isGlobalPackageInstall(packageRoot) {
  return String(packageRoot || "").includes(`${path.sep}node_modules${path.sep}`);
}

function resolveRuntimeProfile(options = {}) {
  const env = options.env || process.env;
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const explicitRuntimeProfile = normalizeRuntimeProfile(env.LLMPROXY_RUNTIME_PROFILE);
  if (explicitRuntimeProfile) return explicitRuntimeProfile;
  const explicitProfile = normalizeRuntimeProfile(env.LLMPROXY_ENV || env.NODE_ENV);
  if (explicitProfile) return explicitProfile;
  return isGlobalPackageInstall(packageRoot) ? "production" : "development";
}

function parseEnvFile(content) {
  const entries = {};
  const lines = String(content || "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function loadRuntimeEnv(options = {}) {
  const env = { ...(options.env || process.env) };
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const runtimeProfile = resolveRuntimeProfile({ env, packageRoot });
  const dataRoot = path.resolve(String(options.dataRoot || getDataRoot({ env, homeDir: options.homeDir, platform: options.platform })));
  const envFile = path.join(packageRoot, ".env");
  const serviceConfigFile = path.join(dataRoot, "service", "config.json");

  const defaults = PROFILE_DEFAULTS[runtimeProfile] || PROFILE_DEFAULTS.production;
  const shouldLoadEnvFile = !normalizeRuntimeProfile(env.LLMPROXY_RUNTIME_PROFILE)
    && runtimeProfile === "development"
    && !isGlobalPackageInstall(packageRoot);

  let parsed = {};
  if (shouldLoadEnvFile && fs.existsSync(envFile)) {
    parsed = parseEnvFile(fs.readFileSync(envFile, "utf8"));
  }
  const serviceConfig = readServiceConfig(serviceConfigFile);
  const serviceEnv = serviceConfig?.env && typeof serviceConfig.env === "object" ? serviceConfig.env : {};

  return {
    ...defaults,
    ...parsed,
    ...serviceEnv,
    ...env,
    NODE_ENV: String(env.NODE_ENV || parsed.NODE_ENV || defaults.NODE_ENV),
    LLMPROXY_ENV: String(env.LLMPROXY_ENV || parsed.LLMPROXY_ENV || defaults.LLMPROXY_ENV),
  };
}

function deriveUserScopedPort(seed) {
  return "5045";
}

function resolveProxyHostPort(options = {}) {
  const env = options.env || process.env;
  const explicitHost = options.host ?? env.HOST;
  const explicitPort = options.port ?? env.PORT;
  const host = String(explicitHost || "127.0.0.1").trim() || "127.0.0.1";
  const normalizedPort = String(explicitPort || "").trim();

  if (normalizedPort) {
    return { host, port: normalizedPort };
  }

  const runtimeProfile = normalizeRuntimeProfile(env.LLMPROXY_RUNTIME_PROFILE)
    || normalizeRuntimeProfile(env.LLMPROXY_ENV || env.NODE_ENV);
  const fixedProfilePort = PROFILE_PROXY_PORTS[runtimeProfile];
  if (fixedProfilePort) {
    return { host, port: fixedProfilePort };
  }

  const dataRoot = String(options.dataRoot || env.LLMPROXY_HOME || "").trim();
  return {
    host,
    port: deriveUserScopedPort(dataRoot),
  };
}

module.exports = {
  loadRuntimeEnv,
  parseEnvFile,
  resolveRuntimeProfile,
  normalizeRuntimeProfile,
  deriveUserScopedPort,
  resolveProxyHostPort,
};
