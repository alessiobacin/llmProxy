# Proxy Registry & Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proxy registry (add/list/remove/reorder/test) and rotation to `llmproxy` CLI.

**Architecture:** New standalone `lib/proxy-store.js` module (JSON file persistence, identically patterned to `lib/token-store.js`). CLI commands follow existing `provider:*` dispatch pattern. Runtime rotation via `makeProxyFetch` in `copilot-proxy.js` reading from proxy store.

**Tech Stack:** Node.js 22+, plain JS modules, Node test runner.

## Global Constraints

- Use `node:test` + `node:assert/strict` for tests (existing pattern)
- Follow existing `token-store.js` patterns for proxy store
- Use same `dataRoot` for proxy registry file (next to `copilot-token.json`)
- CLI dispatch uses `if (parsed.command === "...")` chain in `runCli()`
- All short aliases in `SHORT_COMMAND_ALIASES` object
- REST build translation in `buildRestCommandRequest()` function

---

### Task 1: Create lib/proxy-store.js

**Files:**
- Create: `lib/proxy-store.js`
- Test: `tests/proxy-store.test.js`

**Interfaces:**
- Produces: `createProxyStore({ filePath })` → `{ addProxy, removeProxy, listProxies, getProxy, setProxyOrder, clearProxy }`

- [ ] **Step 1: Write the failing tests**

```js
// tests/proxy-store.test.js
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/proxy-store.test.js 2>&1
```

Expected: FAIL with "Cannot find module '../lib/proxy-store'"

- [ ] **Step 3: Write proxy-store.js**

```js
"use strict";
// V11 proxy registry — simple JSON-backed store for proxy URLs.

const fs = require("node:fs");
const path = require("node:path");

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function extractHostname(urlStr) {
  try {
    const parsed = new URL(urlStr);
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
    const normalizedUrl = String(url || "").trim();
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
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
      return null;
    }
    write(store);
    return store.proxies;
  }

  return { addProxy, removeProxy, listProxies, getProxy, setProxyOrder, clearProxy };
}

module.exports = { createProxyStore };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/proxy-store.test.js 2>&1
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/proxy-store.js tests/proxy-store.test.js
git commit -m "feat(llmp): add proxy-store module for proxy registry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire proxy registry path into paths.js and CLI bootstrap

**Files:**
- Modify: `lib/paths.js:49` (add proxyRegistryFile)
- Modify: `lib/cli.js:4146-4150` (create proxyStore)

**Interfaces:**
- Consumes: `createProxyStore` from `lib/proxy-store.js`
- Produces: `paths.proxyRegistryFile` path, `proxyStore` instance in CLI

- [ ] **Step 1: Add proxyRegistryFile path**

In `lib/paths.js`, after line 49 (`providerRegistryFile`), add:
```js
    proxyRegistryFile: path.join(dataRoot, "proxy-registry.json"),
```

- [ ] **Step 2: Create proxyStore in CLI bootstrap**

In `lib/cli.js`, after line 4147 (`providerRegistry`), add:
```js
  const proxyStore = options.proxyStore || require("./proxy-store").createProxyStore({
    filePath: paths.proxyRegistryFile,
  });
```

- [ ] **Step 3: Verify the code loads without errors**

```bash
node -e "require('./lib/paths').createPaths({dataRoot:'/tmp', packageRoot:'.'})" 2>&1
node -e "const ps = require('./lib/proxy-store'); ps.createProxyStore({filePath:'/tmp/test-proxy.json'})" 2>&1
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add lib/paths.js lib/cli.js
git commit -m "feat(llmp): wire proxyStore into paths and CLI bootstrap

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add proxy:* CLI commands (add, remove, list)

**Files:**
- Modify: `lib/cli.js` (short aliases, help text, command handlers)

**Interfaces:**
- Consumes: `proxyStore` from Task 2

- [ ] **Step 1: Add short aliases**

In `SHORT_COMMAND_ALIASES` (around line 107), add:
```js
  "px:a": "proxy:add",
  "px:l": "proxy:list",
  "px:rm": "proxy:remove",
  "px:ro": "proxy:reorder",
  "px:t": "proxy:test",
```

- [ ] **Step 2: Add help text**

