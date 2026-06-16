const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
const { createTokenStore } = require("../lib/token-store");
const { createNoopMeteringSink } = require("../lib/metering");
const { createProviderRegistry } = require("../lib/provider-registry");

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function makeFetchFn() {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: "claude-sonnet-4.5",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      };
    },
  });
}

test("/v1/llm/health returns mode and manifest_version", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-h-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.mode, "platform");
    assert.equal(body.manifest_version, "v8");
    assert.equal(body.authenticated, true);
  });
});

test("/v1/llm/messages requires HierarchyContext in platform mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-r-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "HIERARCHY_CONTEXT_REQUIRED");
  });
});

test("/v1/llm/messages succeeds when HierarchyContext is supplied", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-ok-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hierarchy-context": JSON.stringify({
          scope_type: "project",
          scope_id: "p-1",
          master_company: "mc-1",
          tenant_id: "t-1",
          client_id: "c-1",
          project_id: "p-1",
        }),
        "x-trace-id": "trace-ok",
      },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, "assistant");
  });
});

test("/v1/llm/messages rejects HierarchyContext missing billing identifiers", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-invalid-ctx-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hierarchy-context": JSON.stringify({ scope_type: "project", scope_id: "p-1", tenant_id: "t-1" }),
      },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "HIERARCHY_CONTEXT_INVALID");
    // tenant_id alone is valid (tenant project without client); but master_company and project_id are missing
    assert.deepEqual(body.error.missing_fields, ["master_company", "project_id"]);
  });
});

test("/v1/llm/messages emits metering record with hierarchy attribution", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-metering-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = {
    records: [],
    async record(record) {
      this.records.push(record);
    },
  };
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace-id": "trace-meter-1",
        "x-hierarchy-context": JSON.stringify({
          scope_type: "project",
          scope_id: "p-1",
          master_company: "mc-1",
          tenant_id: "t-1",
          client_id: "c-1",
          project_id: "p-1",
        }),
        "x-metering-context": JSON.stringify({
          caller_module: "orchestrator-v10",
          operation_id: "op-777",
          cost_accounting_required: true,
          custom_dimensions: { workflow: "content-generation" },
        }),
      },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(res.status, 200);
    assert.equal(meteringSink.records.length, 1);
    const record = meteringSink.records[0];
    assert.equal(record.trace_id, "trace-meter-1");
    assert.equal(record.master_company, "mc-1");
    assert.equal(record.tenant_id, "t-1");
    assert.equal(record.client_id, "c-1");
    assert.equal(record.project_id, "p-1");
    assert.equal(record.caller_module, "orchestrator-v10");
    assert.equal(record.operation_id, "op-777");
    assert.equal(record.success, true);
  });
});

test("/v1/llm/messages emits v10-ready metering record (agent/mansione/task_id mapping)", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-v10-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = {
    records: [],
    async record(record) {
      this.records.push(record);
    },
  };
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trace-id": "trace-v10-contract",
        "x-hierarchy-context": JSON.stringify({
          scope_type: "project",
          scope_id: "p-42",
          master_company: "mc-acme",
          tenant_id: "t-agency",
          client_id: "c-brand",
          project_id: "p-42",
        }),
        "x-metering-context": JSON.stringify({
          caller_module: "lm-gateway-v10",
          operation_id: "op-contract-001",
          cost_accounting_required: true,
          custom_dimensions: {
            agent: "content-strategist",
            mansione: "content-strategist-v2",
            task_id: "task-uuid-abc123",
            workflow: "content-generation",
          },
        }),
      },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(res.status, 200);
    assert.equal(meteringSink.records.length, 1);
    const rec = meteringSink.records[0];

    // Event envelope
    assert.equal(rec.event_schema_version, "2026.1");
    assert.equal(rec.trace_id, "trace-v10-contract");
    assert.equal(rec.success, true);

    // v10 billing hierarchy column aliases
    assert.equal(rec.company_id, "mc-acme");
    assert.equal(rec.client_id, "c-brand");
    assert.equal(rec.project_id, "p-42");

    // v10 token column aliases (from mock: prompt_tokens=1, completion_tokens=2)
    assert.equal(rec.tokens_input, 1);
    assert.equal(rec.tokens_output, 2);

    // v10 agent dimensions from custom_dimensions
    assert.equal(rec.agent, "content-strategist");
    assert.equal(rec.mansione, "content-strategist-v2");
    assert.equal(rec.task_id, "task-uuid-abc123");

    // Metering context
    assert.equal(rec.caller_module, "lm-gateway-v10");
    assert.equal(rec.cost_accounting_required, true);

    // custom_dimensions preserved
    assert.equal(rec.custom_dimensions.workflow, "content-generation");
  });
});

