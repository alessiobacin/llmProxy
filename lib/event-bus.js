"use strict";

/**
 * event-bus.js — llmProxy integration with the Event Bus microservice (module 48).
 *
 * Publishes a `llmproxy.call.completed` event after each LLM request via the
 * Event Bus HTTP API:
 *   POST /api/v1/events/publish
 *
 * Topic format (event-bus rule): lowercase dot-separated, e.g. `llmproxy.call.completed`.
 * hierarchy_context must contain `tenantId` (camelCase) as required by the event-bus schema.
 *
 * Environment variables:
 *   EVENTBUS_URL  — base URL of the event-bus service (e.g. http://localhost:5048)
 *                   If unset or empty the sink is a no-op.
 */

const TOPIC = "llmproxy.call.completed";
const VERSION = "1.0";
const PRODUCER = "llmproxy";

/**
 * Map llmProxy's snake_case hierarchyContext to the event-bus's camelCase format.
 * The event-bus schema requires `tenantId` at minimum.
 *
 * @param {object|null} hc
 * @returns {{ tenantId: string, [key: string]: string }}
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildEventBusHierarchyContext } = require("./platform-context");
/**
 * Create an event-bus sink.
 *
 * The returned object has a single `publish(record)` method that fires and
 * forgets (errors are caught and returned, never thrown).
 *
 * @param {{ url?: string, fetchFn?: typeof fetch }} options
 * @returns {{ name: string, publish: (record: object) => Promise<{ ok: boolean, error?: string }> }}
 */
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS  =  3_000;

async function healthProbe(baseUrl, fetchFn) {
  try {
    const r = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
    return r.ok;
  } catch {
    return false;
  }
}

function createEventBusSink({ url, fetchFn = fetch, notifier, healthCheckIntervalMs } = {}) {
  if (!url) {
    return {
      name: "noop",
      async publish() { return { ok: true, skipped: true }; },
      async close() {},
    };
  }

  const baseUrl = String(url).replace(/\/+$/, "");
  const publishUrl = `${baseUrl}/api/v1/events/publish`;
  const _fetch = fetchFn;
  const _notifier = notifier || null;
  const _interval = Number.isFinite(healthCheckIntervalMs) && healthCheckIntervalMs > 0
    ? healthCheckIntervalMs
    : HEALTH_CHECK_INTERVAL_MS;

  let _available = false;
  let _healthTimer = null;

  async function probe() {
    const wasAvailable = _available;
    _available = await healthProbe(baseUrl, _fetch);

    if (_notifier) {
      if (wasAvailable && !_available) {
        _notifier.notifyUnreachable("event-bus", baseUrl, new Error("health check failed"));
      } else if (!wasAvailable && _available) {
        _notifier.notifyRecovered("event-bus", baseUrl);
      }
    }
  }

  // Startup health probe — non-blocking
  probe().then(() => {
    _healthTimer = setInterval(probe, _interval);
    if (_healthTimer.unref) _healthTimer.unref();
  }).catch(() => {
    _available = false;
    _healthTimer = setInterval(probe, _interval);
    if (_healthTimer.unref) _healthTimer.unref();
  });

  return {
    name: "event-bus",
    async publish({ payload, hierarchyContext, topic = TOPIC, version = VERSION, producer = PRODUCER } = {}) {
      if (!hierarchyContext) {
        return { ok: false, error: "HIERARCHY_CONTEXT_MISSING_TENANT: tenant_id is required for event-bus publication" };
      }
      try {
        const body = {
          topic,
          version,
          payload,
          hierarchy_context: buildEventBusHierarchyContext(hierarchyContext),
          producer,
        };

        const response = await _fetch(publishUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return { ok: false, error: `event-bus ${response.status}: ${text.slice(0, 200)}` };
        }

        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    isAvailable() {
      return _available;
    },

    async close() {
      if (_healthTimer) {
        clearInterval(_healthTimer);
        _healthTimer = null;
      }
    },
  };
}

module.exports = { createEventBusSink, buildEventBusHierarchyContext, TOPIC, VERSION, PRODUCER };
