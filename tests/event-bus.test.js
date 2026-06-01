"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const { createEventBusSink, buildEventBusHierarchyContext, TOPIC, VERSION, PRODUCER } = require("../lib/event-bus");

// ---------------------------------------------------------------------------
// buildEventBusHierarchyContext
// ---------------------------------------------------------------------------

describe("buildEventBusHierarchyContext", () => {
  it("maps tenant_id to tenantId", () => {
    const result = buildEventBusHierarchyContext({ tenant_id: "t1" });
    assert.equal(result.tenantId, "t1");
  });

  it("falls back to tenantId if already camelCase", () => {
    const result = buildEventBusHierarchyContext({ tenantId: "t2" });
    assert.equal(result.tenantId, "t2");
  });

  it("throws when hierarchy context is null (V11: no silent fallback to 'unknown')", () => {
    assert.throws(
      () => buildEventBusHierarchyContext(null),
      /HIERARCHY_CONTEXT_MISSING_TENANT/,
    );
  });

  it("maps optional fields to camelCase", () => {
    const result = buildEventBusHierarchyContext({
      tenant_id: "t1",
      client_id: "c1",
      project_id: "p1",
      master_company: "mc1",
      user_id: "u1",
      scope_type: "project",
      scope_id: "s1",
    });
    assert.equal(result.clientId, "c1");
    assert.equal(result.projectId, "p1");
    assert.equal(result.masterCompany, "mc1");
    assert.equal(result.userId, "u1");
    assert.equal(result.scopeType, "project");
    assert.equal(result.scopeId, "s1");
  });
});

// ---------------------------------------------------------------------------
// createEventBusSink — no-op when URL is missing
// ---------------------------------------------------------------------------

describe("createEventBusSink — no-op", () => {
  it("returns noop sink when url is not provided", async () => {
    const sink = createEventBusSink();
    const result = await sink.publish({ payload: {}, hierarchyContext: null });
    assert.equal(sink.name, "noop");
    assert.equal(result.skipped, true);
    assert.equal(result.ok, true);
  });

  it("returns noop sink when url is empty string", async () => {
    const sink = createEventBusSink({ url: "" });
    assert.equal(sink.name, "noop");
  });
});

// ---------------------------------------------------------------------------
// createEventBusSink — real publish
// ---------------------------------------------------------------------------

describe("createEventBusSink — publish", () => {
  it("posts to /api/v1/events/publish with correct body", async () => {
    let capturedUrl, capturedBody;
    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true, text: async () => "" };
    };

    const sink = createEventBusSink({ url: "http://localhost:5048", fetchFn: mockFetch });
    const result = await sink.publish({
      payload: { request_id: "req-1", total_tokens: 100 },
      hierarchyContext: { tenant_id: "tenant-abc", project_id: "proj-1" },
    });

    assert.equal(result.ok, true);
    assert.equal(capturedUrl, "http://localhost:5048/api/v1/events/publish");
    assert.equal(capturedBody.topic, TOPIC);
    assert.equal(capturedBody.version, VERSION);
    assert.equal(capturedBody.producer, PRODUCER);
    assert.equal(capturedBody.hierarchy_context.tenantId, "tenant-abc");
    assert.equal(capturedBody.hierarchy_context.projectId, "proj-1");
    assert.deepEqual(capturedBody.payload, { request_id: "req-1", total_tokens: 100 });
  });

  it("strips trailing slash from url", async () => {
    let capturedUrl;
    const mockFetch = async (url) => {
      capturedUrl = url;
      return { ok: true };
    };
    const sink = createEventBusSink({ url: "http://localhost:5048/", fetchFn: mockFetch });
    await sink.publish({ payload: {}, hierarchyContext: { tenant_id: "t" } });
    assert.equal(capturedUrl, "http://localhost:5048/api/v1/events/publish");
  });

  it("returns ok:false when event-bus returns non-2xx", async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "bad request",
    });
    const sink = createEventBusSink({ url: "http://localhost:5048", fetchFn: mockFetch });
    const result = await sink.publish({ payload: {}, hierarchyContext: { tenant_id: "t" } });
    assert.equal(result.ok, false);
    assert.match(result.error, /400/);
  });

  it("returns ok:false on network error without throwing", async () => {
    const mockFetch = async () => { throw new Error("ECONNREFUSED"); };
    const sink = createEventBusSink({ url: "http://localhost:5048", fetchFn: mockFetch });
    const result = await sink.publish({ payload: {}, hierarchyContext: { tenant_id: "t" } });
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  });

  it("uses custom topic and version when provided", async () => {
    let capturedBody;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };
    const sink = createEventBusSink({ url: "http://localhost:5048", fetchFn: mockFetch });
    await sink.publish({
      payload: {},
      hierarchyContext: { tenant_id: "t" },
      topic: "llmproxy.call.failed",
      version: "2.0",
      producer: "test-producer",
    });
    assert.equal(capturedBody.topic, "llmproxy.call.failed");
    assert.equal(capturedBody.version, "2.0");
    assert.equal(capturedBody.producer, "test-producer");
  });

  it("returns ok:false when hierarchyContext is null (V11: no silent 'unknown' tenant)", async () => {
    const sink = createEventBusSink({ url: "http://localhost:5048", fetchFn: async () => ({ ok: true }) });
    const result = await sink.publish({ payload: {}, hierarchyContext: null });
    assert.equal(result.ok, false);
    assert.match(result.error, /HIERARCHY_CONTEXT_MISSING_TENANT/);
  });
});
