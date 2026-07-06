const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { createWindowsServiceManager } = require("../../lib/service/windows");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-win-test-"));

test("windows service manager renders service definition with expected metadata", () => {
  const manager = createWindowsServiceManager({
    label: "llmproxy",
    packageRoot: "/tmp/llmproxy-test",
    nodeExecutable: "/usr/local/bin/node",
    entryFile: "/tmp/llmproxy-test/server.js",
    wrapperPath: path.join(TMP, "service-runner.cmd"),
    stdoutPath: path.join(TMP, "service.out.log"),
    stderrPath: path.join(TMP, "service.err.log"),
    environment: { PORT: "5045", LLMPROXY_HOME: TMP },
  });

  const def = manager.renderServiceDefinition();
  assert.match(def, /llmproxy/);
  assert.match(def, /service-runner\.cmd/);
  assert.match(def, /service\.out\.log/);
  assert.match(def, /LLMPROXY_HOME/);
  assert.match(def, /Auto-restart/);
});

test("windows wrapper content includes env vars and paths", () => {
  const manager = createWindowsServiceManager({
    label: "llmproxy",
    packageRoot: TMP,
    nodeExecutable: process.execPath,
    entryFile: path.join(TMP, "server.js"),
    wrapperPath: path.join(TMP, "service-runner.cmd"),
    stdoutPath: path.join(TMP, "service.out.log"),
    stderrPath: path.join(TMP, "service.err.log"),
    environment: { PORT: "5045", LLMPROXY_HOME: TMP, NODE_ENV: "production" },
  });

  const wrapper = manager.renderWrapperContent();

  assert.match(wrapper, /@echo off/);
  assert.match(wrapper, /LLMPROXY_HOME/);
  assert.match(wrapper, /NODE_ENV/);
  assert.match(wrapper, /PORT/);
  assert.match(wrapper, /node/);
  assert.match(wrapper, /server\.js/);
  assert.match(wrapper, /service\.out\.log/);
  assert.doesNotMatch(wrapper, /\/opt\/homebrew\/bin/);
  assert.match(wrapper, /C:\\Windows\\System32/);
});

