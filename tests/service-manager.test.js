const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createLaunchdServiceManager } = require("../lib/service/launchd");
const { createSystemdServiceManager } = require("../lib/service/systemd");

test("launchd service manager renders a plist with expected paths and label", () => {
  const manager = createLaunchdServiceManager({
    label: "com.example.llmproxy",
    packageRoot: "/opt/llmproxy",
    nodeExecutable: "/usr/local/bin/node",
    entryFile: "/opt/llmproxy/server.js",
    serviceFile: path.join("/Users/example/Library/LaunchAgents", "com.example.llmproxy.plist"),
    stdoutPath: "/Users/example/Library/Application Support/llmProxy/logs/service.out.log",
    stderrPath: "/Users/example/Library/Application Support/llmProxy/logs/service.err.log",
    environment: { PORT: "5045", LLMPROXY_HOME: "/Users/example/Library/Application Support/llmProxy" },
  });

  const plist = manager.renderServiceDefinition();
  assert.match(plist, /com\.example\.llmproxy/);
  assert.match(plist, /\/usr\/local\/bin\/node/);
  assert.match(plist, /\/opt\/llmproxy\/server\.js/);
  assert.match(plist, /service\.out\.log/);
  assert.match(plist, /LLMPROXY_HOME/);
});

test("launchd status reports active service when launchctl print succeeds", () => {
  const manager = createLaunchdServiceManager({
    execLaunchctl() {
      return {
        status: 0,
        stdout: "service = active",
        stderr: "",
      };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, true);
  assert.equal(status.stderr, "");
});

test("launchd status treats missing service as inactive without surfacing an error", () => {
  const manager = createLaunchdServiceManager({
    execLaunchctl() {
      return {
        status: 113,
        stdout: "",
        stderr: 'Bad request.\nCould not find service "com.llmproxy.service" in domain for user gui: 501\n',
      };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, false);
  assert.equal(status.stderr, "");
});

test("launchd treats bootout 'No such process' as a missing service", () => {
  const manager = createLaunchdServiceManager({
    serviceFile: path.join("/tmp", "llmproxy-launchd-missing.plist"),
    stdoutPath: "/tmp/llmproxy-launchd-missing.out.log",
    stderrPath: "/tmp/llmproxy-launchd-missing.err.log",
    execLaunchctl(args) {
      if (args[0] === "bootout") {
        return {
          status: 3,
          stdout: "",
          stderr: "Boot-out failed: 3: No such process\n",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, true);
});

test("launchd install surfaces bootstrap failures", () => {
  const manager = createLaunchdServiceManager({
    serviceFile: path.join("/tmp", "llmproxy-launchd-bootstrap.plist"),
    stdoutPath: "/tmp/llmproxy-launchd-bootstrap.out.log",
    stderrPath: "/tmp/llmproxy-launchd-bootstrap.err.log",
    execLaunchctl(args) {
      if (args[0] === "bootout") {
        return { status: 113, stdout: "", stderr: 'Could not find service "com.llmproxy.service"' };
      }
      if (args[0] === "bootstrap") {
        return { status: 5, stdout: "", stderr: "bootstrap failed" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, false);
  assert.match(result.stderr, /bootstrap failed/);
});

test("launchd install retries bootstrap after transient input/output errors", () => {
  const calls = [];
  const manager = createLaunchdServiceManager({
    serviceFile: path.join("/tmp", "llmproxy-launchd-bootstrap-retry.plist"),
    stdoutPath: "/tmp/llmproxy-launchd-bootstrap-retry.out.log",
    stderrPath: "/tmp/llmproxy-launchd-bootstrap-retry.err.log",
    execLaunchctl(args) {
      calls.push(args[0]);
      if (args[0] === "bootout") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "bootstrap" && calls.filter((call) => call === "bootstrap").length === 1) {
        return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["bootout", "bootstrap", "bootstrap", "kickstart"]);
});

test("launchd start surfaces kickstart failures", () => {
  const manager = createLaunchdServiceManager({
    execLaunchctl(args) {
      if (args[0] === "bootstrap") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "kickstart") {
        return { status: 3, stdout: "", stderr: "kickstart failed" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.start();

  assert.equal(result.ok, false);
  assert.match(result.stderr, /kickstart failed/);
});

test("launchd stop treats missing service as already stopped", () => {
  const manager = createLaunchdServiceManager({
    execLaunchctl(args) {
      if (args[0] === "bootout") {
        return { status: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.stop();

  assert.equal(result.ok, true);
  assert.equal(result.stderr, "");
});

test("systemd status uses runtime dir env for user bus access", () => {
  const calls = [];
  const manager = createSystemdServiceManager({
    userId: 1000,
    execSystemctl(args, spawnOptions) {
      calls.push({ args, spawnOptions });
      return {
        status: 0,
        stdout: "active",
        stderr: "",
      };
    },
  });

  const status = manager.status();

  assert.equal(status.ok, true);
  assert.equal(status.active, true);
  assert.deepEqual(calls[0].args, ["status", "llmproxy.service", "--no-pager"]);
  assert.equal(calls[0].spawnOptions.env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(calls[0].spawnOptions.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
});

test("systemd install enables linger for the current user and fails when systemctl fails", () => {
  const loginctlCalls = [];
  const systemctlCalls = [];
  const manager = createSystemdServiceManager({
    username: "alessio",
    userId: 1000,
    packageRoot: "/opt/llmproxy",
    serviceFile: path.join("/tmp", "llmproxy.service"),
    stdoutPath: "/tmp/llmproxy.out.log",
    stderrPath: "/tmp/llmproxy.err.log",
    execLoginctl(args) {
      loginctlCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    execSystemctl(args) {
      systemctlCalls.push(args);
      return args[0] === "enable"
        ? { status: 1, stdout: "", stderr: "enable failed" }
        : { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, false);
  assert.deepEqual(loginctlCalls[0], ["enable-linger", "alessio"]);
  assert.deepEqual(systemctlCalls[0], ["daemon-reload"]);
  assert.deepEqual(systemctlCalls[1], ["enable", "llmproxy.service"]);
  assert.deepEqual(systemctlCalls[2], ["is-active", "--quiet", "llmproxy.service"]);
  assert.deepEqual(systemctlCalls[3], ["restart", "llmproxy.service"]);
  assert.match(result.stderr, /enable failed/);
});

test("systemd install restarts an already active service so updated units take effect", () => {
  const systemctlCalls = [];
  const manager = createSystemdServiceManager({
    username: "aqdas",
    userId: 1001,
    packageRoot: "/opt/llmproxy",
    serviceFile: path.join("/tmp", "llmproxy-restart.service"),
    stdoutPath: "/tmp/llmproxy-restart.out.log",
    stderrPath: "/tmp/llmproxy-restart.err.log",
    execLoginctl() {
      return { status: 0, stdout: "", stderr: "" };
    },
    execSystemctl(args) {
      systemctlCalls.push(args);
      if (args[0] === "is-active") return { status: 0, stdout: "active", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  const result = manager.install();

  assert.equal(result.ok, true);
  assert.deepEqual(systemctlCalls[0], ["daemon-reload"]);
  assert.deepEqual(systemctlCalls[1], ["enable", "llmproxy.service"]);
  assert.deepEqual(systemctlCalls[2], ["is-active", "--quiet", "llmproxy.service"]);
  assert.deepEqual(systemctlCalls[3], ["restart", "llmproxy.service"]);
});
