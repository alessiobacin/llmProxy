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
function createEventBusSink({ url, fetchFn = fetch } = {}) {
  if (!url) {
    return {
      name: "noop",
      async publish() {
        return { ok: true, skipped: true };
      },
    };
  }

  const publishUrl = `${url.replace(/\/+$/, "")}/api/v1/events/publish`;

  return {
    name: "event-bus",
    async publish({ payload, hierarchyContext, topic = TOPIC, version = VERSION, producer = PRODUCER } = {}) {
      if (!hierarchyContext) {
        // V11: skip publish when no hierarchy context is available — do not emit silently with "unknown"
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

        const response = await fetchFn(publishUrl, {
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
  };
}

module.exports = { createEventBusSink, buildEventBusHierarchyContext, TOPIC, VERSION, PRODUCER };
