const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../lib/app");
const { createTokenStore } = require("../lib/token-store");

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
    assert.deepEqual(body.error.missing_fields, ["master_company", "client_id", "project_id"]);
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
