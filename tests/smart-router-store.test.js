"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createSmartRouterStore } = require("../lib/smart-router-store");

function makeTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-router-store-test-"));
  const filePath = path.join(dir, "smart-router.json");
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("smart-router-store", () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempFile();
  });

  describe("createSmartRouterStore", () => {
    it("ritorna oggetto con getConfig, setConfig, isConfigured", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      assert.equal(typeof store.getConfig, "function");
      assert.equal(typeof store.setConfig, "function");
      assert.equal(typeof store.isConfigured, "function");
      tmp.cleanup();
    });
  });

  describe("getConfig", () => {
    it("ritorna config vuota quando file non esiste", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      const config = store.getConfig();
      assert.deepEqual(config, {
        classifierProvider: null,
        classifierModel: null,
        classifierApiKey: null,
        enabled: false,
      });
      tmp.cleanup();
    });

    it("legge config salvata su disco", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      store.setConfig({
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-test",
        enabled: true,
      });

      const config = store.getConfig();
      assert.equal(config.classifierProvider, "openrouter");
      assert.equal(config.classifierModel, "deepseek-chat");
      assert.equal(config.classifierApiKey, "sk-or-test");
      assert.equal(config.enabled, true);
      tmp.cleanup();
    });
  });

  describe("setConfig", () => {
    it("persiste config su disco", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      store.setConfig({
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        enabled: true,
      });

      // Verifica che il file esista e contenga i dati
      const raw = JSON.parse(fs.readFileSync(tmp.filePath, "utf8"));
      assert.equal(raw.classifierProvider, "openrouter");
      assert.equal(raw.classifierModel, "deepseek-chat");
      assert.equal(raw.enabled, true);
      tmp.cleanup();
    });

    it("merge con config esistente (partial update)", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      store.setConfig({
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        enabled: true,
      });
      store.setConfig({ classifierModel: "qwen-max" });

      const config = store.getConfig();
      assert.equal(config.classifierProvider, "openrouter");
      assert.equal(config.classifierModel, "qwen-max");
      assert.equal(config.enabled, true);
      tmp.cleanup();
    });
  });

  describe("isConfigured", () => {
    it("ritorna false quando nessuna config presente", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      assert.equal(store.isConfigured(), false);
      tmp.cleanup();
    });

    it("ritorna true quando provider, model e api key sono settati", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      store.setConfig({
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-test",
        enabled: true,
      });
      assert.equal(store.isConfigured(), true);
      tmp.cleanup();
    });

    it("ritorna false quando manca api key", () => {
      const store = createSmartRouterStore({ filePath: tmp.filePath });
      store.setConfig({
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        enabled: true,
      });
      assert.equal(store.isConfigured(), false);
      tmp.cleanup();
    });
  });

  describe("reload from disk", () => {
    it("nuova istanza legge config scritta da istanza precedente", () => {
      const store1 = createSmartRouterStore({ filePath: tmp.filePath });
      store1.setConfig({
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-123",
        enabled: true,
      });

      const store2 = createSmartRouterStore({ filePath: tmp.filePath });
      const config = store2.getConfig();
      assert.equal(config.classifierProvider, "openrouter");
      assert.equal(config.classifierModel, "deepseek-chat");
      assert.equal(store2.isConfigured(), true);
      tmp.cleanup();
    });
  });
});