test("/v1/messages keeps backward compatibility without HierarchyContext", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-bc-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
  });
});

test("/v1/messages can resolve a shared user-scoped provider from the local auth token", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-local-user-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  const providerRegistry = createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json"), secret: null });
  providerRegistry.upsert({
    provider: "openrouter",
    scope_type: "user",
    scope_id: "aqdas",
    default_model: "openai/gpt-4.1-mini",
    priority: 1,
    credentials: { access_token: "sk-user-openrouter" },
    metadata: { name: "OpenRouter", auth_type: "api_key", token_type: "api_key", scope: "api_key" },
  });
  let capturedAuth = "";
  const app = createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry,
    mode: "platform",
    fetchFn: async (url, options = {}) => {
      const headerEntries = options.headers && typeof options.headers.entries === "function"
        ? Array.from(options.headers.entries())
        : Object.entries(options.headers || {});
      const serializedHeaders = JSON.stringify(Object.fromEntries(headerEntries));
      if (String(url).includes("openrouter.ai") || /sk-user-openrouter/.test(serializedHeaders)) {
        capturedAuth = serializedHeaders;
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            model: "openai/gpt-4.1-mini",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      };
    },
  });

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "llmproxy-local-user:aqdas",
      },
      body: JSON.stringify({ provider: "openrouter", model: "openai/gpt-4.1-mini", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.match(capturedAuth, /sk-user-openrouter/);
  });
});

test("POST /v1/llm/providers requires admin or owner role in platform mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-prov-1-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const noRole = await fetch(`${baseUrl}/v1/llm/providers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hierarchy-context": JSON.stringify({ scope_type: "project", scope_id: "p-1", roles: ["viewer"] }),
      },
      body: JSON.stringify({ provider: "copilot", scope_type: "project", scope_id: "p-1" }),
    });
    assert.equal(noRole.status, 403);

    const ok = await fetch(`${baseUrl}/v1/llm/providers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hierarchy-context": JSON.stringify({ scope_type: "project", scope_id: "p-1", roles: ["admin"] }),
      },
      body: JSON.stringify({ provider: "copilot", scope_type: "project", scope_id: "p-1", default_model: "claude-sonnet-4.5" }),
    });
    assert.equal(ok.status, 201);
    const created = await ok.json();
    assert.equal(created.provider, "copilot");
    assert.equal(created.scope_type, "project");

    const list = await fetch(`${baseUrl}/v1/llm/providers?scope_type=project&scope_id=p-1`);
    const listBody = await list.json();
    assert.equal(listBody.entries.length, 1);

    const del = await fetch(`${baseUrl}/v1/llm/providers/${encodeURIComponent(created.id)}`, {
      method: "DELETE",
      headers: { "x-hierarchy-context": JSON.stringify({ scope_type: "project", scope_id: "p-1", roles: ["admin"] }) },
    });
    assert.equal(del.status, 204);
  });
});

test("/v1/chat/completions returns OpenAI-shaped response without HierarchyContext", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-oai-1-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.ok(Array.isArray(body.choices));
    assert.equal(body.choices[0].message.role, "assistant");
  });
});

test("/v1/llm/chat/completions requires HierarchyContext in platform mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-oai-2-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "HIERARCHY_CONTEXT_REQUIRED");
  });
});

test("/v1/llm/chat/completions succeeds with complete billing hierarchy context", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-oai-3-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hierarchy-context": JSON.stringify({
          scope_type: "project",
          scope_id: "p-1",
          masterCompany: "mc-1",
          tenant: "t-1",
          client: "c-1",
          project: "p-1",
        }),
      },
      body: JSON.stringify({ model: "claude-sonnet-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.role, "assistant");
  });
});

test("/v1/llm/messages with body.provider=openrouter requires a configured provider credential", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-platform-prov-2-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hierarchy-context": JSON.stringify({
          scope_type: "project",
          scope_id: "p-1",
          master_company: "mc-1",
          tenant_id: "t-1",
          client_id: "c-1",
          project_id: "p-1",
          roles: ["admin"],
        }),
      },
      body: JSON.stringify({ provider: "openrouter", model: "x", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, "authentication_error");
  });
});

// ---------------------------------------------------------------------------
// Metering query endpoints
// ---------------------------------------------------------------------------

test("GET /v1/llm/metering returns 404 in standalone mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-standalone-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  // standalone mode (default) — meteringSink has no query method
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "standalone", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering`);
    assert.equal(res.status, 404);
  });
});

