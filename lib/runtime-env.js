const fs = require("node:fs");
const path = require("node:path");

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
  const envFile = path.join(packageRoot, ".env");

  if (!fs.existsSync(envFile)) {
    return env;
  }

  const parsed = parseEnvFile(fs.readFileSync(envFile, "utf8"));
  return {
    ...parsed,
    ...env,
  };
}

module.exports = {
  loadRuntimeEnv,
  parseEnvFile,
};