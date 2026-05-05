"use strict";

/**
 * db-layer HTTP metering sink.
 *
 * Sends metering records to the db-layer microservice
 * (https://github.com/alessiobacin/dbLayer) via HTTP.
 *
 * Port convention:
 *   development  → db-layer on port 5046
 *   staging      → db-layer on port 6046  (Docker service name: dblayer)
 *   production   → db-layer on port 7046  (Docker service name: dblayer)
 *
 * Fallback behaviour:
 *   If db-layer is not reachable, every record() call falls through to a
 *   local fallbackSink (JSONL by default in platform mode).
 *   All responses to the LLM API caller will carry:
 *     Warning: 199 llmproxy "db-layer not responding, metering stored locally"
 *
 * db-layer API contract assumed:
 *   GET  {url}/health          → { ok: true }
 *   POST {url}/metering        → body: MeteringRecord → { ok: true }
 *   GET  {url}/metering?...    → { records, total, limit, offset, order }
 *   GET  {url}/metering/stats? → stats object (same shape as computeMeteringStats)
 */

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS  =  3_000;
const REQUEST_TIMEOUT_MS       =  5_000;

/**
 * Resolve the db-layer base URL from environment variables.
 * Priority: DBLAYER_URL → derived from LLMPROXY_ENV / NODE_ENV → default dev port.
 *
 * @returns {string}
 */
function resolveDbLayerUrl() {
  if (process.env.DBLAYER_URL) return process.env.DBLAYER_URL.replace(/\/$/, "");

  const env = (process.env.LLMPROXY_ENV || process.env.NODE_ENV || "development").toLowerCase();
  if (env === "production") return "http://localhost:7046";
  if (env === "staging")    return "http://localhost:6046";
  return "http://localhost:5046";
}

/**
 * Serialise metering query opts to URLSearchParams.
 *
 * @param {object} opts
 * @returns {string}
 */
function buildQueryString(opts = {}) {
  const params = new URLSearchParams();
  const f = opts.filters || {};

  if (f.from)    params.set("from",    f.from);
  if (f.to)      params.set("to",      f.to);
  if (f.success !== undefined) params.set("success", String(f.success));

  const STRING_FIELDS = [
    "project_id", "tenant_id", "client_id", "master_company",
    "scope_type", "scope_id",
    "user_id", "master_user_id", "tenant_user_id", "client_user_id", "project_user_id",
    "provider", "request_id",
  ];
  for (const key of STRING_FIELDS) {
    if (f[key] !== undefined) params.set(key, String(f[key]));
  }

  if (opts.limit  !== undefined) params.set("limit",  String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.order  !== undefined) params.set("order",  String(opts.order));

  return params.toString();
}

/**
 * Create a timed AbortController.
 *
 * @param {number} ms
 * @returns {{ controller: AbortController, clear: () => void }}
 */
