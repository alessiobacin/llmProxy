const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function createWindowsServiceManager(options = {}) {
  const label = String(options.label || "llmproxy");
  const packageRoot = path.resolve(String(options.packageRoot || process.cwd()));
  const nodeExecutable = String(options.nodeExecutable || process.execPath);
  const entryFile = path.resolve(String(options.entryFile || path.join(packageRoot, "server.js")));
  const serviceFile = path.resolve(String(options.serviceFile || ""));
  const stdoutPath = path.resolve(String(options.stdoutPath || path.join(process.env.APPDATA || path.join(require("node:os").homedir(), "AppData", "Roaming"), "llmProxy", "logs", "service.out.log")));
  const stderrPath = path.resolve(String(options.stderrPath || path.join(process.env.APPDATA || path.join(require("node:os").homedir(), "AppData", "Roaming"), "llmProxy", "logs", "service.err.log")));
  const wrapperPath = path.resolve(String(options.wrapperPath || ""));
  const environment = options.environment && typeof options.environment === "object" ? options.environment : {};

  function renderServiceDefinition() {
    const envLines = Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    return [
      `Windows Service: ${label}`,
      `Binary: ${wrapperPath || nodeExecutable}`,
      `Working Directory: ${packageRoot}`,
      `Entry: ${entryFile}`,
      `stdout: ${stdoutPath}`,
      `stderr: ${stderrPath}`,
      `Auto-restart: yes (sc failure recovery)`,
      envLines ? `\nEnvironment:\n${envLines}` : "",
    ].filter(Boolean).join("\n");
  }

  function getNodeBinDir() {
    return path.dirname(nodeExecutable);
  }

  function renderWrapperContent() {
    const binDir = getNodeBinDir();
    const lines = [
      "@echo off",
      "",
    ];
    if (environment.LLMPROXY_HOME) {
      lines.push(`set "LLMPROXY_HOME=${environment.LLMPROXY_HOME}"`);
    }
    if (environment.LLMPROXY_RUNTIME_PROFILE) {
      lines.push(`set "LLMPROXY_RUNTIME_PROFILE=${environment.LLMPROXY_RUNTIME_PROFILE}"`);
    }
    if (environment.NODE_ENV) {
      lines.push(`set "NODE_ENV=${environment.NODE_ENV}"`);
    }
    Object.entries(environment).forEach(([key, value]) => {
      if (!["LLMPROXY_HOME", "LLMPROXY_RUNTIME_PROFILE", "NODE_ENV"].includes(key)) {
        lines.push(`set "${key}=${value}"`);
      }
    });
    lines.push(`set "PATH=${binDir};%PATH%"`);
    lines.push(`"${nodeExecutable}" "${entryFile}" >> "${stdoutPath}" 2>> "${stderrPath}"`);
    return lines.join("\r\n");
  }

  function execSc(args) {
    return spawnSync("sc.exe", args, { encoding: "utf8", shell: true });
  }

  function execPowershell(args) {
    return spawnSync("powershell.exe", ["-NoProfile", "-Command", ...args], { encoding: "utf8" });
  }

  function isMissingServiceResult(result) {
    const stderr = String(result?.stderr || "");
    const stdout = String(result?.stdout || "");
    const combined = `${stdout} ${stderr}`.toLowerCase();
    return /does not exist|not found|does not exist as an installed service/i.test(combined);
  }

  function install() {
    // Create directories
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(stderrPath), { recursive: true });

    // Write wrapper .cmd
    fs.writeFileSync(wrapperPath, renderWrapperContent(), "utf8");

    // Remove existing service if present
    const queryResult = execSc(["query", label]);
    if (queryResult.status === 0) {
      execSc(["stop", label]);
      execSc(["delete", label]);
    }

    // Create service
    const binPath = `"${wrapperPath}"`;
    const createResult = execSc(["create", label, `binPath=${binPath}`, "start=auto"]);
    if (createResult.status !== 0) {
      return {
        ok: false,
        serviceFile: wrapperPath,
        stdoutPath,
        stderrPath,
        stdout: createResult.stdout,
        stderr: createResult.stderr || "sc.exe create failed",
      };
    }

    // Configure auto-restart on failure: restart after 5s, then 10s, then 30s
    execSc(["failure", label, "reset=0", "actions=restart/5000/restart/10000/restart/30000"]);

    // Set more specific failure actions (restart the service)
    execSc(["failure", label, "reset=86400", "actions=restart/5000"]);

    // Start the service
    const startResult = execSc(["start", label]);
    if (startResult.status !== 0) {
      // Service may still start asynchronously; try to query it
      const checkResult = execSc(["query", label]);
      if (checkResult.status !== 0) {
        return {
          ok: false,
          serviceFile: wrapperPath,
          stdoutPath,
          stderrPath,
          stdout: startResult.stdout,
          stderr: startResult.stderr || "sc.exe start failed",
        };
      }
    }

    return {
      ok: true,
      serviceFile: wrapperPath,
      stdoutPath,
      stderrPath,
      stdout: "",
      stderr: "",
    };
  }

  function start() {
    const result = execSc(["start", label]);
    if (result.status !== 0) {
      // Could already be running — check
      const queryResult = execSc(["query", label]);
      const stdout = String(queryResult.stdout || "").toLowerCase();
      if (queryResult.status === 0 && stdout.includes("running")) {
        return { ok: true, serviceFile: wrapperPath, stdoutPath, stderrPath, stdout: result.stdout, stderr: "" };
      }
      return {
        ok: false,
        serviceFile: wrapperPath,
        stdoutPath,
        stderrPath,
        stdout: result.stdout,
        stderr: result.stderr || "sc.exe start failed",
      };
    }
    return { ok: true, serviceFile: wrapperPath, stdoutPath, stderrPath, stdout: result.stdout, stderr: "" };
  }

  function stop() {
    const result = execSc(["stop", label]);
    if (result.status !== 0 && isMissingServiceResult(result)) {
      return { ok: true, stdout: result.stdout, stderr: "" };
    }
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  }

  function status() {
    const result = execPowershell([`Get-Service -Name ${label} | Select-Object -Property Name,Status,StartType`]);
    const stdout = String(result.stdout || "").trim();
    const active = stdout.toLowerCase().includes("running");
    if (result.status !== 0) {
      const queryResult = execSc(["query", label]);
      const queryStdout = String(queryResult.stdout || "").toLowerCase();
      const scActive = queryResult.status === 0 && (queryStdout.includes("running") || queryStdout.includes("stopped"));
      if (!scActive && isMissingServiceResult(queryResult)) {
        return { ok: true, active: false, stdout: stdout, stderr: "", stdoutPath, stderrPath };
      }
      return { ok: scActive, active: scActive, stdout: stdout, stderr: result.stderr, stdoutPath, stderrPath };
    }
    return { ok: true, active, stdout: stdout, stderr: result.stderr, stdoutPath, stderrPath };
  }

  return {
    kind: "windows",
    label,
    serviceFile: wrapperPath,
    stdoutPath,
    stderrPath,
    renderServiceDefinition,
    install,
    start,
    stop,
    status,
  };
}

module.exports = {
  createWindowsServiceManager,
};