In the COMMAND_HELP section (around line 360), add entries for each proxy command:

```js
  "proxy:add": {
    usage: "llmproxy proxy:add <url>",
    description: "Aggiunge un proxy alla registry. Il formato URL include credenziali: http://user:pass@host:port",
    when: "Usalo per registrare un proxy da usare in rotazione con --proxy (senza valore).",
    example: 'llmproxy proxy:add http://spwr54teap:key@dc.decodo.com:10001',
  },
  "proxy:list": {
    usage: "llmproxy proxy:list",
    description: "Elenca tutti i proxy registrati in ordine di failover.",
    when: "Usalo per vedere i proxy disponibili e il loro ordine.",
    example: "llmproxy proxy:list",
  },
  "proxy:remove": {
    usage: "llmproxy proxy:remove <id>",
    description: "Rimuove un proxy dalla registry per ID (dominio).",
    when: "Usalo per rimuovere un proxy non piu' valido.",
    example: "llmproxy proxy:remove dc.decodo.com",
  },
  "proxy:reorder": {
    usage: "llmproxy proxy:reorder",
    description: "Avvia la modalita' interattiva per riordinare i proxy (priorita' di failover).",
    when: "Usalo per cambiare l'ordine di failover dei proxy.",
    example: "llmproxy proxy:reorder",
  },
  "proxy:test": {
    usage: "llmproxy proxy:test",
    description: "Testa tutti i proxy registrati verificando la connettivita'.",
    when: "Usalo per verificare quali proxy sono raggiungibili.",
    example: "llmproxy proxy:test",
  },
```

- [ ] **Step 3: Add REST translation entries**

Around line 3592 (inside `buildRestCommandRequest`), after the `provider:*` cases:

```js
    case "proxy:add": {
      const url = String(parsed.args[0] || "").trim();
      if (!url) return null;
      return { method: "POST", path: "/api/proxies", headers, body: { url } };
    }
    case "proxy:list":
      return { method: "GET", path: "/api/proxies", headers };
    case "proxy:remove":
      return { method: "DELETE", path: `/api/proxies/${encodeURIComponent(String(parsed.args[0] || "").trim())}`, headers };
    case "proxy:reorder":
      return { method: "POST", path: "/api/proxies/reorder", headers, body: {} };
    case "proxy:test":
      return { method: "POST", path: "/api/proxies/test", headers };
```

- [ ] **Step 4: Add local CLI handlers**

After the `provider:remove` handler (around line 5440), add:

```js
  if (parsed.command === "proxy:add") {
    const url = String(parsed.args[0] || "").trim();
    if (!url) {
      stderr.write("URL proxy richiesto. Uso: llmproxy proxy:add <url>\n");
      return 1;
    }
    try {
      const proxy = proxyStore.addProxy(url);
      stdout.write(`Proxy aggiunto: ${proxy.id} (${proxy.url})\n`);
      return 0;
    } catch (err) {
      stderr.write(`Errore: ${err.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "proxy:list") {
    const proxies = proxyStore.listProxies();
    if (proxies.length === 0) {
      stdout.write("Nessun proxy registrato.\n");
      return 0;
    }
    stdout.write("Proxy registrati:\n");
    proxies.forEach((p, i) => {
      stdout.write(`  ${i + 1}. ${p.id} (${p.url})\n`);
    });
    return 0;
  }

  if (parsed.command === "proxy:remove") {
    const id = String(parsed.args[0] || "").trim();
    if (!id) {
      stderr.write("ID proxy richiesto. Uso: llmproxy proxy:remove <id>\n");
      return 1;
    }
    const removed = proxyStore.removeProxy(id);
    if (!removed) {
      stderr.write(`Proxy non trovato: ${id}\n`);
      return 1;
    }
    stdout.write(`Proxy rimosso: ${id}\n`);
    return 0;
  }
