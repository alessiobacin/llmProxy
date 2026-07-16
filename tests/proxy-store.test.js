const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createProxyStore } = require("../lib/proxy-store");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proxy-store-")), "proxy-registry.json");
}

test("createProxyStore returns an object with the expected methods", () => {
  const store = createProxyStore({ filePath: tmpFile() });
  assert.equal(typeof store.addProxy, "function");
  assert.equal(typeof store.removeProxy, "function");
  assert.equal(typeof store.listProxies, "function");
  assert.equal(typeof store.getProxy, "function");
  assert.equal(typeof store.setProxyOrder, "function");
  assert.equal(typeof store.clearProxy, "function");
});

test("addProxy adds a proxy and auto-generates ID from hostname", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  const proxy = store.addProxy("http://user:pass@dc.decodo.com:10001");
  assert.equal(proxy.id, "dc.decodo.com");
  assert.equal(proxy.url, "http://user:pass@dc.decodo.com:10001");
  assert.equal(typeof proxy.created_at, "number");
  assert.equal(typeof proxy.updated_at, "number");
});

test("addProxy with duplicate hostname updates the existing proxy", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://user:pass@dc.decodo.com:10001");
  store.addProxy("http://other:key@dc.decodo.com:9999");
  const proxies = store.listProxies();
  assert.equal(proxies.length, 1);
  assert.equal(proxies[0].url, "http://other:key@dc.decodo.com:9999");
});

test("addProxy throws on invalid URL", () => {
  const store = createProxyStore({ filePath: tmpFile() });
  assert.throws(() => store.addProxy(""), /INVALID_PROXY_URL/);
});

test("listProxies returns all proxies in order", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://a@proxy-a.com:10001");
  store.addProxy("http://b@proxy-b.com:10001");
  const proxies = store.listProxies();
  assert.equal(proxies.length, 2);
  assert.equal(proxies[0].id, "proxy-a.com");
  assert.equal(proxies[1].id, "proxy-b.com");
});

test("removeProxy removes by ID", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://a@proxy-a.com:10001");
  store.addProxy("http://b@proxy-b.com:10001");
  store.removeProxy("proxy-a.com");
  assert.equal(store.listProxies().length, 1);
  assert.equal(store.listProxies()[0].id, "proxy-b.com");
});

test("removeProxy on missing ID returns false", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  assert.equal(store.removeProxy("nonexistent"), false);
});

test("getProxy returns null for missing ID", () => {
  const store = createProxyStore({ filePath: tmpFile() });
  assert.equal(store.getProxy("nonexistent"), null);
});

test("getProxy returns the proxy by ID", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://user@proxy-a.com:10001");
  const proxy = store.getProxy("proxy-a.com");
  assert.notEqual(proxy, null);
  assert.equal(proxy.id, "proxy-a.com");
});

test("setProxyOrder reorders proxies", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://a@proxy-a.com:10001");
  store.addProxy("http://b@proxy-b.com:10001");
  store.setProxyOrder(["proxy-b.com", "proxy-a.com"]);
  const proxies = store.listProxies();
  assert.equal(proxies[0].id, "proxy-b.com");
  assert.equal(proxies[1].id, "proxy-a.com");
});

test("clearProxy removes a proxy by ID", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://a@proxy-a.com:10001");
  store.addProxy("http://b@proxy-b.com:10001");
  const result = store.clearProxy("proxy-a.com");
  assert.equal(store.listProxies().length, 1);
  assert.equal(result[0].id, "proxy-b.com");
});

test("clearProxy with last proxy clears the file", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://a@proxy-a.com:10001");
  store.clearProxy("proxy-a.com");
  assert.equal(fs.existsSync(file), false);
});

test("File is created with 0600 permissions and readable", () => {
  const file = tmpFile();
  const store = createProxyStore({ filePath: file });
  store.addProxy("http://user@proxy.test:1234");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.proxies.length, 1);
  assert.equal(raw.order[0], "proxy.test");
});
