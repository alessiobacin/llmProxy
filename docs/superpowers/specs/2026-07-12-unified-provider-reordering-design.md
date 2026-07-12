# Unified Provider Reordering — Design

Status: approved (pending spec self-review + user sign-off on written doc)
Date: 2026-07-12
Module: `llm-proxy` (module 45, dev port 5045)

## Problem

The proxy currently has four disconnected mechanisms that each mutate provider
fallback order, controlled by four env vars:

- `LLMPROXY_AUTO_ESCALATE` — reactive promotion of the next provider after N
  identical repeated requests (`lib/escalation-tracker.js`). Read once at
  module load in `lib/copilot-proxy.js`, not actually hot-reloadable despite
  being declared as such.
- `LLMPROXY_PRICE_PERFORMANCE_ROUTING` / `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER`
  — per-request in-memory ranking by static cost table + static
  power/speed tier scores (`lib/model-capabilities.js`), recomputed on every
  request in `lib/copilot-proxy.js`.
- `LLMPROXY_PROVIDER_BENCHMARK_MINUTES` — a real latency probe that runs on a
  timer (`lib/provider-benchmark.js`) but whose results are **only used for
  CLI display**, never for routing. Undocumented in `.env.example` /
  `llmproxy_settings.md`.
- A dormant "smart router" path (`smartRouteInfo`, `prioritizeProvider`,
  `findBestModel`) — confirmed dead code: nothing in the codebase populates
  `smartRouteInfo` anymore, since its trigger env vars (`LLMPROXY_SMART_ROUTE`,
  `LLMPROXY_SMART_PREFERENCE`) are already stripped as legacy elsewhere in
  `lib/configuration.js`.

None of these use real, live provider data consistently, and their precedence
relative to each other is hard to reason about. The goal is to delete all four
and replace them with one mechanism.

## Goals

- One env var pair controls all provider reordering.
- Ranking criteria are user-selectable and prioritized: price, power, speed.
- All three criteria are backed by real, live data (not static tables).
- A single scheduled job does the work; the runtime request path does no
  per-request recomputation.

## Non-goals

- No migration/back-compat shim for the four removed env vars — they are
  ignored silently if still present in a user's environment.
- No changes to the scoped/hierarchical `provider-registry.ts` system (used by
  the separate multi-tenant `llm-transport` path) — this design only touches
  the standalone `token-store` + `copilot-proxy.js` fallback path.

## Env vars

### `LLMPROXY_REORDERING`

A `-`-separated ordered list of criteria, most important first. Valid tokens:
`price`, `power`, `speed`.

- Subset allowed: `price`, `power-speed`, `speed-price-power`, etc. — 1 to 3
  tokens, no duplicates, unknown tokens are a validation error at startup.
- Absent or empty ⇒ automatic reordering is **disabled**. Providers keep
  whatever order is currently persisted in `token-store` (manual order via
  `provider:order`, or insertion order).

Example: `LLMPROXY_REORDERING=price-speed-power` — sort by cost first: among
equal-cost providers, prefer faster; among equal-cost-and-speed, prefer the
smarter (higher coding score) model.

### `LLMPROXY_REORDERING_MINUTES`

How often (in minutes) the reordering cycle runs.

- If `LLMPROXY_REORDERING` is set and this is missing/invalid ⇒ default `5`.
- If `LLMPROXY_REORDERING` is absent, this var has no effect regardless of its
  value.

### Scope: global only, not per-project

Today `LLMPROXY_PRICE_PERFORMANCE_ROUTING`/`TIEBREAKER` are `scope: "project"`
in `CONFIG_SPECS` — read per-request from each project's `.claude/settings.json`
via `resolveClaudeProjectSettings`, so different projects sharing the same
proxy instance could route differently. The new persisted `order` lives on
the single shared `token-store` (one global provider registry, not
per-project), so per-project override is physically incompatible with
"persist one order". `LLMPROXY_REORDERING` / `LLMPROXY_REORDERING_MINUTES`
are therefore **`scope: "service"`** — read once from the service's own
environment, same as `LLMPROXY_PROVIDER_BENCHMARK_MINUTES` is today, not
overridable per-project. `pricePerformanceRouting`/`pricePerformanceTieBreaker`
are removed entirely from `lib/project-context.js`'s
`resolveClaudeProjectSettings` return shape (all return sites), from
`lib/app.js`'s `handleMessages` → `executeGatewayRequest` call, and from
`executeGatewayRequest`'s options in `lib/copilot-proxy.js`.

