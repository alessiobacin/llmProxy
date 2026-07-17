"use strict";
// V11 proxy registry — simple JSON-backed store for proxy URLs.

const fs = require("node:fs");
const path = require("node:path");

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function normalizeProxyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return s;
  // Se non ha uno schema, aggiungi http://
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return "http://" + s;
  return s;
}

function extractHostname(urlStr) {
  try {
    const parsed = new URL(normalizeProxyUrl(urlStr));
    return parsed.hostname;
  } catch {
    return null;
  }
}

function createProxyStore(options = {}) {
  const filePath = options.filePath;
  if (!filePath) throw new Error("proxy-store filePath required");

  function read() {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { version: 1, proxies: [], order: [] };
      return {
        version: 1,
        proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
        order: Array.isArray(parsed.order) ? parsed.order : [],
      };
    } catch (err) {
      if (err && err.code === "ENOENT") return { version: 1, proxies: [], order: [] };
      throw err;
    }
  }

  function write(store) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { mode: FILE_MODE });
    fs.chmodSync(filePath, FILE_MODE);
  }

  function addProxy(url) {
    const normalizedUrl = normalizeProxyUrl(url);
    if (!normalizedUrl) throw new Error("INVALID_PROXY_URL");
    // Verify it parses
    const hostname = extractHostname(normalizedUrl);
    if (!hostname) throw new Error("INVALID_PROXY_URL");

    const now = Date.now();
    const store = read();
    const existing = store.proxies.find((p) => p.id === hostname);

    if (existing) {
      existing.url = normalizedUrl;
      existing.updated_at = now;
    } else {
      const proxy = {
        id: hostname,
        url: normalizedUrl,
        host: hostname,
        created_at: now,
        updated_at: now,
      };
      store.proxies.push(proxy);
      store.order.push(hostname);
    }

    write(store);
    return getProxy(hostname);
  }

  function removeProxy(id) {
    const store = read();
    const idx = store.order.indexOf(id);
    if (idx === -1) return false;
    store.order.splice(idx, 1);
    store.proxies = store.proxies.filter((p) => p.id !== id);
    write(store);
    return true;
  }

  function listProxies() {
    const store = read();
    const orderMap = {};
    store.order.forEach((id, i) => { orderMap[id] = i; });
    return store.proxies
      .filter((p) => store.order.includes(p.id))
      .sort((a, b) => (orderMap[a.id] || 0) - (orderMap[b.id] || 0));
  }

  function getProxy(id) {
    const store = read();
    return store.proxies.find((p) => p.id === id) || null;
  }

  function setProxyOrder(ids) {
    const store = read();
    const normalized = Array.isArray(ids) ? ids.filter((id) => store.proxies.some((p) => p.id === id)) : [];
    for (const p of store.proxies) {
      if (!normalized.includes(p.id)) normalized.push(p.id);
    }
    store.order = normalized;
    write(store);
    return listProxies();
  }

  function clearProxy(id) {
    const store = read();
    store.proxies = store.proxies.filter((p) => p.id !== id);
    store.order = store.order.filter((o) => o !== id);
    if (store.proxies.length === 0) {
      try { fs.rmSync(filePath, { force: true }); } catch (err) { if (err && err.code !== "ENOENT") throw err; }
      return null;
    }
    write(store);
    return store.proxies;
  }

  return { addProxy, removeProxy, listProxies, getProxy, setProxyOrder, clearProxy };
}

module.exports = { createProxyStore };
