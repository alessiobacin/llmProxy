"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Active gateway logic delegated to strict TypeScript
const tsAttribution = require("./ts-build/gateway/metering/attribution");

const buildMeteringRecord = tsAttribution.buildMeteringRecord;
const emitMetering = tsAttribution.emitMetering;
const redactObject = tsAttribution.redactObject;
const SENSITIVE_KEYS = tsAttribution.SENSITIVE_KEYS;

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
    computeStats(filters = {}) {
      const result = queryMeteringRecords(records, { filters, limit: 1_000_000, offset: 0, order: "asc" });
      return { ...computeMeteringStats(result.records), filtered_total: result.total };
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
    computeStats(filters = {}) {
      const allRecords = readJsonlFile(filePath);
      const result = queryMeteringRecords(allRecords, { filters, limit: 1_000_000, offset: 0, order: "asc" });
      return { ...computeMeteringStats(result.records), filtered_total: result.total };
    },
  };
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
  const byModel = {};
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
    addBreakdown(byModel, r.model_used);
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
    by_model: byModel,
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