```

- [ ] **Step 5: Add proxy:reorder handler**

After the proxy:remove handler, add:

```js
  if (parsed.command === "proxy:reorder") {
    const proxies = proxyStore.listProxies();
    if (proxies.length < 2) {
      stdout.write("Servono almeno 2 proxy per il riordino.\n");
      return 0;
    }
    stdout.write("Ordine attuale:\n");
    proxies.forEach((p, i) => stdout.write(`  ${i + 1}. ${p.id}\n`));
    stdout.write("\nInserisci i numeri separati da spazio per il nuovo ordine (es: 3 1 2):\n");
    const input = await readUserInput();
    const indices = String(input || "").trim().split(/\s+/).map(Number).filter((n) => n > 0 && n <= proxies.length);
    if (indices.length === 0) {
      stderr.write("Input non valido.\n");
      return 1;
    }
    const newOrder = indices.map((i) => proxies[i - 1].id);
    proxyStore.setProxyOrder(newOrder);
    stdout.write("Ordine aggiornato.\n");
    return 0;
  }
```

You'll need a `readUserInput` helper. Check if one exists or add:

```js
function readUserInput() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode && stdin.setRawMode(false);
    stdin.once("data", (data) => {
      stdin.setRawMode && wasRaw !== undefined && stdin.setRawMode(wasRaw);
      resolve(data.toString().trim());
    });
  });
}
```

Unlike `provider:reorder` (which uses a complex benchmarking engine), `proxy:reorder` is a simple reorder command that accepts the IDs in the desired order as arguments:

```js
  if (parsed.command === "proxy:reorder") {
    const proxies = proxyStore.listProxies();
    if (proxies.length < 2) {
      stdout.write("Servono almeno 2 proxy per il riordino.\n");
      return 0;
    }
    const ids = parsed.args.filter((id) => proxies.some((p) => p.id === id));
    if (ids.length === 0) {
      stdout.write("Uso: llmproxy proxy:reorder <id1> <id2> ...\n");
      stdout.write("ID disponibili: " + proxies.map((p) => p.id).join(", ") + "\n");
      return 1;
    }
    proxyStore.setProxyOrder(ids);
    stdout.write("Ordine proxy aggiornato.\n");
    return 0;
  }
```

- [ ] **Step 7: Commit**

```bash
git add lib/cli.js
git commit -m "feat(llmp): add proxy:add, proxy:list, proxy:remove CLI commands

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Add proxy:test command

**Files:**
- Modify: `lib/cli.js` (add proxy:test handler)

- [ ] **Step 1: Add proxy:test CLI handler**

After the proxy:reorder handler, add:

```js
  if (parsed.command === "proxy:test") {
    const proxies = proxyStore.listProxies();
    if (proxies.length === 0) {
      stdout.write("Nessun proxy registrato. Usa 'llmproxy proxy:add <url>' per aggiungere un proxy.\n");
      return 1;
    }

    stdout.write("Test proxy...\n\n");
    let passCount = 0;
    let failCount = 0;

    for (let i = 0; i < proxies.length; i++) {
      const p = proxies[i];
      stdout.write(`  ${i + 1}. ${p.id}... `);
      try {
        const probeFetch = makeProxyFetch(fetchFn, p.url);
        const response = await probeFetch("https://httpbin.org/ip", { signal: AbortSignal.timeout(10000) });
        if (response.ok) {
          stdout.write("✅ OK\n");
          passCount++;
        } else {
          stdout.write(`❌ HTTP ${response.status}\n`);
          failCount++;
        }
      } catch (err) {
        stdout.write(`❌ ${err.message}\n`);
        failCount++;
      }
    }

    stdout.write(`\nRisultati: ${passCount} pass, ${failCount} fail\n`);
    return failCount === 0 ? 0 : 1;
  }
```

- [ ] **Step 2: Commit**

```bash
git add lib/cli.js
git commit -m "feat(llmp): add proxy:test CLI command

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Add --proxy bare flag support in provider:add

**Files:**
- Modify: `lib/cli.js` (provider:add handler)

**Behavior change:** When `--proxy` is used without a URL value, store `proxy_rotation: true` on the provider (instead of `proxy_url`). When `--proxy <url>` is used with a value, store `proxy_url` as before.

- [ ] **Step 1: Modify the --proxy flag handling in provider:add**

In the `provider:add` section (around line 4797), change:

```js
    const proxyUrlRaw = String(parsed.flags.proxy || "").trim();
    const proxyApiKey = String(parsed.flags["proxy-key"] || "").trim();
