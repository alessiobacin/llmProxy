"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  classifierProvider: null,
  classifierModel: null,
  classifierApiKey: null,
  enabled: false,
};

function readConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(filePath, config) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

function createSmartRouterStore(options = {}) {
  if (!options.filePath) throw new Error("SMART_ROUTER_STORE_FILEPATH_REQUIRED");

  let memoryCache = null;

  function getConfig() {
    if (!memoryCache) memoryCache = readConfig(options.filePath);
    return { ...DEFAULT_CONFIG, ...memoryCache };
  }

  function setConfig(updates) {
    const current = getConfig();
    const merged = { ...current, ...updates };
    memoryCache = merged;
    writeConfig(options.filePath, merged);
  }

  function isConfigured() {
    const config = getConfig();
    return !!(config.classifierProvider && config.classifierModel && config.classifierApiKey);
  }

  return { getConfig, setConfig, isConfigured };
}

module.exports = { createSmartRouterStore };
