const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
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
  const userId = Number.isInteger(options.userId)
    ? options.userId
    : typeof process.getuid === "function"
      ? process.getuid()
      : null;
  const runtimeDir = String(
    options.runtimeDir
      || (userId != null ? path.join("/run/user", String(userId)) : "")
      || process.env.XDG_RUNTIME_DIR
  ).trim();
  const systemctlEnv = {
    ...process.env,
    ...(runtimeDir
      ? {
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
        }
      : {}),
  };
  const username = String(
    options.username
      || process.env.SUDO_USER
      || process.env.USER
      || (() => {
        try {
          return os.userInfo().username;
        } catch {
          return "";
        }
      })()
  ).trim();

  function renderServiceDefinition() {
    const envLine = Object.entries(environment)
      .map(([key, value]) => `Environment=${key}=${JSON.stringify(String(value))}`)
      .join("\n");
    return `[Unit]
Description=llmProxy
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
    if (typeof options.execSystemctl === "function") {
      return options.execSystemctl(args, { encoding: "utf8", env: systemctlEnv });
    }
    return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: systemctlEnv });
  }

  function execLoginctl(args) {
    if (typeof options.execLoginctl === "function") {
      return options.execLoginctl(args, { encoding: "utf8" });
    }
    return spawnSync("loginctl", args, { encoding: "utf8" });
  }

  function ensureLinger() {
    if (!username) {
      return { ok: false, attempted: false, stdout: "", stderr: "" };
    }
    const result = execLoginctl(["enable-linger", username]);
    return {
      ok: result.status === 0,
      attempted: true,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }

  function install() {
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.writeFileSync(serviceFile, renderServiceDefinition(), "utf8");
    const linger = ensureLinger();
    const daemonReload = execSystemctl(["daemon-reload"]);
    const enable = execSystemctl(["enable", label]);
    const isActive = execSystemctl(["is-active", "--quiet", label]);
    const activate = isActive.status === 0
      ? execSystemctl(["restart", label])
      : execSystemctl(["start", label]);
    return {
      ok: daemonReload.status === 0 && enable.status === 0 && activate.status === 0,
      serviceFile,
      stdoutPath,
      stderrPath,
      stdout: `${linger.stdout || ""}${daemonReload.stdout || ""}${enable.stdout || ""}${activate.stdout || ""}`,
      stderr: `${linger.ok || !linger.attempted ? "" : linger.stderr || ""}${daemonReload.stderr || ""}${enable.stderr || ""}${activate.stderr || ""}`,
    };
  }

  function start() {
    const result = execSystemctl(["start", label]);
    return {
      ok: result.status === 0,
      serviceFile,
      stdoutPath,
      stderrPath,
      stdout: result.stdout,
      stderr: result.stderr,
    };
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
    start,
    stop,
    status,
    runtimeDir,
  };
}

module.exports = {
  createSystemdServiceManager,
};