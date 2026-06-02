const test = require("node:test");
const assert = require("node:assert/strict");

const { getDataRoot, createPaths } = require("../lib/paths");

test("getDataRoot uses a distinct per-user runtime root on macOS", () => {
  const userOneRoot = getDataRoot({
    env: {},
    homeDir: "/Users/alice",
    platform: "darwin",
  });
  const userTwoRoot = getDataRoot({
    env: {},
    homeDir: "/Users/bob",
    platform: "darwin",
  });

  assert.equal(userOneRoot, "/Users/alice/Library/Application Support/llmProxy");
  assert.equal(userTwoRoot, "/Users/bob/Library/Application Support/llmProxy");
  assert.notEqual(userOneRoot, userTwoRoot);
});

test("createPaths keeps token and log files isolated per user runtime root", () => {
  const userOnePaths = createPaths({
    env: {},
    homeDir: "/Users/alice",
    platform: "darwin",
    packageRoot: "/srv/llmproxy",
  });
  const userTwoPaths = createPaths({
    env: {},
    homeDir: "/Users/bob",
    platform: "darwin",
    packageRoot: "/srv/llmproxy",
  });

  assert.equal(userOnePaths.tokenFile, "/Users/alice/Library/Application Support/llmProxy/copilot-token.json");
  assert.equal(userTwoPaths.tokenFile, "/Users/bob/Library/Application Support/llmProxy/copilot-token.json");
  assert.equal(userOnePaths.stdoutLogFile, "/Users/alice/Library/Application Support/llmProxy/logs/service.out.log");
  assert.equal(userTwoPaths.stdoutLogFile, "/Users/bob/Library/Application Support/llmProxy/logs/service.out.log");
  assert.notEqual(userOnePaths.dataRoot, userTwoPaths.dataRoot);
});