```

to:

```js
    // --proxy senza valore = rotazione sui proxy registrati
    // --proxy <url> = proxy specifico (comportamento esistente)
    // --proxy senza valore = flag è `true` (see parseArgs line 320)
    const proxyBareFlag = parsed.flags.proxy === true;
    const proxyUrlRaw = proxyBareFlag ? "" : String(parsed.flags.proxy || "").trim();
    const proxyApiKey = String(parsed.flags["proxy-key"] || "").trim();
```

And in the `saveProvider` call (around line 4858), add `proxy_rotation`:

```js
      providerStore.saveProvider(targetInstanceId, {
        access_token: apiKey,
        token_type: "api_key",
        scope: "api_key",
        provider: providerKind,
        auth_type: "api_key",
        default_model: defaultModel,
        endpoint_variant: endpointVariant,
        vision: visionEnabled,
        free_model: freeModel,
        proxy_url: proxyUrl || undefined,
        proxy_api_key: proxyApiKey || undefined,
        proxy_rotation: proxyBareFlag ? true : undefined,
      }, { name: providerName || providerId });
```

- [ ] **Step 2: Commit**

```bash
git add lib/cli.js
git commit -m "feat(llmp): support bare --proxy flag for rotation mode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Implement proxy rotation in copilot-proxy.js runtime

**Files:**
- Modify: `lib/copilot-proxy.js` (makeProxyFetch at line 1898)

**Behavior:** When a provider has `proxy_rotation: true`, load proxy URLs from the proxy store in order. Try each one sequentially until one works.

- [ ] **Step 1: Add proxy store integration to copilot-proxy.js**

At the top of `lib/copilot-proxy.js`, add the require:

```js
const { createProxyStore } = require("./proxy-store");
```

Find where the proxy URL is resolved at runtime (around line 1898). Currently:

```js
const providerFetch = makeProxyFetch(fetchFn, provider.proxy_url || "");
```

Add a function to resolve the proxy URL considering rotation:

```js
let _proxyStoreInstance = null;
function getProxyStore(proxyRegistryPath) {
  if (!_proxyStoreInstance) {
    _proxyStoreInstance = createProxyStore({ filePath: proxyRegistryPath || "" });
  }
  return _proxyStoreInstance;
}

function resolveProviderProxyUrl(provider, proxyRegistryPath) {
  // Proxy specifico salvato sul provider
  if (provider.proxy_url) return provider.proxy_url;
  // Rotazione proxy
  if (provider.proxy_rotation) {
    const store = getProxyStore(proxyRegistryPath);
    const proxies = store.listProxies();
    if (proxies.length > 0) return proxies[0].url; // primo in ordine (failover)
  }
  return "";
}
```

And change line 1898 to:

```js
const proxyUrl = resolveProviderProxyUrl(provider, "");
const providerFetch = makeProxyFetch(fetchFn, proxyUrl);
```

Export `resolveProviderProxyUrl` and `getProxyStore` so the CLI can also use them.

- [ ] **Step 2: Wire proxyRegistryPath through the runtime**

The proxy registry file path needs to reach copilot-proxy.js at runtime. This can be done via environment variable or by passing config. The simplest approach: use `LLMPROXY_PROXY_REGISTRY` env var.

```js
function resolveProviderProxyUrl(provider, proxyRegistryPath) {
  if (provider.proxy_url) return provider.proxy_url;
  if (provider.proxy_rotation) {
    const store = getProxyStore(proxyRegistryPath || process.env.LLMPROXY_PROXY_REGISTRY || "");
    const proxies = store.listProxies();
    if (proxies.length > 0) return proxies[0].url;
  }
  return "";
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/copilot-proxy.js
git commit -m "feat(llmp): implement proxy rotation in inference runtime

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Add provider:test --all-proxies

**Files:**
- Modify: `lib/cli.js` (provider:test handler)

**Design:** When `--all-proxies` flag is set, for each provider: iterate through all registered proxies, test each combination, and report per-combination results. The flag is checked via `parsed.flags["all-proxies"] === true` (bare flag).

- [ ] **Step 1: Modify provider:test to support --all-proxies flag**

In the `provider:test` handler (around line 5047), after loading the test image and before the provider loop, add proxy checking:

```js
    const allProxiesMode = parsed.flags["all-proxies"] === true;
    let proxiesList = [];
    if (allProxiesMode) {
      proxiesList = proxyStore.listProxies();
      if (proxiesList.length === 0) {
        stdout.write("Nessun proxy registrato. Usa 'llmproxy proxy:add <url>' per aggiungere proxy.\n");
        return 1;
      }
    }
