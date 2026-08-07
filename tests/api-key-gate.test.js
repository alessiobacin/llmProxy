"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createApp } = require("../lib/app");
const { createPaths, ensureRuntimeDirs } = require("../lib/paths");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function startApp(envOverrides) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmp-apikey-"));
  const paths = createPaths({ dataRoot });
  ensureRuntimeDirs(paths);
  const app = createApp({ env: { ...process.env, ...envOverrides }, dataRoot });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function request(baseUrl, pathname, headers) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ stream: false, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });
  return res.status;
}

async function requestStatus(baseUrl, pathname, headers) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ stream: false, max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = await res.text();
  return { status: res.status, body };
}

test("api-key gate: with LLMPROXY_API_KEY, /v1/messages requires the key", async () => {
  const { server, baseUrl } = await startApp({ LLMPROXY_API_KEY: "secret-123" });
  try {
    const noKey = await requestStatus(baseUrl, "/v1/messages");
    assert.strictEqual(noKey.status, 401, "missing key -> 401");
    assert.match(noKey.body, /UNAUTHORIZED/, "gate rejects with UNAUTHORIZED");

    const valid = await requestStatus(baseUrl, "/v1/messages", { authorization: "Bearer secret-123" });
    assert.doesNotMatch(valid.body, /UNAUTHORIZED/, "valid bearer passes the gate");
  } finally {
    server.close();
  }
});

test("api-key gate: without LLMPROXY_API_KEY, gate is not active (only provider errors possible)", async () => {
  const { server, baseUrl } = await startApp({ LLMPROXY_API_KEY: "", LLMPROXY_LLM_STATS_API_KEY: "x" });
  try {
    const res = await requestStatus(baseUrl, "/v1/messages");
    // Do not reject with UNAUTHORIZED: any error must come from provider resolution, not the gate.
    assert.doesNotMatch(res.body, /UNAUTHORIZED/, "no gate rejection when key unset");
  } finally {
    server.close();
  }
});