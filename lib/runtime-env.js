const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getDataRoot } = require("./paths");
const { readServiceConfig } = require("./configuration");

const PROFILE_DEFAULTS = {
  development: {
    NODE_ENV: "development",
    LLMPROXY_ENV: "development",
    LLMPROXY_MODE: "standalone",
    LLMPROXY_LOG_RETENTION_DAYS: "7",
  },
  staging: {
    NODE_ENV: "staging",
    LLMPROXY_ENV: "staging",
    LLMPROXY_MODE: "standalone",
    LLMPROXY_LOG_RETENTION_DAYS: "7",
  },
  production: {
    NODE_ENV: "production",
    LLMPROXY_ENV: "production",
    LLMPROXY_MODE: "standalone",
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

function resolveProfilePortPrefix(profile) {
  if (profile === "staging") return "6";
  if (profile === "production") return "7";
  return "5";
}

/**
 * Validate that a service URL's port matches the expected port for the
 * given runtime profile. If the URL has an explicit port that doesn't match,
 * return the corrected URL with the expected port. This ensures services
 * like event-bus are always reached at the environment-appropriate port
 * (e.g., llmproxy on 7045 must connect to event-bus on 7048, not 5048).
 */
function resolveServiceUrlForProfile(url, expectedPort) {
  try {
    const parsed = new URL(url);
    if (parsed.port && parsed.port !== String(expectedPort)) {
      parsed.port = String(expectedPort);
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // If URL parsing fails, return the original
  }
  return url;
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

function readClaudeGlobalEnv(homeDir) {
  try {
    const settingsFile = path.join(path.resolve(String(homeDir || "") || os.homedir()), ".claude", "settings.json");
    if (!fs.existsSync(settingsFile)) return {};
    const raw = fs.readFileSync(settingsFile, "utf8");
    const parsed = JSON.parse(raw);
    const env = parsed?.env && typeof parsed.env === "object" ? parsed.env : {};
    // Extract only LLMPROXY_* vars to avoid leaking unrelated Claude config
    const result = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("LLMPROXY_") || key.startsWith("ANTHROPIC_") || key === "API_TIMEOUT_MS") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function loadRuntimeEnv(options = {}) {
  const env = { ...(options.env || process.env) };
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const runtimeProfile = resolveRuntimeProfile({ env, packageRoot });
  const dataRoot = path.resolve(String(options.dataRoot || getDataRoot({ env, homeDir: options.homeDir, platform: options.platform })));
  const homeDir = path.resolve(String(options.homeDir || env.HOME || os.homedir()));
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
  const claudeGlobalEnv = readClaudeGlobalEnv(homeDir);
  const portPrefix = resolveProfilePortPrefix(runtimeProfile);

  return {
    ...defaults,
    ...parsed,
    ...claudeGlobalEnv,
    ...serviceEnv,
    ...env,
    NODE_ENV: String(env.NODE_ENV || parsed.NODE_ENV || defaults.NODE_ENV),
    LLMPROXY_ENV: String(env.LLMPROXY_ENV || parsed.LLMPROXY_ENV || defaults.LLMPROXY_ENV),
    DBLAYER_URL: resolveServiceUrlForProfile(
      String(env.DBLAYER_URL || serviceEnv.DBLAYER_URL || parsed.DBLAYER_URL || `http://localhost:${portPrefix}001`),
      `${portPrefix}001`,
    ),
    EVENTBUS_URL: resolveServiceUrlForProfile(
      String(env.EVENTBUS_URL || serviceEnv.EVENTBUS_URL || parsed.EVENTBUS_URL || `http://localhost:${portPrefix}048`),
      `${portPrefix}048`,
    ),
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
  resolveProfilePortPrefix,
  deriveUserScopedPort,
  resolveProxyHostPort,
  resolveServiceUrlForProfile,
};
