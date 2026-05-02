const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseHierarchyContext,
  validateHierarchyContextForBilling,
  parseMeteringContext,
  resolveTraceId,
  resolveMode,
  buildHierarchyContextRequiredError,
  buildHierarchyContextInvalidError,
} = require("../lib/platform-context");

test("parseHierarchyContext returns null when no header or body context is provided", () => {
  assert.equal(parseHierarchyContext({ headers: {}, body: {} }), null);
});

test("parseHierarchyContext parses JSON header and validates scope_type", () => {
  const ctx = parseHierarchyContext({
    headers: {
      "x-hierarchy-context": JSON.stringify({
        scope_type: "project",
        scope_id: "p-1",
        master_company: "mc-1",
        tenant_id: "t-1",
        client_id: "c-1",
        project_id: "p-1",
        user_id: "u-1",
        roles: ["admin", "operator"],
      }),
    },
    body: {},
  });
  assert.equal(ctx.scope_type, "project");
  assert.equal(ctx.scope_id, "p-1");
  assert.equal(ctx.master_company, "mc-1");
  assert.equal(ctx.tenant_id, "t-1");
  assert.equal(ctx.agency_id, "t-1");
  assert.deepEqual(ctx.roles, ["admin", "operator"]);
});

test("parseHierarchyContext rejects invalid scope_type", () => {
  const ctx = parseHierarchyContext({
    headers: {
      "x-hierarchy-context": JSON.stringify({ scope_type: "invalid", scope_id: "x" }),
    },
    body: {},
  });
  assert.equal(ctx, null);
});

test("parseHierarchyContext falls back to body when header is missing", () => {
  const ctx = parseHierarchyContext({
    headers: {},
    body: { hierarchy_context: { scope_type: "agency", scope_id: "ag-9", masterCompany: "mc-9", tenant: "ag-9" } },
  });
  assert.equal(ctx.scope_type, "agency");
  assert.equal(ctx.scope_id, "ag-9");
  assert.equal(ctx.master_company, "mc-9");
  assert.equal(ctx.tenant_id, "ag-9");
});

test("validateHierarchyContextForBilling — project under master_company", () => {
  const invalid = validateHierarchyContextForBilling({ scope_type: "project", scope_id: "p-1", master_company: "mc-1" });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.missing_fields, ["project_id"]);

  const valid = validateHierarchyContextForBilling({ scope_type: "project", scope_id: "p-1", master_company: "mc-1", project_id: "p-1" });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — project under agency", () => {
  const valid = validateHierarchyContextForBilling({
    scope_type: "project", scope_id: "p-1",
    master_company: "mc-1", tenant_id: "t-1", project_id: "p-1",
  });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — project under client of agency (full chain)", () => {
  const valid = validateHierarchyContextForBilling({
    scope_type: "project", scope_id: "p-1",
    master_company: "mc-1", tenant_id: "t-1", client_id: "c-1", project_id: "p-1",
  });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — client under master_company", () => {
  const invalid = validateHierarchyContextForBilling({ scope_type: "client", scope_id: "c-1", master_company: "mc-1" });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.missing_fields, ["client_id"]);

  const valid = validateHierarchyContextForBilling({ scope_type: "client", scope_id: "c-1", master_company: "mc-1", client_id: "c-1" });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — client under agency", () => {
  const valid = validateHierarchyContextForBilling({
    scope_type: "client", scope_id: "c-1",
    master_company: "mc-1", tenant_id: "t-1", client_id: "c-1",
  });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — user at master level", () => {
  const invalid = validateHierarchyContextForBilling({ scope_type: "user", scope_id: "u-1", master_company: "mc-1" });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.missing_fields, ["user_id"]);

  const valid = validateHierarchyContextForBilling({ scope_type: "user", scope_id: "u-1", master_company: "mc-1", user_id: "u-1" });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — user under agency", () => {
  const valid = validateHierarchyContextForBilling({
    scope_type: "user", scope_id: "u-1",
    master_company: "mc-1", tenant_id: "t-1", user_id: "u-1",
  });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — user under client of agency", () => {
  const valid = validateHierarchyContextForBilling({
    scope_type: "user", scope_id: "u-1",
    master_company: "mc-1", tenant_id: "t-1", client_id: "c-1", user_id: "u-1",
  });
  assert.equal(valid.valid, true);
});

test("validateHierarchyContextForBilling — optional parent ID present but empty is invalid", () => {
  const result = validateHierarchyContextForBilling({
    scope_type: "project", scope_id: "p-1",
    master_company: "mc-1", tenant_id: "", project_id: "p-1",
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing_fields, ["tenant_id"]);
});

test("parseMeteringContext extracts caller_module and operation_id", () => {
  const ctx = parseMeteringContext({
    headers: {
      "x-metering-context": JSON.stringify({
        caller_module: "ai-orchestrator",
        operation_id: "op-42",
        request_purpose: "qa",
        cost_accounting_required: true,
      }),
    },
    body: {},
  });
  assert.equal(ctx.caller_module, "ai-orchestrator");
  assert.equal(ctx.operation_id, "op-42");
  assert.equal(ctx.cost_accounting_required, true);
});

test("resolveTraceId reads X-Trace-Id header", () => {
  assert.equal(resolveTraceId({ headers: { "x-trace-id": "trace-1" } }), "trace-1");
  assert.equal(resolveTraceId({ headers: {} }), null);
});

test("resolveMode defaults to standalone", () => {
  assert.equal(resolveMode({}), "standalone");
  assert.equal(resolveMode({ LLMPROXY_MODE: "platform" }), "platform");
  assert.equal(resolveMode({ LLMPROXY_MODE: "PLATFORM" }), "platform");
  assert.equal(resolveMode({ LLMPROXY_MODE: "anything-else" }), "standalone");
});

test("buildHierarchyContextRequiredError shape is stable", () => {
  const err = buildHierarchyContextRequiredError("trace-x");
  assert.equal(err.error.code, "HIERARCHY_CONTEXT_REQUIRED");
  assert.equal(err.error.trace_id, "trace-x");
  assert.equal(typeof err.error.message, "string");
});

test("buildHierarchyContextInvalidError shape is stable", () => {
  const err = buildHierarchyContextInvalidError("trace-y", {
    message: "missing",
    missing_fields: ["master_company"],
  });
  assert.equal(err.error.code, "HIERARCHY_CONTEXT_INVALID");
  assert.equal(err.error.trace_id, "trace-y");
  assert.deepEqual(err.error.missing_fields, ["master_company"]);
});
