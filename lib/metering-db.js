"use strict";

/**
 * MongoDB-backed metering sink.
 *
 * This module implements the same sink interface as the JSONL sink but persists
 * metering records to a MongoDB collection. It is selected when the env var
 * LLMPROXY_METERING_SINK=db and LLMPROXY_MONGODB_URI is set.
 *
 * Interface contract (same for every sink):
 *   sink.record(doc): Promise<void>
 *   sink.query(opts): Promise<{ records, total, limit, offset, order }>
 *   sink.computeStats(filters): Promise<stats>   ← DB-side aggregation
 *   sink.close(): Promise<void>
 *
 * When the dbLayer package (https://github.com/alessiobacin/dbLayer) becomes
 * available, the MongoClient calls below can be replaced with the equivalent
 * dbLayer calls while keeping the sink interface stable.
 */

const { MongoClient } = require("mongodb");
const { redactObject, computeMeteringStats, STRING_FILTERS } = require("./metering");

// Fields used for exact-match filtering — must stay in sync with STRING_FILTERS in metering.js
const EXACT_MATCH_FIELDS = STRING_FILTERS;

/**
 * Convert our filter format to a MongoDB query document.
 *
 * @param {object} filters
 * @returns {object}  MongoDB filter document
 */
function buildMongoFilter(filters = {}) {
  const query = {};

  if (filters.from || filters.to) {
    query.timestamp = {};
    if (filters.from) query.timestamp.$gte = filters.from;
    if (filters.to)   query.timestamp.$lte = filters.to;
  }

  if (filters.success !== undefined) {
    // Records written without an explicit `success` field default to true
    if (filters.success === true) {
      query.$or = [{ success: true }, { success: { $exists: false } }];
    } else {
      query.success = false;
    }
  }

  for (const key of EXACT_MATCH_FIELDS) {
    if (filters[key] !== undefined) {
      query[key] = String(filters[key]);
    }
  }

  return query;
}

/**
 * Build the MongoDB aggregation pipeline that computes the same stats as
 * computeMeteringStats() but entirely server-side — avoiding large in-memory
 * data transfers.
 *
 * @param {object} mongoFilter  — already-built MongoDB query document
 * @returns {object[]}          — aggregation pipeline stages
 */
function buildStatsPipeline(mongoFilter) {
  return [
    { $match: mongoFilter },
    {
      $facet: {
        // Overall aggregates
        totals: [
          {
            $group: {
              _id: null,
              total_requests:    { $sum: 1 },
              success_count:     { $sum: { $cond: [{ $ne: ["$success", false] }, 1, 0] } },
              total_tokens_input:  { $sum: { $ifNull: ["$tokens_input",  0] } },
              total_tokens_output: { $sum: { $ifNull: ["$tokens_output", 0] } },
              avg_tokens_input:    { $avg: "$tokens_input"  },
              avg_tokens_output:   { $avg: "$tokens_output" },
              avg_duration_ms:     { $avg: "$duration_ms"  },
              durations: { $push: "$duration_ms" },
              earliest_timestamp:  { $min: "$timestamp" },
              latest_timestamp:    { $max: "$timestamp" },
            },
          },
        ],
        // Breakdown by provider
        by_provider: [
          { $match: { provider: { $ne: null } } },
          {
            $group: {
              _id: "$provider",
              requests:      { $sum: 1 },
              tokens_input:  { $sum: { $ifNull: ["$tokens_input",  0] } },
              tokens_output: { $sum: { $ifNull: ["$tokens_output", 0] } },
            },
          },
        ],
        // Breakdown by scope_type
        by_scope_type: [
          { $match: { scope_type: { $ne: null } } },
          {
            $group: {
              _id: "$scope_type",
              requests:      { $sum: 1 },
              tokens_input:  { $sum: { $ifNull: ["$tokens_input",  0] } },
              tokens_output: { $sum: { $ifNull: ["$tokens_output", 0] } },
            },
          },
        ],
        // Breakdown by project_id
        by_project_id: [
          { $match: { project_id: { $ne: null } } },
          {
            $group: {
              _id: "$project_id",
              requests:      { $sum: 1 },
              tokens_input:  { $sum: { $ifNull: ["$tokens_input",  0] } },
              tokens_output: { $sum: { $ifNull: ["$tokens_output", 0] } },
            },
          },
        ],
      },
    },
  ];
}

/**
 * Reshape the raw $facet result into the same shape as computeMeteringStats().
 *
 * Percentile computation is done in JS from the durations array returned by
 * the pipeline (unavoidable: MongoDB has no native percentile operator before
 * Atlas 7.x).
 *
 * @param {object} facetResult  — the single document returned by the pipeline
 * @returns {object}
 */
