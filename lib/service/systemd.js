const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function createSystemdServiceManager(options = {}) {
  const label = String(options.label || "llmproxy.service");
  const packageRoot = path.resolve(String(options.packageRoot || process.cwd()));
  const nodeExecutable = String(options.nodeExecutable || process.execPath);
  const entryFile = path.resolve(String(options.entryFile || path.join(packageRoot, "server.js")));
  const serviceFile = path.resolve(String(options.serviceFile || path.join(process.env.HOME || "~", ".config", "systemd", "user", label)));
  const stdoutPath = path.resolve(String(options.stdoutPath || path.join(process.env.HOME || "~", ".local", "share", "llmProxy", "logs", "service.out.log")));
  const stderrPath = path.resolve(String(options.stderrPath || path.join(process.env.HOME || "~", ".local", "share", "llmProxy", "logs", "service.err.log")));
  const environment = options.environment && typeof options.environment === "object" ? options.environment : {};

  function renderServiceDefinition() {
    const envLine = Object.entries(environment)
      .map(([key, value]) => `Environment=${key}=${JSON.stringify(String(value))}`)
      .join("\n");
    return `[Unit]
Description=llmProxy GitHub Copilot proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=${packageRoot}
ExecStart=${nodeExecutable} ${entryFile}
Restart=always
RestartSec=2
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}
${envLine}

[Install]
WantedBy=default.target
`;
  }

  function execSystemctl(args) {
    return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  }

  function install() {
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.writeFileSync(serviceFile, renderServiceDefinition(), "utf8");
    execSystemctl(["daemon-reload"]);
    execSystemctl(["enable", "--now", label]);
    return { ok: true, serviceFile, stdoutPath, stderrPath };
  }

  function stop() {
    const result = execSystemctl(["disable", "--now", label]);
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  }

  function status() {
    const result = execSystemctl(["status", label, "--no-pager"]);
    return { ok: result.status === 0, active: result.status === 0, stdout: result.stdout, stderr: result.stderr, stdoutPath, stderrPath };
  }

  return {
    kind: "systemd",
    label,
    serviceFile,
    stdoutPath,
    stderrPath,
    renderServiceDefinition,
    install,
    stop,
    status,
  };
}

module.exports = {
  createSystemdServiceManager,
};