test("GET /v1/llm/metering/stats returns 404 in standalone mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-stats-standalone-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "standalone", fetchFn: makeFetchFn() });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering/stats`);
    assert.equal(res.status, 404);
  });
});

test("GET /v1/llm/metering returns paginated records in platform mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-query-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = createNoopMeteringSink();
  await meteringSink.record({ project_id: "p-1", provider: "copilot", success: true, tokens_input: 10, tokens_output: 5, timestamp: "2026-05-01T10:00:00Z" });
  await meteringSink.record({ project_id: "p-2", provider: "openai",  success: false, tokens_input: 20, tokens_output: 0, timestamp: "2026-05-02T10:00:00Z" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.records));
    assert.equal(body.total, 2);
    assert.equal(typeof body.limit, "number");
    assert.equal(typeof body.offset, "number");
    assert.ok(body.order === "desc" || body.order === "asc");
  });
});

test("GET /v1/llm/metering filters by project_id", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-filter-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = createNoopMeteringSink();
  await meteringSink.record({ project_id: "p-1", success: true, tokens_input: 10, tokens_output: 5, timestamp: "2026-05-01T10:00:00Z" });
  await meteringSink.record({ project_id: "p-2", success: true, tokens_input: 20, tokens_output: 8, timestamp: "2026-05-02T10:00:00Z" });
  await meteringSink.record({ project_id: "p-1", success: true, tokens_input: 30, tokens_output: 12, timestamp: "2026-05-03T10:00:00Z" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering?project_id=p-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.ok(body.records.every((r) => r.project_id === "p-1"));
  });
});

test("GET /v1/llm/metering filters by success=false", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-success-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = createNoopMeteringSink();
  await meteringSink.record({ success: true,  tokens_input: 10, tokens_output: 5, timestamp: "2026-05-01T10:00:00Z" });
  await meteringSink.record({ success: false, tokens_input: 20, tokens_output: 0, timestamp: "2026-05-02T10:00:00Z" });
  await meteringSink.record({ success: true,  tokens_input: 30, tokens_output: 8, timestamp: "2026-05-03T10:00:00Z" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering?success=false`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.records[0].success, false);
  });
});

test("GET /v1/llm/metering returns 400 for invalid limit", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-badlimit-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = createNoopMeteringSink();
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering?limit=abc`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_PARAM");
  });
});

test("GET /v1/llm/metering returns 400 for invalid success param", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-badsuccess-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = createNoopMeteringSink();
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering?success=maybe`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_PARAM");
  });
});

test("GET /v1/llm/metering/stats returns aggregate object in platform mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-metering-stats-query-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.save({ access_token: "t" });
  const meteringSink = createNoopMeteringSink();
  await meteringSink.record({ project_id: "p-1", provider: "copilot", success: true, tokens_input: 100, tokens_output: 20, duration_ms: 800, timestamp: "2026-05-01T10:00:00Z", scope_type: "project" });
  await meteringSink.record({ project_id: "p-1", provider: "copilot", success: true, tokens_input: 200, tokens_output: 40, duration_ms: 1200, timestamp: "2026-05-02T10:00:00Z", scope_type: "project" });
  const app = createApp({ dataRoot: tempRoot, tokenStore, mode: "platform", fetchFn: makeFetchFn(), meteringSink });
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/llm/metering/stats?project_id=p-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.filtered_total, 2);
    assert.equal(body.total_requests, 2);
    assert.equal(body.success_count, 2);
    assert.equal(body.error_count, 0);
    assert.equal(body.total_tokens_input, 300);
    assert.equal(body.total_tokens_output, 60);
    assert.equal(typeof body.avg_duration_ms, "number");
    assert.equal(typeof body.p50_duration_ms, "number");
    assert.equal(typeof body.p95_duration_ms, "number");
    assert.ok(body.by_provider.copilot.requests === 2);
  });
});
