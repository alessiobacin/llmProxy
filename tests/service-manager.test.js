const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createLaunchdServiceManager } = require("../lib/service/launchd");

test("launchd service manager renders a plist with expected paths and label", () => {
  const manager = createLaunchdServiceManager({
    label: "com.example.llmproxy",
    packageRoot: "/opt/llmproxy",
    nodeExecutable: "/usr/local/bin/node",
    entryFile: "/opt/llmproxy/server.js",
    serviceFile: path.join("/Users/example/Library/LaunchAgents", "com.example.llmproxy.plist"),
    stdoutPath: "/Users/example/Library/Application Support/llmProxy/logs/service.out.log",
    stderrPath: "/Users/example/Library/Application Support/llmProxy/logs/service.err.log",
    environment: { PORT: "3015", LLMPROXY_HOME: "/Users/example/Library/Application Support/llmProxy" },
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