const fs = require("node:fs");
const path = require("node:path");

const PROFILE_DEFAULTS = {
  development: {
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
  staging: {
    PORT: "6045",
    HOST: "127.0.0.1",
    NODE_ENV: "staging",
    LLMPROXY_ENV: "staging",
    LLMPROXY_MODE: "platform",
    LLMPROXY_METERING_SINK: "dblayer",
    DBLAYER_URL: "http://localhost:6046",
    EVENTBUS_URL: "http://localhost:6048",
    LLMPROXY_LOG_RETENTION_DAYS: "7",
  },
  production: {
    PORT: "7045",
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    LLMPROXY_ENV: "production",
    LLMPROXY_MODE: "platform",
    LLMPROXY_METERING_SINK: "dblayer",
    DBLAYER_URL: "http://localhost:7046",
    EVENTBUS_URL: "http://localhost:7048",
    LLMPROXY_LOG_RETENTION_DAYS: "30",
  },
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
  const envFile = path.join(packageRoot, ".env");

  const defaults = PROFILE_DEFAULTS[runtimeProfile] || PROFILE_DEFAULTS.production;
  const shouldLoadEnvFile = !normalizeRuntimeProfile(env.LLMPROXY_RUNTIME_PROFILE)
    && runtimeProfile === "development"
    && !isGlobalPackageInstall(packageRoot);

  let parsed = {};
  if (shouldLoadEnvFile && fs.existsSync(envFile)) {
    parsed = parseEnvFile(fs.readFileSync(envFile, "utf8"));
  }

  return {
    ...defaults,
    ...parsed,
    ...env,
    NODE_ENV: String(env.NODE_ENV || parsed.NODE_ENV || defaults.NODE_ENV),
    LLMPROXY_ENV: String(env.LLMPROXY_ENV || parsed.LLMPROXY_ENV || defaults.LLMPROXY_ENV),
  };
}

module.exports = {
  loadRuntimeEnv,
  parseEnvFile,
  resolveRuntimeProfile,
  normalizeRuntimeProfile,
};