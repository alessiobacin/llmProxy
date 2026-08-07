"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createApp } = require("../lib/app");

test("production app emits baseline security headers", async () => {
  const app = createApp({
    mode: "standalone",
    env: {
      ...process.env,
      NODE_ENV: "production",
      LLMPROXY_ENV: "production",
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_GLOBAL_SERVICE: "1",
      LLMPROXY_API_KEY: "test-inbound-key",
    },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
    assert.equal(response.headers.get("x-powered-by"), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("production config endpoints fail closed without an inbound API key", async () => {
  const app = createApp({
    mode: "standalone",
    env: {
      ...process.env,
      NODE_ENV: "production",
      LLMPROXY_ENV: "production",
      LLMPROXY_RUNTIME_PROFILE: "production",
      LLMPROXY_GLOBAL_SERVICE: "1",
      LLMPROXY_API_KEY: "",
    },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config`);
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Dockerfile runs the service as a non-root user", () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");
  assert.match(dockerfile, /USER node/);
});
