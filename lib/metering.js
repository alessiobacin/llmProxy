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

    // Per-level user IDs
    master_user_id: hierarchyContext?.master_user_id || null,
    tenant_user_id: hierarchyContext?.tenant_user_id || null,
    client_user_id: hierarchyContext?.client_user_id || null,
    project_user_id: hierarchyContext?.project_user_id || null,

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
    query(opts) {
      return queryMeteringRecords(records, opts);
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
    query(opts) {
      const allRecords = readJsonlFile(filePath);
      return queryMeteringRecords(allRecords, opts);
    },
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

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Read all records from a JSONL file.
 * Returns an empty array if the file does not exist.
 * Silently skips malformed lines.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonlFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

/**
 * Filter predicates applied by queryMeteringRecords.
 * String equality filters are case-sensitive to preserve identifier semantics.
 */
const STRING_FILTERS = [
  "project_id", "tenant_id", "client_id", "master_company",
  "scope_type", "scope_id",
  "user_id", "master_user_id", "tenant_user_id", "client_user_id", "project_user_id",
  "provider", "request_id",
];

/**
 * Apply filters to a single metering record.
 *
 * @param {object} rec
 * @param {object} filters
 * @returns {boolean}
 */
function matchesFilters(rec, filters) {
  if (filters.from && rec.timestamp < filters.from) return false;
  if (filters.to && rec.timestamp > filters.to) return false;
  if (filters.success !== undefined) {
    const recSuccess = rec.success !== false;
    if (filters.success !== recSuccess) return false;
  }
  for (const key of STRING_FILTERS) {
    if (filters[key] !== undefined && String(filters[key]) !== String(rec[key] ?? "")) return false;
  }
  return true;
}

/**
 * Query and paginate metering records from an array.
 *
 * @param {object[]} allRecords    — full record set (chronological order)
 * @param {object}   opts
 * @param {object}   [opts.filters={}]  — field equality filters + `from`/`to` ISO dates + `success` bool
 * @param {number}   [opts.limit=100]   — max records to return (capped at 1000)
 * @param {number}   [opts.offset=0]    — number of records to skip (after filtering)
 * @param {string}   [opts.order="desc"] — "desc" (newest first) or "asc" (oldest first)
 * @returns {{ records: object[], total: number, limit: number, offset: number, order: string }}
 */
function queryMeteringRecords(allRecords, opts = {}) {
  const filters = opts.filters || {};
  const limit = Math.min(Number.isFinite(Number(opts.limit)) ? Math.max(1, Number(opts.limit)) : 100, 1000);
  const offset = Math.max(0, Number.isFinite(Number(opts.offset)) ? Number(opts.offset) : 0);
  const order = opts.order === "asc" ? "asc" : "desc";

  // Filter first (preserve original order for stable pagination)
  const filtered = allRecords.filter((r) => matchesFilters(r, filters));
  const total = filtered.length;

  // Sort
  const sorted = order === "desc" ? filtered.slice().reverse() : filtered.slice();

  // Paginate
  const page = sorted.slice(offset, offset + limit);

  return { records: page, total, limit, offset, order };
}

/**
 * Compute a percentile value from a sorted numeric array.
 * Returns null if the array is empty.
 *
 * @param {number[]} sortedArr  — must be sorted ascending
 * @param {number}   p          — percentile 0–100
 * @returns {number|null}
 */
function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

/**
 * Compute aggregate statistics over an array of metering records.
 *
 * Returns:
 * - request counts (total, success, error)
 * - token totals and averages
 * - latency stats (avg, p50, p95)
 * - breakdowns by provider, scope_type, and project_id
 * - time range covered (earliest / latest timestamp)
 *
 * @param {object[]} records
 * @returns {object}
 */
function computeMeteringStats(records) {
  let successCount = 0;
  let tokensInput = 0;
  let tokensOutput = 0;
  let durationSum = 0;
  let durationCount = 0;
  const durations = [];
  const byProvider = {};
  const byScopeType = {};
  const byProjectId = {};
  let earliest = null;
  let latest = null;

  for (const r of records) {
    const isSuccess = r.success !== false;
    if (isSuccess) successCount++;

    if (typeof r.tokens_input === "number") tokensInput += r.tokens_input;
    if (typeof r.tokens_output === "number") tokensOutput += r.tokens_output;

    if (typeof r.duration_ms === "number") {
      durationSum += r.duration_ms;
      durationCount++;
      durations.push(r.duration_ms);
    }

    if (r.timestamp) {
      if (!earliest || r.timestamp < earliest) earliest = r.timestamp;
      if (!latest || r.timestamp > latest) latest = r.timestamp;
    }

    // Breakdowns — accumulate token counts per dimension key
    function addBreakdown(map, key) {
      if (!key) return;
      if (!map[key]) map[key] = { requests: 0, tokens_input: 0, tokens_output: 0 };
      map[key].requests++;
      if (typeof r.tokens_input === "number") map[key].tokens_input += r.tokens_input;
      if (typeof r.tokens_output === "number") map[key].tokens_output += r.tokens_output;
    }
    addBreakdown(byProvider, r.provider);
    addBreakdown(byScopeType, r.scope_type);
    addBreakdown(byProjectId, r.project_id);
  }

  durations.sort((a, b) => a - b);

  const total = records.length;
  return {
    total_requests: total,
    success_count: successCount,
    error_count: total - successCount,
    total_tokens_input: tokensInput,
    total_tokens_output: tokensOutput,
    total_tokens: tokensInput + tokensOutput,
    avg_tokens_input: total > 0 ? Math.round(tokensInput / total) : null,
    avg_tokens_output: total > 0 ? Math.round(tokensOutput / total) : null,
    avg_duration_ms: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    p50_duration_ms: percentile(durations, 50),
    p95_duration_ms: percentile(durations, 95),
    earliest_timestamp: earliest,
    latest_timestamp: latest,
    by_provider: byProvider,
    by_scope_type: byScopeType,
    by_project_id: byProjectId,
  };
}

module.exports = {
  buildMeteringRecord,
  createNoopMeteringSink,
  createJsonlMeteringSink,
  emitMetering,
  redactObject,
  readJsonlFile,
  queryMeteringRecords,
  computeMeteringStats,
  matchesFilters,
  STRING_FILTERS,
};
