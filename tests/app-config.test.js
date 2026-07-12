"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const express = require("express");

const {
  getConfigSpec,
  listScopeValues,
  setScopeValue,
  unsetScopeValue,
  getGlobalClaudeSettingsFile,
} = require("../lib/configuration");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `llmproxy-app-config-test-${Date.now()}`);
const serviceDir = path.join(tmpRoot, "service");
const serviceConfigFile = path.join(serviceDir, "config.json");
const claudeDir = path.join(tmpRoot, ".claude");
const claudeSettingsFile = path.join(claudeDir, "settings.json");
const homeDir = path.join(tmpRoot, "home");
const globalClaudeSettingsFile = getGlobalClaudeSettingsFile({ ...process.env, HOME: homeDir });

function makeApp() {
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(path.dirname(globalClaudeSettingsFile), { recursive: true });
  fs.writeFileSync(serviceConfigFile, JSON.stringify({ env: {} }));
  fs.writeFileSync(claudeSettingsFile, JSON.stringify({}));
  fs.writeFileSync(globalClaudeSettingsFile, JSON.stringify({}));

  const app = express();
  app.use(express.json());

  // GET /api/config — list all variables
  app.get("/api/config", (_req, res) => {
    const values = listScopeValues({ cwd: tmpRoot, serviceConfigFile, env: { ...process.env, HOME: homeDir } });
    res.json({ success: true, variables: values });
  });

  // POST /api/config/:key — set a variable
  app.post("/api/config/:key", (req, res) => {
    const key = String(req.params.key || "").trim();
    const value = String(req.body?.value ?? "");
    const scope = String(req.body?.scope || "").trim();

    const spec = getConfigSpec(key);
    if (!spec) {
      return res.status(400).json({
        success: false,
        exitCode: 1,
        command: `config:set ${key}`,
        data: { output: "", error: `Variabile non supportata: ${key}` },
        timestamp: new Date().toISOString(),
      });
    }

    const effectiveScope = scope || spec.scope;
    let writeResult;
    try {
      writeResult = setScopeValue({
        key,
        value: value || "",
        scope: effectiveScope,
        cwd: tmpRoot,
        serviceConfigFile,
        env: { ...process.env, HOME: homeDir },
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        exitCode: 1,
        command: `config:set ${key}`,
        data: { output: "", error: err.message },
        timestamp: new Date().toISOString(),
      });
    }

    // Hot-reload response
    if (spec.hotReloadable && !spec.restartRequired) {
      return res.json({
        success: true,
        exitCode: 0,
        command: `config:set ${key}`,
        data: { output: `Configurazione aggiornata: ${writeResult.scope}.${key}=${writeResult.value}`, error: "" },
        restarting: false,
        timestamp: new Date().toISOString(),
      });
    }

    // Restart-required response
    if (spec.restartRequired) {
      return res.json({
        success: true,
        exitCode: 0,
        command: `config:set ${key}`,
        data: { output: `Configurazione aggiornata: ${writeResult.scope}.${key}=${writeResult.value}`, error: "" },
        restarting: true,
        message: `La variabile ${key} richiede il riavvio del servizio. Riavvio in corso...`,
        timestamp: new Date().toISOString(),
      });
    }

    // Default (project-scope, no restart)
    return res.json({
      success: true,
      exitCode: 0,
      command: `config:set ${key}`,
      data: { output: `Configurazione aggiornata: ${writeResult.scope}.${key}=${writeResult.value}`, error: "" },
      restarting: false,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

function fetchFromApp(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${urlPath}`;
      const opts = { method, headers: { "Content-Type": "application/json" } };
      if (body) opts.body = JSON.stringify(body);

      fetch(url, opts)
        .then(async (resp) => {
          const json = await resp.json();
          resolve({ status: resp.status, body: json });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── GET /api/config ─────────────────────────────────────────────────────────

test("GET /api/config returns all variables", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "GET", "/api/config");
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.variables));
  assert.ok(body.variables.length >= 28, `expected >=28, got ${body.variables.length}`);

  const dblayer = body.variables.find((v) => v.key === "DBLAYER_URL");
  assert.equal(dblayer, undefined);

  const autoEscalate = body.variables.find((v) => v.key === "LLMPROXY_AUTO_ESCALATE");
  assert.equal(autoEscalate, undefined, "LLMPROXY_AUTO_ESCALATE should be removed");

  const statsKey = body.variables.find((v) => v.key === "LLMPROXY_LLM_STATS_API_KEY");
  assert.ok(statsKey, "LLMPROXY_LLM_STATS_API_KEY should be listed");
  assert.equal(statsKey.scope, "project");
  assert.equal(statsKey.value, "");
});

// ─── POST /api/config/:key — unknown key ──────────────────────────────────────

test("POST /api/config/:key with unknown variable returns 400", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/UNKNOWN_VAR", { value: "test" });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.ok(body.data.error.includes("non supportata"));
});

// ─── POST /api/config/:key — hot-reloadable ───────────────────────────────────

test("POST /api/config/DBLAYER_URL returns restarting:false", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/DBLAYER_URL", { value: "http://localhost:5046" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.restarting, false);

  // Verify it was written to disk
  const raw = JSON.parse(fs.readFileSync(serviceConfigFile, "utf8"));
  assert.equal(raw.env.DBLAYER_URL, "http://localhost:5046");
});

test("POST /api/config/EVENTBUS_URL returns restarting:false", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/EVENTBUS_URL", { value: "http://localhost:5048" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.restarting, false);
});

test("POST /api/config/LLMPROXY_SENDGRID_API_KEY returns restarting:false", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/LLMPROXY_SENDGRID_API_KEY", { value: "sk-test" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.restarting, false);

  const raw = JSON.parse(fs.readFileSync(claudeSettingsFile, "utf8"));
  assert.equal(raw.env.LLMPROXY_SENDGRID_API_KEY, "sk-test");
});

// ─── POST /api/config/:key — restart-required ─────────────────────────────────

test("POST /api/config/PORT returns restarting:true", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/PORT", { value: "5040" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.restarting, true);
  assert.ok(body.message.includes("riavvio"));
});

test("POST /api/config/LLMPROXY_ENV returns restarting:true", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/LLMPROXY_ENV", { value: "staging" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.restarting, true);
});

// ─── POST /api/config/:key — project-scope ────────────────────────────────────

test("POST /api/config/ANTHROPIC_BASE_URL writes to project settings", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/ANTHROPIC_BASE_URL", { value: "http://localhost:7045" });
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.restarting, false);

  const raw = JSON.parse(fs.readFileSync(claudeSettingsFile, "utf8"));
  assert.equal(raw.env.ANTHROPIC_BASE_URL, "http://localhost:7045");
});

test("POST /api/config/LLMPROXY_LLM_STATS_API_KEY with scope=global writes to global Claude settings", async () => {
  const app = makeApp();
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const { status, body } = await fetchFromApp(app, "POST", "/api/config/LLMPROXY_LLM_STATS_API_KEY", {
      value: "sk-global-demo",
      scope: "global",
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.restarting, false);

    const raw = JSON.parse(fs.readFileSync(globalClaudeSettingsFile, "utf8"));
    assert.equal(raw.env.LLMPROXY_LLM_STATS_API_KEY, "sk-global-demo");
  } finally {
    process.env.HOME = originalHome;
  }
});

// ─── Scope enforcement ────────────────────────────────────────────────────────

test("POST /api/config/:key with wrong scope returns error", async () => {
  const app = makeApp();
  const { status, body } = await fetchFromApp(app, "POST", "/api/config/PORT", { value: "5040", scope: "project" });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.ok(body.data.error.includes("scope service"));
});

// ─── Values persisted correctly ───────────────────────────────────────────────

test("POST /api/config/API_TIMEOUT_MS persists number-as-string", async () => {
  const app = makeApp();
  await fetchFromApp(app, "POST", "/api/config/API_TIMEOUT_MS", { value: "30000" });

  const values = listScopeValues({ cwd: tmpRoot, scope: "project", serviceConfigFile });
  const entry = values.find((v) => v.key === "API_TIMEOUT_MS");
  assert.equal(entry.value, "30000");
});
