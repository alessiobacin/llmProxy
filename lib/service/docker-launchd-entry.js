"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveDockerComposeCommand, runDockerCompose: executeDockerCompose } = require("../docker-compose");
const { reapConflictingPortListeners } = require("../port-guard");

const composeFile = process.env.LLMPROXY_DOCKER_COMPOSE_FILE
  || path.resolve(path.join(__dirname, "..", "..", "docker-compose.production.yml"));
const serviceName = process.env.LLMPROXY_DOCKER_SERVICE || "llmproxy";
const pollIntervalMs = Number(process.env.LLMPROXY_DOCKER_POLL_MS || 30_000);
const servicePort = String(process.env.PORT || "7045").trim() || "7045";

function runDockerCompose(args) {
  return executeDockerCompose(spawnSync, composeFile, args, { invocation: resolveDockerComposeCommand(spawnSync) });
}

function log(line) {
  process.stdout.write(`[docker-service] ${line}\n`);
}

function fail(line) {
  process.stderr.write(`[docker-service] ${line}\n`);
}

function ensureExclusiveServicePort() {
  const result = reapConflictingPortListeners({
    port: servicePort,
    allowedPids: [process.pid],
    allowedCommands: [/docker/i, /com\.docke/i],
    logger: { log, error: fail },
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
}

function ensurePreconditions() {
  if (!fs.existsSync(composeFile)) {
    throw new Error(`docker compose file not found: ${composeFile}`);
  }

  const version = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(`docker is not available: ${String(version.stderr || version.stdout || "unknown error").trim()}`);
  }
  const dockerCompose = resolveDockerComposeCommand(spawnSync);
  if (!dockerCompose.ok) {
    throw new Error(dockerCompose.error);
  }
}

function ensureContainerUp() {
  const up = runDockerCompose(["up", "-d", serviceName]);
  if (up.status !== 0) {
    fail(`compose up failed: ${String(up.stderr || up.stdout || "unknown error").trim()}`);
    return false;
  }
  return true;
}

function isContainerRunning() {
  const ps = runDockerCompose(["ps", "--status", "running", "--services", serviceName]);
  if (ps.status !== 0) return false;
  return String(ps.stdout || "").split(/\r?\n/).map((s) => s.trim()).includes(serviceName);
}

function stopContainer() {
  const stop = runDockerCompose(["stop", serviceName]);
  if (stop.status !== 0) {
    fail(`compose stop failed: ${String(stop.stderr || stop.stdout || "unknown error").trim()}`);
  }
}

let timer = null;

function shutdown() {
  if (timer) clearInterval(timer);
  stopContainer();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  ensurePreconditions();
  ensureExclusiveServicePort();
  if (!ensureContainerUp()) process.exit(1);
  log(`container '${serviceName}' started with compose '${composeFile}'`);

  timer = setInterval(() => {
    try {
      ensureExclusiveServicePort();
    } catch (error) {
      fail(error.stack || error.message);
    }
    if (!isContainerRunning()) {
      fail(`container '${serviceName}' is not running; attempting restart`);
      ensureContainerUp();
    }
  }, Math.max(5_000, pollIntervalMs));
} catch (error) {
  fail(error.stack || error.message);
  process.exit(1);
}