test("windows install creates wrapper, registers service, configures auto-restart, and starts", () => {
  const wrapperPath = path.join(TMP, "install-test-runner.cmd");
  const stdoutPath = path.join(TMP, "install-service.out.log");
  const stderrPath = path.join(TMP, "install-service.err.log");
  const scCalls = [];

  const manager = createWindowsServiceManager({
    label: "llmproxy",
    packageRoot: TMP,
    nodeExecutable: process.execPath,
    entryFile: path.join(TMP, "server.js"),
    wrapperPath,
    stdoutPath,
    stderrPath,
    environment: { PORT: "5045" },
    execSc(args) {
      scCalls.push(args);
      if (args[0] === "query") return { status: 1, stdout: "", stderr: "does not exist" };
      if (args[0] === "create") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "failure") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, true);
  assert.equal(result.serviceFile, wrapperPath);

  // verify wrapper .cmd was written
  assert.ok(fs.existsSync(wrapperPath));
  const wrapperContent = fs.readFileSync(wrapperPath, "utf8");
  assert.match(wrapperContent, /@echo off/);

  // verify sc.exe calls in order
  assert.ok(scCalls.length >= 3);
  assert.deepEqual(scCalls[0], ["query", "llmproxy"]);
  const createCall = scCalls.find((args) => args[0] === "create");
  assert.ok(createCall, "sc.exe create was called");
  assert.ok(createCall.some((a) => a.startsWith("binPath=")), "binPath= in create args");
  assert.ok(createCall.some((a) => a.startsWith("start=auto")), "start=auto in create args");
  assert.ok(scCalls.some((args) => args[0] === "failure"), "sc.exe failure was called");
  const startCall = scCalls.find((args) => args[0] === "start");
  assert.ok(startCall, "sc.exe start was called");
});

test("windows install prefers nssm when available", () => {
  const nssmCalls = [];
  const manager = createWindowsServiceManager({
    label: "llmproxy",
    packageRoot: TMP,
    nodeExecutable: process.execPath,
    entryFile: path.join(TMP, "server.js"),
    wrapperPath: path.join(TMP, "nssm-test-runner.cmd"),
    stdoutPath: path.join(TMP, "nssm-service.out.log"),
    stderrPath: path.join(TMP, "nssm-service.err.log"),
    environment: { PORT: "7045", LLMPROXY_HOME: TMP, PATH: "/opt/homebrew/bin:/usr/bin" },
    execSc(args) {
      if (args[0] === "query") return { status: 1, stdout: "", stderr: "does not exist" };
      return { status: 0, stdout: "", stderr: "" };
    },
    execNssm(args) {
      nssmCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, true);
  assert.ok(nssmCalls.some((args) => args[0] === "version"));
  assert.ok(nssmCalls.some((args) => args[0] === "install" && args[1] === "llmproxy"));
  const installCall = nssmCalls.find((args) => args[0] === "install" && args[1] === "llmproxy");
  assert.ok(installCall);
  assert.equal(installCall[2], process.execPath);
  assert.match(String(installCall[3]), /server\.js/);
  assert.ok(nssmCalls.some((args) => args[0] === "set" && args[2] === "AppEnvironmentExtra"));
  const envCall = nssmCalls.find((args) => args[0] === "set" && args[2] === "AppEnvironmentExtra");
  assert.ok(envCall);
  assert.ok(envCall.includes(`PORT=7045`));
  assert.ok(envCall.some((arg) => String(arg).includes("PATH=C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem")));
});

test("windows install handles already existing service by deleting it first", () => {
  const calls = [];
  const manager = createWindowsServiceManager({
    label: "llmproxy",
    packageRoot: TMP,
    wrapperPath: path.join(TMP, "existing-test-runner.cmd"),
    stdoutPath: path.join(TMP, "existing-service.out.log"),
    stderrPath: path.join(TMP, "existing-service.err.log"),
    execSc(args) {
      calls.push(args.join(" "));
      if (args[0] === "query") return { status: 0, stdout: "RUNNING", stderr: "" };
      if (args[0] === "stop") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "delete") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "create") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "failure") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "start") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, true);
  const joined = calls.join(" ");
  assert.match(joined, /query.*stop.*delete.*create.*failure.*start/);
});

test("windows start returns ok when service is already running", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "start") return { status: 1056, stdout: "", stderr: "service already running" };
      if (args[0] === "query") return { status: 0, stdout: "RUNNING", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.start();

  assert.equal(result.ok, true);
});

test("windows start returns failure on unexpected error", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "start") return { status: 1, stdout: "", stderr: "access denied" };
      if (args[0] === "query") return { status: 0, stdout: "STOPPED", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.start();

  assert.equal(result.ok, false);
  assert.match(result.stderr, /access denied/);
});

test("windows stop treats missing service as already stopped", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "stop") return { status: 1060, stdout: "", stderr: "The specified service does not exist as an installed service" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.stop();

  assert.equal(result.ok, true);
  assert.equal(result.stderr, "");
});

test("windows stop returns failure on unexpected error", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "stop") return { status: 1, stdout: "", stderr: "access denied" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.stop();

  assert.equal(result.ok, false);
});

test("windows status reports active when sc query shows running", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "query") return { status: 0, stdout: "RUNNING", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, true);
});

test("windows status reports active for localized sc output", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "query") return { status: 0, stdout: "STATO              : 4  RUNNING", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, true);
});

test("windows status falls back to inactive when sc query is stopped", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "query") return { status: 0, stdout: "STOPPED", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, false);
});

test("windows status handles missing service gracefully", () => {
  const manager = createWindowsServiceManager({
    execSc(args) {
      if (args[0] === "query") return { status: 1060, stdout: "", stderr: "The specified service does not exist as an installed service" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, false);
});
