"use strict";

const { spawnSync } = require("node:child_process");

const RESERVED_GLOBAL_SERVICE_PORTS = new Set(["6045", "7045"]);

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isReservedGlobalServicePort(port) {
  return RESERVED_GLOBAL_SERVICE_PORTS.has(String(port || "").trim());
}

function assertGlobalServicePortAccess({ port, env = process.env } = {}) {
  const normalizedPort = String(port || "").trim();
  if (!isReservedGlobalServicePort(normalizedPort)) return;
  if (isTruthy(env.LLMPROXY_GLOBAL_SERVICE)) return;

  throw new Error(
    `Porta riservata: ${normalizedPort} e' dedicata al servizio globale llmproxy. `
    + "Usa `llmproxy service:start` oppure una porta diversa per avvii locali/dev."
  );
}

function parseLsofListeners(output) {
  const listeners = [];
  const lines = String(output || "").split(/\r?\n/);
  let current = null;

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      if (current?.pid) listeners.push(current);
      current = { pid: Number(value), command: "", endpoint: "" };
      continue;
    }
    if (!current) continue;
    if (field === "c") {
      current.command = value;
      continue;
    }
    if (field === "n") {
      current.endpoint = value;
    }
  }

  if (current?.pid) listeners.push(current);
  return listeners.filter((listener) => Number.isFinite(listener.pid) && listener.pid > 0);
}

function defaultExec(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function parseWindowsNetstatListeners(output, port) {
  const normalizedPort = String(port || "").trim();
  const listeners = [];
  const lines = String(output || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    const match = line.match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
    if (!match) continue;
    const [, address, foundPort, pidText] = match;
    if (String(foundPort) !== normalizedPort) continue;
    const pid = Number(pidText);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    listeners.push({
      pid,
      command: "",
      endpoint: `${address}:${foundPort}`,
    });
  }
  return listeners;
}

function listPortListeners({ port, execCommand = defaultExec, platform = process.platform } = {}) {
  const normalizedPort = String(port || "").trim();
  if (!normalizedPort) return [];

  if (platform === "win32") {
    const result = execCommand("netstat.exe", ["-ano", "-p", "tcp"]);
    if (result?.error) {
      throw result.error;
    }
    if (Number(result?.status) !== 0) {
      const stdout = String(result?.stdout || "").trim();
      const stderr = String(result?.stderr || "").trim();
      if (!stdout && !stderr) return [];
      throw new Error(stderr || stdout || `netstat failed for port ${normalizedPort}`);
    }
    return parseWindowsNetstatListeners(result.stdout, normalizedPort);
  }

  const result = execCommand("lsof", ["-nP", `-iTCP:${normalizedPort}`, "-sTCP:LISTEN", "-Fpcn"]);
  if (result?.error) {
    throw result.error;
  }
  if (Number(result?.status) !== 0) {
    const stdout = String(result?.stdout || "").trim();
    const stderr = String(result?.stderr || "").trim();
    if (!stdout && !stderr) return [];
    if (Number(result?.status) === 1 && /no such file|not found/i.test(stderr)) return [];
    throw new Error(stderr || stdout || `lsof failed for port ${normalizedPort}`);
  }

  return parseLsofListeners(result.stdout);
}

function sendSignal(pid, signal, killProcess) {
  try {
    killProcess(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function reapConflictingPortListeners(options = {}) {
  const {
    port,
    allowedPids = [],
    allowedCommands = [],
    execCommand = defaultExec,
    killProcess = process.kill.bind(process),
    logger = null,
  } = options;
  const normalizedPort = String(port || "").trim();
  const allowedPidSet = new Set(allowedPids.map((pid) => Number(pid)).filter((pid) => Number.isFinite(pid) && pid > 0));
  const allowedCommandMatchers = allowedCommands.map((matcher) => matcher instanceof RegExp ? matcher : new RegExp(String(matcher), "i"));
  const listeners = listPortListeners({ port: normalizedPort, execCommand });
  const conflicts = listeners.filter((listener) => {
    if (allowedPidSet.has(listener.pid)) return false;
    return !allowedCommandMatchers.some((matcher) => matcher.test(String(listener.command || "")));
  });

  const terminated = [];
  for (const listener of conflicts) {
    const descriptor = `${listener.command || "unknown"} pid=${listener.pid} endpoint=${listener.endpoint || `:${normalizedPort}`}`;
    logger?.log?.(`terminating conflicting listener on ${normalizedPort}: ${descriptor}`);
    sendSignal(listener.pid, "SIGTERM", killProcess);
    terminated.push({ ...listener, signal: "SIGTERM" });
  }

  const stillListening = listPortListeners({ port: normalizedPort, execCommand }).filter((listener) => conflicts.some((conflict) => conflict.pid === listener.pid));
  for (const listener of stillListening) {
    const descriptor = `${listener.command || "unknown"} pid=${listener.pid} endpoint=${listener.endpoint || `:${normalizedPort}`}`;
    logger?.log?.(`forcing listener off ${normalizedPort}: ${descriptor}`);
    sendSignal(listener.pid, "SIGKILL", killProcess);
    terminated.push({ ...listener, signal: "SIGKILL" });
  }

  const remaining = listPortListeners({ port: normalizedPort, execCommand }).filter((listener) => {
    if (allowedPidSet.has(listener.pid)) return false;
    return !allowedCommandMatchers.some((matcher) => matcher.test(String(listener.command || "")));
  });

  if (remaining.length > 0) {
    const summary = remaining.map((listener) => `${listener.command || "unknown"} pid=${listener.pid} ${listener.endpoint || ""}`.trim()).join(", ");
    const error = `porta ${normalizedPort} ancora occupata da processi estranei: ${summary}`;
    logger?.error?.(error);
    return { ok: false, terminated, remaining, error };
  }

  return { ok: true, terminated, remaining: [] };
}

module.exports = {
  RESERVED_GLOBAL_SERVICE_PORTS,
  assertGlobalServicePortAccess,
  isReservedGlobalServicePort,
  listPortListeners,
  parseLsofListeners,
  parseWindowsNetstatListeners,
  reapConflictingPortListeners,
};