### Removed vars

`LLMPROXY_AUTO_ESCALATE`, `LLMPROXY_PRICE_PERFORMANCE_ROUTING`,
`LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER`, `LLMPROXY_PROVIDER_BENCHMARK_MINUTES`
are removed from `CONFIG_SPECS`, `.env.example`, `README.md`, `README-IT.md`,
`llmproxy_settings.md`, and all code paths. If still present in a user's
environment post-upgrade, they are silently ignored — no warning, no residual
behavior.

## Scoring engine

Three criteria, each backed by real data, each fetched **only if requested**
in `LLMPROXY_REORDERING` (to avoid unnecessary network calls / probe cost):

| Criterion | Data source | Better = |
|---|---|---|
| `price` | `provider.free_model === true` → cost 0. Otherwise real pricing from `ai.cloudprice.net` (same endpoint already used by `fetchProviderPriceInfo` in `lib/cli.js` for CLI display) | lower cost |
| `power` | `coding_index` benchmark score from `ai.cloudprice.net/api/v1/models/{model}/benchmarks` (same endpoint/extraction already used by `fetchProviderCodingInfo`/`extractBenchmarkCodingScore` in `lib/cli.js`) | higher score |
| `speed` | Real inference latency probe, `max_tokens:1` request per provider (same mechanism as today's `provider-benchmark.js` `probeFn`) | lower latency |

Ranking is a **stable multi-key sort**: sort by the first listed criterion;
break ties with the second; break remaining ties with the third; final
stabilizer is the provider's current index (preserves relative manual order
among fully-tied providers).

**Missing data**: if a criterion's data can't be obtained for a provider
(no benchmark entry for that model, probe timeout/failure, pricing lookup
failure), that provider is treated as the worst possible on *that specific
criterion only* — ranking still proceeds using the other criteria and other
providers' valid data.

## Module & persistence

New module `lib/provider-reordering.js`, replacing `lib/provider-benchmark.js`
and `lib/escalation-tracker.js` (both deleted):

```
createProviderReordering({ tokenStore, fetchFn, probeFn, filePath })
```

- `runCycle()`:
  1. Resolve active criteria from `LLMPROXY_REORDERING`.
  2. Fetch only the data needed for those criteria, for each candidate
     provider (reusing/extracting the existing cloudprice.net + probe logic
     currently embedded in `lib/cli.js` / `lib/provider-benchmark.js` into a
     shared location so CLI display and the reordering engine use the same
     code, not duplicated logic).
  3. Rank providers (stable multi-key sort as above).
  4. Persist the new order into `token-store` via the existing
     `setProviderOrder` — same mechanism `provider:order` uses today, so CLI
     listing, API responses, and runtime fallback all read one source of
     truth.
  5. Persist scores + timestamp to a JSON store file (`provider-reordering.json`,
     replacing `provider-benchmark.json`) for CLI display and `provider:reorder`.
