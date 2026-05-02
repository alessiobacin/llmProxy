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
  return {
    timestamp: now,
    request_id: input.requestId || null,
    trace_id: input.traceId || null,
    provider: input.provider || null,
    provider_attempts: Array.isArray(input.providerAttempts) ? input.providerAttempts : [],
    fallback_count: typeof input.fallbackCount === "number"
      ? input.fallbackCount
      : Math.max(0, (Array.isArray(input.providerAttempts) ? input.providerAttempts.length : 1) - 1),
    model_requested: input.modelRequested || null,
    model_used: input.modelUsed || null,
    endpoint: input.endpoint || null,
    duration_ms: typeof input.durationMs === "number" ? input.durationMs : null,
    prompt_tokens: typeof input.promptTokens === "number" ? input.promptTokens : null,
    completion_tokens: typeof input.completionTokens === "number" ? input.completionTokens : null,
    total_tokens: typeof input.totalTokens === "number"
      ? input.totalTokens
      : ((typeof input.promptTokens === "number" ? input.promptTokens : 0)
        + (typeof input.completionTokens === "number" ? input.completionTokens : 0)) || null,
    success: input.success !== false,
    error_code: input.errorCode || null,
    hierarchy_context: input.hierarchyContext || null,
    metering_context: input.meteringContext || null,
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