```

Then modify the inner provider test loop to iterate through proxies when in `--all-proxies` mode:

```js
    for (const provider of providers) {
      const model = provider.default_model;
      const vision = provider.vision;
      const providerName = provider.name || provider.id;

      if (!model) {
        stdout.write(`⏭️  ${providerName}: saltato (modello non configurato)\n`);
        skipCount++;
        continue;
      }

      // Determine which proxy URLs to test with
      const proxyUrls = allProxiesMode
        ? proxiesList.map((p) => p.url)
        : [""]; // empty string = no proxy (existing behavior)

      for (const proxyUrl of proxyUrls) {
        const proxyLabel = proxyUrl ? ` (via ${new URL(proxyUrl).hostname})` : "";
        const expectedStatus = vision === true ? "visione ✅" : vision === false ? "testo ❌" : "visione sconosciuta ⚠️";
        stdout.write(`🔍 ${providerName} (${model})${proxyLabel} - atteso: ${expectedStatus}\n`);

        try {
          const baseUrl = getProxyBaseUrl({ env, dataRoot: paths.dataRoot });
          const proxyFetch = proxyUrl ? makeProxyFetch(fetchFn, proxyUrl) : fetchFn;
          const response = await runLocalProxyTestRequest(
            proxyFetch,
            `${baseUrl}/v1/messages`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                provider: provider.id,
                model,
                stream: false,
                max_tokens: 150,
                messages: [{
                  role: "user",
                  content: [
                    { type: "text", text: visionPrompt },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: testImageBase64 } },
                  ],
                }],
              }),
            },
            sleep,
          );
          // ... rest of existing test logic (checking response, vision keywords, etc.)
        } catch (error) {
          stdout.write(`  ❌ Errore: ${error.message}\n`);
          failCount++;
        }
      }
    }
```

Key differences from the existing per-provider loop:
- In `--all-proxies` mode, the inner loop iterates over `proxiesList`
- Each iteration creates a `proxyFetch` via `makeProxyFetch(fetchFn, proxyUrl)`
- The hostname is shown in the output label for clarity
- Empty string means direct connection (no proxy), matching existing behavior

- [ ] **Step 2: Commit**

```bash
git add lib/cli.js
git commit -m "feat(llmp): add --all-proxies flag to provider:test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `lib/cli.js` (help text entries added in Task 3)
- Modify: `README.md` (add proxy commands section)
- Modify: `docs/superpowers/specs/2026-07-16-proxy-registry-design.md` (design doc already written)

- [ ] **Step 1: Update README.md with proxy commands**

Add a "Proxy Registry" section to README.md documenting all proxy:* commands and the --proxy bare flag rotation behavior.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(llmp): add proxy registry documentation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Version bump, version sync, push

- [ ] **Step 1: Bump patch version**

```bash
npm version patch --no-git-tag-version
```

- [ ] **Step 2: Final build and quick smoke test**

```bash
node -e "const {createProxyStore} = require('./lib/proxy-store'); const s = createProxyStore({filePath:'/tmp/test.json'}); s.addProxy('http://u:p@h:1'); console.log(s.listProxies().length === 1);"
```

Expected: `true`

- [ ] **Step 3: Reinstall global and verify CLI works**

```bash
npm install -g . --force && llmproxy proxy:list
```

Expected: "Nessun proxy registrato."

- [ ] **Step 4: Commit everything**

```bash
git add -A
git commit -m "feat(llmp): proxy registry with rotation

- New proxy-store module for persistent proxy registry
- proxy:add, list, remove, reorder, test CLI commands
- Bare --proxy flag enables proxy rotation per provider
- Proxy rotation in copilot-proxy.js runtime (failover sequential)
- provider:test --all-proxies for cross-product testing
- Documentation in README.md

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: Push**

```bash
git push
```
