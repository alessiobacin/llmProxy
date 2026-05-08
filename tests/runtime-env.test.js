const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadRuntimeEnv } = require("../lib/runtime-env");

test("loadRuntimeEnv keeps local checkout defaults from .env in development", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-local-"));
  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nHOST=127.0.0.1\nLLMPROXY_ENV=development\nDBLAYER_URL=http://localhost:5046\n", "utf8");

  const env = loadRuntimeEnv({ env: {}, packageRoot });

  assert.equal(env.PORT, "5045");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.LLMPROXY_ENV, "development");
  assert.equal(env.DBLAYER_URL, "http://localhost:5046");
});

test("loadRuntimeEnv ignores package .env for global installs and defaults to production ports", () => {
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-global-")), "node_modules", "llmproxy");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nHOST=127.0.0.1\nLLMPROXY_ENV=development\nDBLAYER_URL=http://localhost:5046\nEVENTBUS_URL=http://localhost:5048\n", "utf8");

  const env = loadRuntimeEnv({ env: {}, packageRoot });

  assert.equal(env.PORT, "7045");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.LLMPROXY_ENV, "production");
  assert.equal(env.DBLAYER_URL, "http://localhost:7046");
  assert.equal(env.EVENTBUS_URL, "http://localhost:7048");
});

test("loadRuntimeEnv resolves staging defaults when explicitly requested", () => {
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-staging-")), "node_modules", "llmproxy");
  fs.mkdirSync(packageRoot, { recursive: true });

  const env = loadRuntimeEnv({
    env: { LLMPROXY_ENV: "staging" },
    packageRoot,
  });

  assert.equal(env.PORT, "6045");
  assert.equal(env.LLMPROXY_ENV, "staging");
  assert.equal(env.DBLAYER_URL, "http://localhost:6046");
  assert.equal(env.EVENTBUS_URL, "http://localhost:6048");
});

test("loadRuntimeEnv honors an explicit runtime profile even when the package root is the local checkout", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-explicit-profile-"));
  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nLLMPROXY_ENV=development\nDBLAYER_URL=http://localhost:5046\n", "utf8");

  const env = loadRuntimeEnv({
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    packageRoot,
  });

  assert.equal(env.PORT, "7045");
  assert.equal(env.LLMPROXY_ENV, "production");
  assert.equal(env.DBLAYER_URL, "http://localhost:7046");
});