function reshapeStatsResult(facetResult) {
  const t = facetResult.totals[0] || {};

  // Compute p50/p95 from raw durations array
  const durations = (t.durations || []).filter((d) => d != null).sort((a, b) => a - b);
  function percentile(arr, p) {
    if (!arr.length) return null;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, Math.min(idx, arr.length - 1))];
  }

  function toMap(arr) {
    const map = {};
    for (const entry of arr) {
      if (entry._id) map[entry._id] = { requests: entry.requests, tokens_input: entry.tokens_input, tokens_output: entry.tokens_output };
    }
    return map;
  }

  const total = t.total_requests || 0;
  const successCount = t.success_count || 0;

  return {
    total_requests: total,
    success_count: successCount,
    error_count: total - successCount,
    total_tokens_input:  t.total_tokens_input  || 0,
    total_tokens_output: t.total_tokens_output || 0,
    total_tokens: (t.total_tokens_input || 0) + (t.total_tokens_output || 0),
    avg_tokens_input:  t.avg_tokens_input  != null ? Math.round(t.avg_tokens_input)  : null,
    avg_tokens_output: t.avg_tokens_output != null ? Math.round(t.avg_tokens_output) : null,
    avg_duration_ms:   t.avg_duration_ms   != null ? Math.round(t.avg_duration_ms)   : null,
    p50_duration_ms: percentile(durations, 50),
    p95_duration_ms: percentile(durations, 95),
    earliest_timestamp: t.earliest_timestamp || null,
    latest_timestamp:   t.latest_timestamp   || null,
    by_provider:   toMap(facetResult.by_provider   || []),
    by_scope_type: toMap(facetResult.by_scope_type || []),
    by_project_id: toMap(facetResult.by_project_id || []),
  };
}

/**
 * Create a MongoDB-backed metering sink.
 *
 * The MongoClient connection is established lazily on the first call to
 * `record()` or `query()` — app startup does not block.
 *
 * @param {object} options
 * @param {string} options.uri              — MongoDB connection string
 * @param {string} [options.dbName]         — database name (default: "llmProxy")
 * @param {string} [options.collectionName] — collection name (default: "metering")
 * @returns {object}  sink
 */
function createMongoMeteringSink({ uri, dbName = "llmProxy", collectionName = "metering" } = {}) {
  if (!uri) throw new Error("createMongoMeteringSink requires { uri }");

  let client = null;
  let col = null;
  let connectPromise = null;

  async function connect() {
    if (col) return col;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await client.connect();
      const db = client.db(dbName);
      col = db.collection(collectionName);

      // Create indexes for efficient querying on common filter fields
      await col.createIndex({ timestamp: -1 }, { background: true });
      await col.createIndex({ project_id: 1, timestamp: -1 }, { background: true });
      await col.createIndex({ tenant_id:   1, timestamp: -1 }, { background: true });
      await col.createIndex({ master_company: 1, timestamp: -1 }, { background: true });
      await col.createIndex({ provider: 1 }, { background: true });
      await col.createIndex({ success:  1 }, { background: true });
      await col.createIndex({ request_id: 1 }, { sparse: true, unique: true, background: true });

      return col;
    })();

    return connectPromise;
  }

  return {
    name: "mongodb",

    /**
     * Persist a metering record.
     * Sensitive fields are redacted before insertion.
     *
     * @param {object} doc
     * @returns {Promise<void>}
     */
    async record(doc) {
      const collection = await connect();
      const safe = redactObject(doc);
      // Remove _id to let MongoDB generate one; keep request_id as unique key
      delete safe._id;
      await collection.insertOne(safe);
    },

    /**
     * Query metering records from MongoDB.
     *
     * @param {object} opts
     * @param {object} [opts.filters={}]
     * @param {number} [opts.limit=100]
     * @param {number} [opts.offset=0]
     * @param {string} [opts.order="desc"]
     * @returns {Promise<{ records: object[], total: number, limit: number, offset: number, order: string }>}
     */
    async query(opts = {}) {
      const collection = await connect();

      const filters = opts.filters || {};
      const limit  = Math.min(Number.isFinite(Number(opts.limit))  ? Math.max(1, Number(opts.limit))  : 100, 1000);
      const offset = Math.max(0, Number.isFinite(Number(opts.offset)) ? Number(opts.offset) : 0);
      const order  = opts.order === "asc" ? 1 : -1;

      const mongoFilter = buildMongoFilter(filters);
      const sortSpec    = { timestamp: order };

      const [total, rawRecords] = await Promise.all([
        collection.countDocuments(mongoFilter),
        collection
          .find(mongoFilter, { projection: { _id: 0 } })
          .sort(sortSpec)
          .skip(offset)
          .limit(limit)
          .toArray(),
      ]);

      return {
        records: rawRecords,
        total,
        limit,
        offset,
        order: opts.order === "asc" ? "asc" : "desc",
      };
    },

    /**
     * Compute aggregate statistics server-side via MongoDB aggregation.
     * This is more efficient than fetching all records into memory.
     *
     * @param {object} [filters={}]
     * @returns {Promise<object>}  same shape as computeMeteringStats()
     */
    async computeStats(filters = {}) {
      const collection = await connect();
      const mongoFilter = buildMongoFilter(filters);
      const pipeline    = buildStatsPipeline(mongoFilter);
      const [facetResult] = await collection.aggregate(pipeline).toArray();
      if (!facetResult) {
        return computeMeteringStats([]);
      }

      // Count separately (the $facet doesn't give us a simple total)
      const total = await collection.countDocuments(mongoFilter);
      const stats = reshapeStatsResult(facetResult);
      stats.filtered_total = total;
      return stats;
    },

    /**
     * Close the MongoDB connection. Call when the process is shutting down.
     *
     * @returns {Promise<void>}
     */
    async close() {
      if (client) {
        await client.close();
        client = null;
        col = null;
        connectPromise = null;
      }
    },
  };
}

module.exports = { createMongoMeteringSink, buildMongoFilter };