function timedAbort(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Create a db-layer HTTP metering sink.
 *
 * @param {object}   options
 * @param {string}   [options.url]           — db-layer base URL (default: auto-resolved)
 * @param {object}   [options.fallbackSink]  — local sink used when db-layer is unavailable
 * @param {Function} [options.fetchFn]       — injectable fetch for testing
 * @returns {object}  sink
 */
function createDbLayerSink({ url, fallbackSink, fetchFn } = {}) {
  const resolvedUrl = url !== undefined ? url : resolveDbLayerUrl();
  if (typeof resolvedUrl !== "string" || resolvedUrl.trim() === "") {
    throw new Error("createDbLayerSink requires a non-empty url");
  }
  const baseUrl   = resolvedUrl.replace(/\/$/, "");
  const _fetch    = fetchFn || globalThis.fetch;

  let _available  = false;   // cached availability (updated by health probe)
  let _healthTimer = null;

  async function probe() {
    const { signal, clear } = timedAbort(HEALTH_CHECK_TIMEOUT_MS);
    try {
      const r = await _fetch(`${baseUrl}/health`, { signal });
      clear();
      _available = r.ok;
    } catch {
      _available = false;
    }
  }

  // Kick off health probing asynchronously — startup is non-blocking.
  probe().then(() => {
    _healthTimer = setInterval(probe, HEALTH_CHECK_INTERVAL_MS);
    // Don't hold the event loop open just for the health timer
    if (_healthTimer.unref) _healthTimer.unref();
  }).catch(() => {
    _available = false;
    _healthTimer = setInterval(probe, HEALTH_CHECK_INTERVAL_MS);
    if (_healthTimer.unref) _healthTimer.unref();
  });

  return {
    name: "dblayer",

    /**
     * Returns the last known availability of the db-layer service.
     * Non-blocking: uses the cached result of the background health probe.
     *
     * @returns {boolean}
     */
    isAvailable() {
      return _available;
    },

    /**
     * Send a metering record to db-layer.
     * Falls back to fallbackSink when db-layer is unavailable.
     *
     * @param {object} doc
     * @returns {Promise<void>}
     */
    async record(doc) {
      if (_available) {
        const { signal, clear } = timedAbort(REQUEST_TIMEOUT_MS);
        try {
          const r = await _fetch(`${baseUrl}/metering`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(doc),
            signal,
          });
          clear();
          if (r.ok) return;
          // db-layer returned a non-OK status — treat as unavailable and fall through
          _available = false;
        } catch {
          _available = false;
        }
      }

      if (fallbackSink) {
        await fallbackSink.record(doc);
      }
    },

    /**
     * Query metering records from db-layer (or fallback).
     *
     * @param {object} opts
     * @returns {Promise<{ records, total, limit, offset, order }>}
     */
    async query(opts = {}) {
      if (_available) {
        const qs = buildQueryString(opts);
        const { signal, clear } = timedAbort(REQUEST_TIMEOUT_MS);
        try {
          const r = await _fetch(`${baseUrl}/metering${qs ? `?${qs}` : ""}`, { signal });
          clear();
          if (r.ok) return r.json();
          _available = false;
        } catch {
          _available = false;
        }
      }

      if (fallbackSink && typeof fallbackSink.query === "function") {
        return Promise.resolve(fallbackSink.query(opts));
      }

      const limit  = Number(opts.limit)  || 100;
      const offset = Number(opts.offset) || 0;
      return { records: [], total: 0, limit, offset, order: opts.order || "desc" };
    },

    /**
     * Retrieve aggregate stats from db-layer (or fallback).
     *
     * @param {object} [filters={}]
     * @returns {Promise<object>}
     */
    async computeStats(filters = {}) {
      if (_available) {
        const qs = buildQueryString({ filters });
        const { signal, clear } = timedAbort(REQUEST_TIMEOUT_MS);
        try {
          const r = await _fetch(`${baseUrl}/metering/stats${qs ? `?${qs}` : ""}`, { signal });
          clear();
          if (r.ok) return r.json();
          _available = false;
        } catch {
          _available = false;
        }
      }

      if (fallbackSink && typeof fallbackSink.computeStats === "function") {
        return Promise.resolve(fallbackSink.computeStats(filters));
      }
      if (fallbackSink && typeof fallbackSink.query === "function") {
        const { computeMeteringStats } = require("./metering");
        const result = await Promise.resolve(fallbackSink.query({ filters, limit: 1_000_000, offset: 0, order: "asc" }));
        return { ...computeMeteringStats(result.records), filtered_total: result.total };
      }

      const { computeMeteringStats } = require("./metering");
      return computeMeteringStats([]);
    },

    /**
     * Stop the background health probe timer.
     * Call when shutting down the server.
     *
     * @returns {Promise<void>}
     */
    async close() {
      if (_healthTimer) {
        clearInterval(_healthTimer);
        _healthTimer = null;
      }
      if (fallbackSink && typeof fallbackSink.close === "function") {
        await fallbackSink.close();
      }
    },
  };
}

module.exports = { createDbLayerSink, resolveDbLayerUrl, buildQueryString };
