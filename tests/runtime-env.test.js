const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadRuntimeEnv, resolveProxyHostPort, resolveServiceUrlForProfile } = require("../lib/runtime-env");

test("loadRuntimeEnv keeps local checkout defaults from .env in development", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-local-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-local-data-"));
  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nHOST=127.0.0.1\nLLMPROXY_ENV=development\nDBLAYER_URL=http://localhost:5001\n", "utf8");

  const env = loadRuntimeEnv({ env: {}, packageRoot, dataRoot });

  assert.equal(env.PORT, "5045");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.LLMPROXY_ENV, "development");
  assert.equal(env.DBLAYER_URL, "http://localhost:5001");
});

test("loadRuntimeEnv ignores package .env for global installs and defaults to production ports", () => {
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-global-")), "node_modules", "llmproxy");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-global-data-"));
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nHOST=127.0.0.1\nLLMPROXY_ENV=development\nDBLAYER_URL=http://localhost:5001\nEVENTBUS_URL=http://localhost:5048\n", "utf8");

  const env = loadRuntimeEnv({ env: {}, packageRoot, dataRoot });

  assert.equal(env.PORT, undefined);
  assert.equal(env.HOST, undefined);
  assert.equal(env.LLMPROXY_ENV, "production");
  assert.equal(env.DBLAYER_URL, "http://localhost:7001");
  assert.equal(env.EVENTBUS_URL, "http://localhost:7048");
});

test("loadRuntimeEnv resolves staging defaults when explicitly requested", () => {
  const packageRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-staging-")), "node_modules", "llmproxy");
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-staging-data-"));
  fs.mkdirSync(packageRoot, { recursive: true });

  const env = loadRuntimeEnv({
    env: { LLMPROXY_ENV: "staging" },
    packageRoot,
    dataRoot,
  });

  assert.equal(env.PORT, undefined);
  assert.equal(env.LLMPROXY_ENV, "staging");
  assert.equal(env.DBLAYER_URL, "http://localhost:6001");
  assert.equal(env.EVENTBUS_URL, "http://localhost:6048");
});

test("loadRuntimeEnv honors an explicit runtime profile even when the package root is the local checkout", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-explicit-profile-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-runtime-explicit-profile-data-"));
  fs.writeFileSync(path.join(packageRoot, ".env"), "PORT=5045\nLLMPROXY_ENV=development\nDBLAYER_URL=http://localhost:5001\n", "utf8");

  const env = loadRuntimeEnv({
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    packageRoot,
    dataRoot,
  });

  assert.equal(env.PORT, undefined);
  assert.equal(env.LLMPROXY_ENV, "production");
  assert.equal(env.DBLAYER_URL, "http://localhost:7001");
});

test("resolveProxyHostPort uses the fixed production service port when the runtime profile is production", () => {
  const binding = resolveProxyHostPort({
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    dataRoot: "/Users/alessiobacin/Library/Application Support/llmProxy",
  });

  assert.deepEqual(binding, { host: "127.0.0.1", port: "7045" });
});

test("resolveProxyHostPort uses the fixed staging service port when the runtime profile is staging", () => {
  const binding = resolveProxyHostPort({
    env: { LLMPROXY_ENV: "staging" },
    dataRoot: "/Users/alessiobacin/Library/Application Support/llmProxy",
  });

  assert.deepEqual(binding, { host: "127.0.0.1", port: "6045" });
});

test("resolveProxyHostPort keeps the shared production port across different user data roots", () => {
  const aliceBinding = resolveProxyHostPort({
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    dataRoot: "/Users/alice/Library/Application Support/llmProxy",
  });
  const bobBinding = resolveProxyHostPort({
    env: { LLMPROXY_RUNTIME_PROFILE: "production" },
    dataRoot: "/Users/bob/Library/Application Support/llmProxy",
  });

  assert.deepEqual(aliceBinding, { host: "127.0.0.1", port: "7045" });
  assert.deepEqual(bobBinding, { host: "127.0.0.1", port: "7045" });
});

test("resolveServiceUrlForProfile passes through URL with matching port", () => {
  const result = resolveServiceUrlForProfile("http://localhost:7048", "7048");
  assert.equal(result, "http://localhost:7048");
});

test("resolveServiceUrlForProfile corrects URL with wrong port", () => {
  const result = resolveServiceUrlForProfile("http://localhost:5048", "7048");
  assert.equal(result, "http://localhost:7048");
});

test("resolveServiceUrlForProfile preserves path when correcting port", () => {
  const result = resolveServiceUrlForProfile("http://localhost:5048/api/v1/events", "7048");
  assert.equal(result, "http://localhost:7048/api/v1/events");
});

test("resolveServiceUrlForProfile passes through URL without port", () => {
  const result = resolveServiceUrlForProfile("http://event-bus.internal", "7048");
  assert.equal(result, "http://event-bus.internal");
});

test("resolveServiceUrlForProfile passes through invalid URL", () => {
  const result = resolveServiceUrlForProfile("not-a-url", "7048");
  assert.equal(result, "not-a-url");
});

test("loadRuntimeEnv auto-corrects EVENTBUS_URL to match profile in production", () => {
  const packageRoot = require("node:path").join(
    require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "llmproxy-runtime-prod-eventbus-")),
    "node_modules", "llmproxy",
  );
  require("node:fs").mkdirSync(packageRoot, { recursive: true });

  const env = loadRuntimeEnv({
    env: { LLMPROXY_RUNTIME_PROFILE: "production", EVENTBUS_URL: "http://localhost:5048" },
    packageRoot,
    dataRoot: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "llmproxy-runtime-prod-eventbus-data-")),
  });

  assert.equal(env.EVENTBUS_URL, "http://localhost:7048");
});

test("loadRuntimeEnv auto-corrects DBLAYER_URL to match profile in production", () => {
  const packageRoot = require("node:path").join(
    require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "llmproxy-runtime-prod-dblayer-")),
    "node_modules", "llmproxy",
  );
  require("node:fs").mkdirSync(packageRoot, { recursive: true });

  const env = loadRuntimeEnv({
    env: { LLMPROXY_RUNTIME_PROFILE: "production", DBLAYER_URL: "http://localhost:5001" },
    packageRoot,
    dataRoot: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "llmproxy-runtime-prod-dblayer-data-")),
  });

  assert.equal(env.DBLAYER_URL, "http://localhost:7001");
});