- `start(providers)`: if there's at least one valid criterion, runs an
  immediate cycle then repeats every `LLMPROXY_REORDERING_MINUTES` minutes
  (`setInterval(...).unref()`, same pattern as today's benchmark timer). If no
  criteria are configured, does nothing (no timer, no network calls).
- `getLastResult()`: last computed scores + order + timestamp, for CLI.

Wired into `lib/app.js` `startServer()` in place of the current
`provider-benchmark.js` block.

**Hot-reload scope**: each `runCycle()` tick re-reads `LLMPROXY_REORDERING`
fresh from the environment, so criteria changes take effect on the next
scheduled tick (or immediately via `provider:reorder`) without a restart —
genuinely hot-reloadable, unlike the old `LLMPROXY_AUTO_ESCALATE`. The tick
*interval* itself (`LLMPROXY_REORDERING_MINUTES`) is fixed at the
`setInterval` call made in `start()` during `startServer()`, so changing the
interval requires a restart to take effect — `CONFIG_SPECS` should declare
`LLMPROXY_REORDERING` as `hotReloadable: true` and
`LLMPROXY_REORDERING_MINUTES` as `restartRequired: true` accordingly.

## Runtime request path simplification

`lib/copilot-proxy.js` no longer computes any ordering per-request. It reads
`tokenStore.listProviders()` directly — already reflecting either the
persisted reordering-cycle result or the manual order, depending on whether
automatic reordering is enabled.

**Deleted from `lib/copilot-proxy.js`:**
- `estimateProviderRelativeCost`, `rankProvidersByPricePerformance`,
  `resolvePricePerformanceRoutingEnabled`, `resolvePricePerformanceTieBreaker`,
  `getProviderPowerScore`, `getProviderSpeedScore`
- `escalationTracker` instantiation, `selectEscalatedProviderIndex`,
  `shouldSuppressEscalation`, and all wiring at the point where escalation
  used to promote a provider
- `smartRouteInfo` threading (parameter always `null` in practice, confirmed
  dead), `prioritizeProvider()` (only caller was the smart-router branch)

**Deleted from `lib/model-capabilities.js`:**
- `findBestModel` (confirmed unused outside its own unit test — no runtime
  caller since smart router is dead code)

`isFreeModelProvider` / the `free_model` flag itself is **kept** — it's still
the source of "cost 0" for the `price` criterion, just consumed by the new
module instead of `copilot-proxy.js`.

## CLI

- **New command `provider:reorder`**: triggers an immediate reordering cycle
  (doesn't wait for the timer), persists the new order, prints a table of
  provider / price / power / speed / new position.
- **`provider:list` updated**: continues to show price/power columns using
  the same underlying fetch helpers (now shared with the reordering module
  instead of duplicated), adds a speed column sourced from the new
  `provider-reordering.json` store, and — when automatic reordering is
  active — a summary line like `reorder=price>speed>power (last: 3m ago)`.

## File map

**Deleted:**
- `lib/provider-benchmark.js`
- `lib/escalation-tracker.js`
- `tests/escalation-tracker.test.js`
- `findBestModel` + its tests in `tests/model-capabilities.test.js`

**Added:**
- `lib/provider-reordering.js`
- `tests/provider-reordering.test.js`
- `provider:reorder` CLI command (in `lib/cli.js`)

**Updated:**
- `lib/app.js` (wiring: swap benchmark start for reordering start)
- `lib/copilot-proxy.js` (delete price/performance/escalation/smart-router
  code, simplify fallback to read `listProviders()` directly)
- `lib/configuration.js` (`CONFIG_SPECS`: remove 4 old entries, add
  `LLMPROXY_REORDERING` + `LLMPROXY_REORDERING_MINUTES`; remove old default
  values)
- `lib/model-capabilities.js` (remove `findBestModel`)
- `lib/cli.js` (`provider:list` display, new `provider:reorder` command)
- `.env.example`, `README.md`, `README-IT.md`, `llmproxy_settings.md`
  (remove old var docs, document new vars)
- `tests/app.test.js`, `tests/copilot-proxy.test.js`,
  `tests/configuration.test.js` (remove tests for deleted mechanisms, add
  tests for the new module's integration into the request/fallback path)

## Testing plan

- Unit (`tests/provider-reordering.test.js`): criteria parsing/validation
  (subset, dedup, unknown token, empty ⇒ disabled), minutes default-when-missing,
  stable multi-key ranking with all/partial criteria, missing-data-treated-as-worst
  behavior, persistence into token-store `order`, JSON score store round-trip.
- Integration (`tests/app.test.js`): end-to-end `/v1/messages` scenarios
  verifying fallback order follows the persisted reordering result for
  various `LLMPROXY_REORDERING` values (price-only, price-speed-power,
  free-vs-paid ordering); verify old env vars have no effect when present.
- CLI (`tests/cli.test.js`): `provider:reorder` command output, `provider:list`
  display of the new speed column and reorder summary line.
- Removed: escalation-tracker unit tests, price/performance-specific
  integration tests, `findBestModel` unit tests, old-var `CONFIG_SPECS`
  assertions in `tests/configuration.test.js`.

## Release note

Per `CLAUDE.md`, the `llmproxy` package version must be bumped as part of the
same commit that lands this change.
