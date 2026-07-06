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

  function execNssm(args) {
    if (typeof options.execNssm === "function") {
      return options.execNssm(args, { encoding: "utf8", shell: false });
    }
    return spawnSync("nssm.exe", args, { encoding: "utf8", shell: false });
  }

  function hasNssm() {
    const result = execNssm(["version"]);
    return !result?.error && Number(result?.status) === 0;
  }

  function isRunningServiceResult(result) {
    const stderr = String(result?.stderr || "");
    const stdout = String(result?.stdout || "");
    const combined = `${stdout} ${stderr}`.toLowerCase();
    return /running|already running|1056/i.test(combined);
  }

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

  function getWindowsBasePath() {
    return [
      "C:\\Windows\\System32",
      "C:\\Windows",
      "C:\\Windows\\System32\\Wbem",
      getNodeBinDir(),
      "%PATH%",
    ].join(";");
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
      if (!["LLMPROXY_HOME", "LLMPROXY_RUNTIME_PROFILE", "NODE_ENV", "PATH"].includes(key)) {
        lines.push(`set "${key}=${value}"`);
      }
    });
    lines.push(`set "PATH=${getWindowsBasePath()}"`);
    lines.push(`"${nodeExecutable}" "${entryFile}" >> "${stdoutPath}" 2>> "${stderrPath}"`);
    return lines.join("\r\n");
  }

  function execSc(args) {
    if (typeof options.execSc === "function") {
      return options.execSc(args, { encoding: "utf8", shell: false });
    }
    return spawnSync("sc.exe", args, { encoding: "utf8", shell: false });
  }

  function isMissingServiceResult(result) {
    const stderr = String(result?.stderr || "");
    const stdout = String(result?.stdout || "");
    const combined = `${stdout} ${stderr}`.toLowerCase();
    return /does not exist|not found|does not exist as an installed service|1060/i.test(combined);
  }

  function isAlreadyStoppedServiceResult(result) {
    const stderr = String(result?.stderr || "");
    const stdout = String(result?.stdout || "");
    const combined = `${stdout} ${stderr}`.toLowerCase();
    return /not started|1062/i.test(combined);
  }

  function install() {
    // Create directories
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(stderrPath), { recursive: true });

    // Write wrapper .cmd
    fs.writeFileSync(wrapperPath, renderWrapperContent(), "utf8");

    const useNssm = hasNssm();

    // Remove existing service if present
    const queryResult = execSc(["query", label]);
    if (queryResult.status === 0) {
      if (useNssm) {
        execNssm(["stop", label]);
        execNssm(["remove", label, "confirm"]);
      } else {
        execSc(["stop", label]);
        execSc(["delete", label]);
      }
    }

    if (useNssm) {
      const installResult = execNssm(["install", label, nodeExecutable, entryFile]);
      if (installResult.status !== 0) {
        return {
          ok: false,
          serviceFile: wrapperPath,
          stdoutPath,
          stderrPath,
          stdout: installResult.stdout,
          stderr: installResult.stderr || "nssm.exe install failed",
        };
      }

      const envLines = Object.entries(environment)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`);
      envLines.push(`PATH=${getWindowsBasePath()}`);

      const configCalls = [
        ["set", label, "AppDirectory", packageRoot],
        ["set", label, "AppStdout", stdoutPath],
        ["set", label, "AppStderr", stderrPath],
        ["set", label, "Start", "SERVICE_AUTO_START"],
        ["set", label, "AppExit", "Default", "Restart"],
      ];
      if (envLines.length > 0) {
        configCalls.push(["set", label, "AppEnvironmentExtra", ...envLines]);
      }
      for (const args of configCalls) {
        const result = execNssm(args);
        if (result.status !== 0) {
          return {
            ok: false,
            serviceFile: wrapperPath,
            stdoutPath,
            stderrPath,
            stdout: result.stdout,
            stderr: result.stderr || `nssm.exe ${args.join(" ")} failed`,
          };
        }
      }

      const startResult = execNssm(["start", label]);
      if (startResult.status !== 0 && !isRunningServiceResult(startResult)) {
        return {
          ok: false,
          serviceFile: wrapperPath,
          stdoutPath,
          stderrPath,
          stdout: startResult.stdout,
          stderr: startResult.stderr || "nssm.exe start failed",
        };
      }
    } else {
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
    const useNssm = hasNssm();
    const result = useNssm ? execNssm(["start", label]) : execSc(["start", label]);
    if (result.status !== 0) {
      const queryResult = execSc(["query", label]);
      const stdout = String(queryResult.stdout || "").toLowerCase();
      if (queryResult.status === 0 && stdout.includes("running")) {
        return { ok: true, serviceFile: wrapperPath, stdoutPath, stderrPath, stdout: result.stdout, stderr: "" };
      }
      if (isMissingServiceResult(result) || isMissingServiceResult(queryResult)) {
        return install();
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
    if (result.status !== 0 && (isMissingServiceResult(result) || isAlreadyStoppedServiceResult(result))) {
      return { ok: true, stdout: result.stdout, stderr: "" };
    }
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  }

  function status() {
    const result = execSc(["query", label]);
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    const combined = `${stdout}\n${stderr}`.toLowerCase();
    if (isMissingServiceResult(result)) {
      return { ok: true, active: false, stdout: "", stderr: "", stdoutPath, stderrPath };
    }
    const active = combined.includes("running");
    const installed = combined.includes("state") || combined.includes("running") || combined.includes("stopped");
    return {
      ok: installed,
      active,
      stdout: stdout,
      stderr: installed ? "" : stderr,
      stdoutPath,
      stderrPath,
    };
  }

  return {
    kind: "windows",
    label,
    serviceFile: wrapperPath,
    stdoutPath,
    stderrPath,
    renderServiceDefinition,
    renderWrapperContent,
    install,
    start,
    stop,
    status,
  };
}

module.exports = {
  createWindowsServiceManager,
};
