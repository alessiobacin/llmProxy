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
    environment: { PORT: "4141", LLMPROXY_HOME: "/Users/example/Library/Application Support/llmProxy" },
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