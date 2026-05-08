const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createLaunchdServiceManager(options = {}) {
  const label = String(options.label || "com.llmproxy.service");
  const packageRoot = path.resolve(String(options.packageRoot || process.cwd()));
  const nodeExecutable = String(options.nodeExecutable || process.execPath);
  const entryFile = path.resolve(String(options.entryFile || path.join(packageRoot, "server.js")));
  const serviceFile = path.resolve(String(options.serviceFile || path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)));
  const stdoutPath = path.resolve(String(options.stdoutPath || path.join(os.homedir(), "Library", "Application Support", "llmProxy", "logs", "service.out.log")));
  const stderrPath = path.resolve(String(options.stderrPath || path.join(os.homedir(), "Library", "Application Support", "llmProxy", "logs", "service.err.log")));
  const environment = options.environment && typeof options.environment === "object" ? options.environment : {};
  const execLaunchctlOverride = typeof options.execLaunchctl === "function" ? options.execLaunchctl : null;

  function renderEnvironment() {
    return Object.entries(environment)
      .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
      .join("\n");
  }

  function renderServiceDefinition() {
    const envBlock = renderEnvironment();
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeExecutable)}</string>
    <string>${xmlEscape(entryFile)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(packageRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envBlock}
  </dict>
</dict>
</plist>
`;
  }

  function execLaunchctl(args) {
    if (execLaunchctlOverride) return execLaunchctlOverride(args);
    return spawnSync("launchctl", args, { encoding: "utf8" });
  }

  function isMissingServiceResult(result) {
    const stderr = String(result?.stderr || "");
    return /Could not find service/i.test(stderr)
      || /service not found/i.test(stderr)
      || /Boot-out failed:\s*3:\s*No such process/i.test(stderr)
      || /No such process/i.test(stderr);
  }

  function formatLaunchctlError(result, fallbackMessage) {
    const stderr = String(result?.stderr || "").trim();
    const stdout = String(result?.stdout || "").trim();
    return stderr || stdout || fallbackMessage;
  }

  function install() {
    fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.writeFileSync(serviceFile, renderServiceDefinition(), "utf8");
    const domainTarget = `gui/${process.getuid()}/${label}`;
    const bootoutResult = execLaunchctl(["bootout", domainTarget]);
    if (bootoutResult.status !== 0 && !isMissingServiceResult(bootoutResult)) {
      return {
        ok: false,
        serviceFile,
        stdoutPath,
        stderrPath,
        stdout: bootoutResult.stdout,
        stderr: formatLaunchctlError(bootoutResult, "launchctl bootout failed"),
      };
    }

    const bootstrapResult = execLaunchctl(["bootstrap", `gui/${process.getuid()}`, serviceFile]);
    if (bootstrapResult.status !== 0) {
      return {
        ok: false,
        serviceFile,
        stdoutPath,
        stderrPath,
        stdout: bootstrapResult.stdout,
        stderr: formatLaunchctlError(bootstrapResult, "launchctl bootstrap failed"),
      };
    }

    const kickstartResult = execLaunchctl(["kickstart", "-k", domainTarget]);
    if (kickstartResult.status !== 0) {
      return {
        ok: false,
        serviceFile,
        stdoutPath,
        stderrPath,
        stdout: kickstartResult.stdout,
        stderr: formatLaunchctlError(kickstartResult, "launchctl kickstart failed"),
      };
    }

    return { ok: true, serviceFile, stdoutPath, stderrPath, stdout: "", stderr: "" };
  }

  function start() {
    const domainTarget = `gui/${process.getuid()}/${label}`;
    // bootstrap is a no-op if already bootstrapped; kickstart -k forces (re)start
    const bootstrapResult = execLaunchctl(["bootstrap", `gui/${process.getuid()}`, serviceFile]);
    if (bootstrapResult.status !== 0 && !/already bootstrapped/i.test(String(bootstrapResult.stderr || ""))) {
      return {
        ok: false,
        serviceFile,
        stdoutPath,
        stderrPath,
        stdout: bootstrapResult.stdout,
        stderr: formatLaunchctlError(bootstrapResult, "launchctl bootstrap failed"),
      };
    }

    const kickstartResult = execLaunchctl(["kickstart", "-k", domainTarget]);
    if (kickstartResult.status !== 0) {
      return {
        ok: false,
        serviceFile,
        stdoutPath,
        stderrPath,
        stdout: kickstartResult.stdout,
        stderr: formatLaunchctlError(kickstartResult, "launchctl kickstart failed"),
      };
    }

    return { ok: true, serviceFile, stdoutPath, stderrPath, stdout: "", stderr: "" };
  }

  function stop() {
    const domainTarget = `gui/${process.getuid()}/${label}`;
    const result = execLaunchctl(["bootout", domainTarget]);
    return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
  }

  function status() {
    const result = execLaunchctl(["print", `gui/${process.getuid()}/${label}`]);
    if (isMissingServiceResult(result)) {
      return {
        ok: true,
        active: false,
        stdout: "",
        stderr: "",
        stdoutPath,
        stderrPath,
      };
    }

    return {
      ok: result.status === 0,
      active: result.status === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutPath,
      stderrPath,
    };
  }

  return {
    kind: "launchd",
    label,
    serviceFile,
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
  createLaunchdServiceManager,
};