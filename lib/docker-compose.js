"use strict";

const { spawnSync } = require("node:child_process");

function runCommand(commandRunner, command, args = [], spawnOptions = {}) {
  try {
    return commandRunner(command, args, { encoding: "utf8", ...spawnOptions });
  } catch (error) {
    return { status: 1, stdout: "", stderr: "", error };
  }
}

function resolveDockerComposeCommand(commandRunner = spawnSync, options = {}) {
  const spawnOptions = options.spawnOptions || {};
  const pluginResult = runCommand(commandRunner, "docker", ["compose", "version"], spawnOptions);
  if (pluginResult && pluginResult.status === 0) {
    return {
      ok: true,
      dockerAvailable: true,
      command: "docker",
      baseArgs: ["compose"],
      label: "docker compose",
    };
  }

  const legacyResult = runCommand(commandRunner, "docker-compose", ["version"], spawnOptions);
  if (legacyResult && legacyResult.status === 0) {
    return {
      ok: true,
      dockerAvailable: true,
      command: "docker-compose",
      baseArgs: [],
      label: "docker-compose",
    };
  }

  const dockerVersion = runCommand(commandRunner, "docker", ["--version"], spawnOptions);
  const dockerAvailable = dockerVersion && dockerVersion.status === 0;
  return {
    ok: false,
    dockerAvailable,
    error: dockerAvailable
      ? "Docker Compose non e' disponibile (`docker compose` e `docker-compose` falliscono)."
      : "Docker non e' disponibile nel PATH.",
  };
}

function runDockerCompose(commandRunner, composeFile, args = [], options = {}) {
  const spawnOptions = options.spawnOptions || {};
  const invocation = options.invocation || resolveDockerComposeCommand(commandRunner, { spawnOptions });
  if (!invocation.ok) {
    return {
      status: 1,
      stdout: "",
      stderr: invocation.error,
      invocation,
    };
  }
  const result = runCommand(commandRunner, invocation.command, [...invocation.baseArgs, "-f", composeFile, ...args], spawnOptions);
  return { ...result, invocation };
}

module.exports = {
  resolveDockerComposeCommand,
  runDockerCompose,
};
