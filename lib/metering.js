"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SENSITIVE_KEYS = new Set([
  "messages",
  "prompt",
  "system",
  "input",
  "content",
  "tools",
  "authorization",
  "api_key",
  "apiKey",
  "token",
  "access_token",
  "refresh_token",
]);

function redactObject(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (typeof value !== "object") return value;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = redactObject(raw, depth + 1);
  }
  return output;
}

function buildMeteringRecord(input = {}) {
  const now = input.timestamp || new Date().toISOString();
  const hierarchyContext = input.hierarchyContext || null;
  const meteringContext = input.meteringContext || null;
  const customDimensions = input.customDimensions || meteringContext?.custom_dimensions || null;

  // v10 agent dimensions extracted from custom_dimensions
  const agent = customDimensions?.agent || null;
  const mansione = customDimensions?.mansione || null;
  const taskId = customDimensions?.task_id || null;

  const promptTokens = typeof input.promptTokens === "number" ? input.promptTokens : null;
  const completionTokens = typeof input.completionTokens === "number" ? input.completionTokens : null;
  const totalTokens = typeof input.totalTokens === "number"
    ? input.totalTokens
    : ((promptTokens ?? 0) + (completionTokens ?? 0)) || null;

  return {
    // Event envelope
    event_schema_version: "2026.1",
    event_version: 1,
    idempotency_key: input.idempotencyKey || input.requestId || null,
    timestamp: now,
    request_id: input.requestId || null,
    trace_id: input.traceId || null,

    // Provider routing
    provider: input.provider || null,
    provider_attempts: Array.isArray(input.providerAttempts) ? input.providerAttempts : [],
    fallback_count: typeof input.fallbackCount === "number"
      ? input.fallbackCount
      : Math.max(0, (Array.isArray(input.providerAttempts) ? input.providerAttempts.length : 1) - 1),
    model_requested: input.modelRequested || null,
    model_used: input.modelUsed || null,
    endpoint: input.endpoint || null,

    // Timing and outcome
    duration_ms: typeof input.durationMs === "number" ? input.durationMs : null,
    success: input.success !== false,
    error_code: input.errorCode || null,

    // Token counts (original field names)
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,

    // v10 llm_usage_logs column aliases
    tokens_input: promptTokens,
    tokens_output: completionTokens,

    // Billing hierarchy (original field names)
    master_company: hierarchyContext?.master_company || null,
    tenant_id: hierarchyContext?.tenant_id || null,
    client_id: hierarchyContext?.client_id || null,
    project_id: hierarchyContext?.project_id || null,
    user_id: hierarchyContext?.user_id || null,
    scope_type: hierarchyContext?.scope_type || null,
    scope_id: hierarchyContext?.scope_id || null,

    // v10 llm_usage_logs column alias
    company_id: hierarchyContext?.master_company || null,

    // Metering context
    caller_module: meteringContext?.caller_module || null,
    operation_id: meteringContext?.operation_id || null,
    request_purpose: meteringContext?.request_purpose || null,
    cost_accounting_required: Boolean(meteringContext?.cost_accounting_required),
    custom_dimensions: customDimensions,

    // v10 agent dimensions
    agent,
    mansione,
    task_id: taskId,

    // Raw contexts for downstream consumers
    hierarchy_context: hierarchyContext,
    metering_context: meteringContext,
  };
}

function createNoopMeteringSink() {
  const records = [];
  return {
    name: "noop",
    async record(rec) {
      records.push(rec);
    },
    inspect() {
      return records.slice();
    },
  };
}

function createJsonlMeteringSink({ filePath }) {
  if (!filePath) throw new Error("createJsonlMeteringSink requires { filePath }");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    name: "jsonl",
    async record(rec) {
      const safe = redactObject(rec);
      fs.appendFileSync(filePath, JSON.stringify(safe) + "\n", "utf8");
    },
    filePath,
  };
}

async function emitMetering(sink, record) {
  if (!sink || typeof sink.record !== "function") return { ok: true, skipped: true };
  try {
    await sink.record(record);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { code: "METERING_SINK_FAILED", message: error.message } };
  }
}

module.exports = {
  buildMeteringRecord,
  createNoopMeteringSink,
  createJsonlMeteringSink,
  emitMetering,
  redactObject,
};
