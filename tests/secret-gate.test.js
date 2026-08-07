"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createTokenStore } = require("../lib/ts-build/gateway/providers/token-store");
const { createProviderRegistry } = require("../lib/ts-build/gateway/providers/provider-registry");

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function filePersistence(file) {
  return {
    read() {
      try {
        if (!fs.existsSync(file)) return { entries: [] };
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return { entries: [] };
      }
    },
    write(data) {
      fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    },
  };
}

test("LLMPROXY_SECRET inactive: token-store stores provider credentials in plaintext", () => {
  const file = tmpFile("nosec-token");
  try {
    const store = createTokenStore({ filePath: file, secret: null });
    store.saveProvider("opencode-test", {
      provider: "opencode",
      access_token: "sk-plain-token",
      default_model: "deepseek-v4-flash-free",
    });
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("sk-plain-token"), "access_token stored in plaintext when no secret");
    assert.ok(!raw.includes("enc.v1:"), "no encryption prefix when no secret");
    const reopened = createTokenStore({ filePath: file, secret: null });
    assert.strictEqual(reopened.getProvider("opencode-test").access_token, "sk-plain-token");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("LLMPROXY_SECRET inactive: provider-registry stores credentials in plaintext", () => {
  const file = tmpFile("nosec-registry");
  try {
    const persistence = filePersistence(file);
    const registry = createProviderRegistry({ persistence, secret: null });
    registry.upsert({
      provider: "openai",
      scope_type: "master",
      scope_id: "*",
      priority: 100,
      credentials: { api_key: "sk-reg-plain" },
    });
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("sk-reg-plain"), "registry credentials stored in plaintext when no secret");
    assert.ok(!raw.includes("enc.v1:"), "no encryption prefix when no secret");
  } finally {
    fs.rmSync(file, { force: true });
  }
});