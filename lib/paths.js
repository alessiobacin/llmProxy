const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function getDataRoot(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const explicit = String(env.LLMPROXY_HOME || "").trim();

  if (explicit) return path.resolve(explicit);
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "llmProxy");
  if (platform === "linux") return path.join(homeDir, ".local", "share", "llmProxy");
  if (platform === "win32") return path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "llmProxy");
  return path.join(homeDir, ".llmProxy");
}

function createPaths(options = {}) {
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const dataRoot = path.resolve(String(options.dataRoot || getDataRoot(options)));
  const logsDir = path.join(dataRoot, "logs");
  const serviceDir = path.join(dataRoot, "service");
  const homeDir = options.homeDir || os.homedir();

  return {
    packageRoot,
    dataRoot,
    logsDir,
    serviceDir,
    tokenFile: path.join(dataRoot, "copilot-token.json"),
    modelCatalogFile: path.join(dataRoot, "copilot-models.json"),
    endpointPreferencesFile: path.join(dataRoot, "copilot-endpoints.json"),
    stdoutLogFile: path.join(logsDir, "service.out.log"),
    stderrLogFile: path.join(logsDir, "service.err.log"),
    launchAgentFile: path.join(homeDir, "Library", "LaunchAgents", "com.llmproxy.service.plist"),
    systemdUnitFile: path.join(homeDir, ".config", "systemd", "user", "llmproxy.service"),
  };
}

function ensureRuntimeDirs(paths) {
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.serviceDir, { recursive: true });
}

module.exports = {
  getDataRoot,
  createPaths,
  ensureRuntimeDirs,
};