# V11 Refactor Implementation Plan — Module 45 `llm-proxy`

## Context

`llm-proxy` is Module 45, port `5045`, and its V11 role is narrowly defined: it is a **Gateway** that proxies LLM provider calls for internal V11 services. Per the specs, it should own only the technical provider boundary: request execution, streaming, provider/model selection, fallback, provider health, token/cost attribution, and observability/event emission.

The current implementation is broader than that boundary. The repo contains:
- core proxy transport that belongs in the gateway
- but also CLI-over-HTTP control operations
- local service lifecycle management
- project/workspace introspection
- ad hoc auth/tenancy enforcement
- local token/provider credential storage
- metering persistence/query/stats ownership
- a direct MongoDB backend

The refactor must follow the **Strangler Fig** pattern:
1. isolate new V11-compliant seams
2. redirect behavior one route/concern at a time
3. preserve working transport logic where valid
4. delete only after verified replacement

---

## 1. Target V11 Boundary for `llm-proxy`

### Keep inside `llm-proxy`
These remain the long-term responsibilities of Module 45:

- provider request proxying
- streaming normalization
- provider/model selection
- provider fallback
- provider health/latency tracking
- token usage extraction
- cost attribution generation
- event emission / observability hooks
- provider-facing translation adapters
- gateway-facing LLM routes for complete/stream/models/health/usage

Representative code to preserve and progressively wrap:
- `lib/copilot-proxy.js`
- `lib/openai-translate.js`
- `lib/openai-format.js`
- `lib/copilot-responses.js`
- `lib/event-bus.js`
- selected route logic in `lib/app.js`

### Remove from `llm-proxy`
These are outside the V11 gateway boundary and must be migrated or retired:

- CLI-over-HTTP control plane
- OS service management
- project/workspace/.claude introspection
- direct database access
- in-gateway metering persistence/query/stats
- local auth UX and local provider-wallet UX
- broad operational tooling surface unrelated to provider proxying

---

## 2. Feature Creep Removal Plan

### A. CLI-over-HTTP control plane
#### Current files/routes
- `lib/app.js`
  - `/api/version`
  - `/api/help`
  - `/api/setup`
  - `/api/auth/login`
  - `/api/auth/logout`
  - `/api/service/status`
  - `/api/service/start`
  - `/api/service/stop`
  - `/api/service/restart`
  - `/api/logs`
  - `/api/logs/stream`
  - `/api/models`
  - `/api/test`
  - `/api/claude/setup`
  - `/api/providers/:id/login`
  - `/api/providers/:id/api-key`
  - `/api/providers`
  - `/api/providers/status`
  - `/api/providers/order`
  - `/api/providers/:id/rename`
  - `/api/providers/:id`
- `lib/cli.js`
- `bin/llmproxy.js`

#### V11 disposition
**Cut from gateway.**

#### Migration destination
- operational install/start/stop/logging concerns should live in **deployment/bootstrap tooling**, not in a gateway runtime module
- provider auth bootstrap belongs under **auth-gateway** if it is a governed credential/token boundary
- Claude/editor/project setup does not belong to any gateway; it should move to **developer tooling / local bootstrap scripts**, not a numbered V11 module

#### Strangler sequence
1. Freeze these routes as legacy.
2. Document them as non-canonical.
3. Build replacement operational workflows outside the gateway.
4. Redirect internal consumers away from `/api/*`.
5. Remove route registrations only after consumer confirmation.

### B. Service lifecycle management
#### Current files
- `lib/service-manager.js`
- `lib/service/launchd.js`
- `lib/service/systemd.js`
- `lib/service/docker-launchd-entry.js`

#### V11 disposition
**Cut from gateway.**

#### Migration destination
- deployment/runtime/bootstrap layer
- environment-specific infra scripts or service templates
- not another business module

#### Strangler sequence
1. Stop treating service management as gateway API behavior.
2. Extract install/run docs to deployment tooling.
3. Remove runtime dependencies from app composition after CLI-over-HTTP removal is complete.

### C. Project/workspace introspection
#### Current files
- `lib/project-context.js`
- `lib/app.js` integration points

#### What it does now
- infers project path from headers/body/messages/system text
- reads `package.json`
- traverses `.claude/settings.json`
- affects model-routing behavior

#### V11 disposition
**Cut from gateway.**

#### Migration destination
- consuming runtime / agent tooling if still needed
- local developer UX tooling
- not a gateway, not a service boundary

#### Strangler sequence
1. Introduce explicit request metadata contracts for anything the gateway truly needs.
2. Remove hidden project-path inference from proxy path.
3. Preserve only explicit metadata fields allowed by spec.

### D. Metering persistence/query/stats inside gateway
#### Current files
- `lib/metering.js`
- `lib/metering-db.js`
- `lib/metering-dblayer.js`
- metering endpoints in `lib/app.js`

#### What the spec requires
The gateway should do token/cost attribution and observability emission, but the system-level ownership of billing and policy belongs elsewhere:
- `policy-service`
- `billing-service`
- `stores/billing-ledger-store`
- `event-bus`

#### V11 disposition
**Replace.**

#### Migration destination
- attribution records → `billing-ledger-store` via billing integration
- events/telemetry → `event-bus` and/or `telemetry-service`
- query/reporting surfaces → billing/telemetry-owned services, not `llm-proxy`

#### Strangler sequence
1. Keep current record-shape generation logic temporarily.
2. Introduce a new attribution/emission adapter seam.
3. Redirect write path first:
   - from local JSONL/Mongo/db-layer persistence
   - to billing-ledger + telemetry/event emission
4. Once write path is replaced and verified, deprecate in-gateway query/stats endpoints.
5. Remove Mongo sink last.

### E. Direct MongoDB access
#### Current files
- `lib/metering-db.js`
- Mongo references in `lib/app.js`
- `package.json` dependency implications

#### V11 disposition
**Replace completely.**

#### Migration destination
- no direct DB in this module
- any persistence must be through proper V11 service integration

#### Strangler sequence
1. Build the new attribution sink first.
2. Run both paths in shadow mode if needed for comparison.
3. Verify parity on usage/cost/latency attribution.
4. Remove Mongo sink and dependency.

### F. Ad hoc auth/tenancy enforcement
#### Current files
- `lib/platform-context.js`
- role checks in `lib/app.js`
- provider ownership assumptions in `lib/provider-registry.js`
- token handling in `lib/token-store.js`

#### Current mismatch
- hierarchy validation is weaker than V11 tenancy rules
- uses custom role values like `admin` / `owner`
- no evidence of `jose`-aligned JWT handling
- tenant/agency naming is blurred
- event-bus fallback to `"unknown"` tenant weakens auditability

#### V11 disposition
**Replace.**

#### Migration destination
- authentication and JWT issuance/validation: **auth-gateway**
- gateway-side authorization enforcement: local middleware consuming standardized claims/context
- secret ownership/governed credential boundaries: **auth-gateway** and related secure config paths

#### Strangler sequence
1. Define normalized incoming auth/context contract for Module 45.
2. Introduce gateway middleware that accepts only V11-compliant claims/context.
3. Adapt old `x-hierarchy-context` parsing behind a compatibility layer.
4. Migrate role checks to spec roles:
   - `tenant_admin`
   - `tenant_operator`
   - `tenant_viewer`
   - `platform_admin`
   - `platform_support`
5. Remove ad hoc role checks after verified parity.

### G. Local token/provider wallet behavior
#### Current files
- `lib/token-store.js`
- `lib/provider-registry.js`
- `lib/copilot-auth.js`

#### V11 disposition
**Replace.**

#### Migration destination
- external credential governance → **auth-gateway**
- tenant-owned provider credentials → governed secret/config path owned by security/auth boundary
- provider selection metadata may remain in gateway only if it is non-secret and transport-specific

#### Strangler sequence
1. Separate:
   - provider routing metadata
   - provider secrets/tokens
2. Keep routing metadata seam if needed.
3. Replace secret storage with governed runtime-injected credential resolution.
4. Remove local secret persistence after verification.

---

## 3. Core Missing V11 Gaps Derived from Specs

These are the gaps the implementation plan must close because the docs explicitly require them.

### Required by `README.md` / `TECHNICAL-SPEC.md`
1. **Governance integration**
   - integrate with `policy-service`
   - enforce model restrictions
   - enforce budget decisions from governance layer

2. **Billing attribution integration**
   - send cost attribution to `stores/billing-ledger-store`

3. **Observability/eventing**
   - improved observability
   - usage/failure event emission
   - provider latency/health reporting

4. **V11 contract alignment**
   - align interfaces to V11
   - align config to V11 registry model
   - audit and close v9→V11 drift

5. **Gateway purity**
   - remove non-gateway business/ops/developer logic from the runtime module

### Platform-level gaps from `CLAUDE.md`
6. **Stack alignment**
   - current implementation is Express + MongoDB era
   - V11 mandates Next.js App Router or Fastify
   - gateway should move to a compliant shell

7. **Tenancy alignment**
   - full ancestry-aware scope model
   - no flat or partial pseudo-tenant handling

8. **Auth alignment**
   - standardized JWT / claims / RBAC conventions
   - no custom role shortcuts

9. **No direct DB access**
   - current Mongo path conflicts with platform rule

---

## 4. Recommended Target Architecture

### A. Route layer
Introduce a clear V11 gateway route surface under a dedicated route layer.

Target concerns:
- completion route
- stream route
- models route
- health route
- usage/attribution route if still required by spec

### B. Gateway orchestration layer
Split current `lib/app.js` responsibilities into:
- request validation / auth context extraction
- provider execution orchestration
- attribution emission
- error mapping

### C. Provider adapter layer
Refactor `lib/copilot-proxy.js` into smaller seams:
- provider selection
- request translation
- retry/fallback
- stream normalization
- provider-specific adapter logic

### D. Integration layer
Explicit adapters for:
- `policy-service`
- `billing-ledger-store` or billing integration API
- `event-bus`
- telemetry/health reporting

### E. Compatibility layer
Temporary adapters to preserve existing working routes while redirecting to new internals one seam at a time.

---

## 5. Incremental Strangler-Fig Execution Sequence

### Phase 1 — Freeze legacy scope and define canonical boundary
Goal: stop feature creep and mark canonical vs legacy surfaces.

Steps:
1. Mark current `/api/*` runtime control routes as legacy.
2. Define canonical V11 routes for the gateway.
3. Define source-of-truth contracts for:
   - auth context
   - tenancy context
   - provider execution request
   - attribution output
4. Add tests that lock in required gateway behavior only.

Verification:
- route inventory documented
- tests distinguish canonical gateway behavior from legacy compatibility behavior

### Phase 2 — Extract pure transport core
Goal: isolate valid gateway behavior from `lib/app.js`.

Steps:
1. Create a transport service seam around:
   - provider selection
   - request execution
   - streaming
   - translation
2. Wrap current `lib/copilot-proxy.js` behind a new service interface rather than rewriting it first.
3. Move route handlers to call the new seam.

Files primarily affected later:
- `lib/app.js`
- `lib/copilot-proxy.js`
- `lib/openai-format.js`
- `lib/openai-translate.js`

Verification:
- existing transport tests still pass
- route behavior unchanged for canonical proxy routes

### Phase 3 — Introduce V11 auth/tenancy boundary
Goal: replace custom context parsing with V11-compliant boundary enforcement.

Steps:
1. Add middleware/adapter for standardized claims/context.
2. Normalize agency/tenant semantics.
3. Enforce ancestry rules required by V11.
4. Replace custom role checks with platform role checks.
5. Keep backward-compatible header parsing only as a temporary adapter.

Files primarily affected later:
- `lib/platform-context.js`
- `lib/app.js`
- `tests/app-platform.test.js`

Verification:
- valid ancestry contexts accepted
- incomplete or ambiguous contexts rejected
- role enforcement matches documented RBAC

### Phase 4 — Replace metering storage with attribution/event integrations
Goal: remove persistence ownership from the gateway.

Steps:
1. Introduce a new attribution sink interface.
2. Implement sinks for:
   - billing-ledger attribution
   - event-bus / telemetry emission
3. Redirect write path from JSONL/Mongo/db-layer persistence to the new sinks.
4. Keep existing metering record-shape logic only if needed for compatibility.

Files primarily affected later:
- `lib/metering.js`
- `lib/metering-db.js`
- `lib/metering-dblayer.js`
- `lib/event-bus.js`
- `lib/app.js`

Verification:
- cost/token/latency attribution still emitted correctly
- event emission still occurs
- no direct DB writes from gateway path

### Phase 5 — Remove local provider secret ownership
Goal: separate routing metadata from secret/token ownership.

Steps:
1. Split provider selection metadata from secrets.
2. Replace local token resolution with governed runtime credential resolution.
3. Preserve only gateway-local routing data if still needed.
4. Redirect auth/bootstrap flows out of Module 45.

Files primarily affected later:
- `lib/token-store.js`
- `lib/provider-registry.js`
- `lib/copilot-auth.js`

Verification:
- provider routing still works
- secrets are no longer persisted locally by the gateway
- tenant ownership of credentials is explicit and governed

### Phase 6 — Remove CLI/service/project logic
Goal: cut non-gateway concerns after replacement paths are verified.

Steps:
1. Decommission `/api/*` control plane usage.
2. Remove service manager dependencies from app composition.
3. Remove project/workspace introspection from request execution.
4. Retire standalone auth/logout UX endpoints.

Files primarily affected later:
- `lib/app.js`
- `lib/cli.js`
- `bin/llmproxy.js`
- `lib/service-manager.js`
- `lib/service/*`
- `lib/project-context.js`

Verification:
- internal services still use canonical gateway routes
- no product behavior depends on local CLI wrappers
- no request routing depends on hidden workspace inspection

### Phase 7 — Framework shell alignment
Goal: align the module shell to V11 architecture.

Steps:
1. Move the gateway shell from legacy Express-centric composition to a V11-compliant shell.
2. Preserve extracted service/adapters during this move.
3. Keep route contract stable while swapping the hosting layer.

Likely files later:
- `server.js`
- `lib/app.js`
- new route/bootstrap files

Verification:
- same canonical gateway contract
- same tests passing
- no legacy control-plane behavior reintroduced

---

## 6. Verified Deletion Order

Deletion must occur only after equivalent behavior is verified.

### Delete last
- `lib/metering-db.js`
- Mongo dependency path
- `lib/project-context.js`
- `lib/service-manager.js`
- `lib/service/*`
- CLI-over-HTTP route handlers in `lib/app.js`
- `lib/cli.js`
- `bin/llmproxy.js`

### Delete only after replacement verification
- old tenancy parser logic in `lib/platform-context.js`
- local token persistence in `lib/token-store.js`
- secret persistence portions of `lib/provider-registry.js`
- in-gateway metering query/stats endpoints

---

## 7. Proposed Target Folder Direction

Not a final code diff, but the plan should converge toward separation like:

- `src/routes/`
  - gateway HTTP handlers only
- `src/middleware/`
  - auth, tenancy, validation
- `src/services/`
  - LLM proxy orchestration
- `src/adapters/providers/`
  - provider-specific execution/translation
- `src/adapters/integrations/`
  - policy, billing, event-bus, telemetry
- `src/domain/`
  - request/response/usage/health models
- `src/compat/`
  - temporary strangler adapters for legacy routes/contexts

This structure directly supports route-by-route redirection and verified deletions.

---

## 8. Test and Verification Plan

### A. Preserve-and-expand tests first
Existing tests to reuse:
- `tests/app.test.js`
- `tests/app-platform.test.js`
- `tests/copilot-proxy.test.js`
- `tests/openai-translate.test.js`
- `tests/provider-registry.test.js`
- `tests/event-bus.test.js`

### B. Add new tests before each replacement seam
1. canonical gateway routes only
2. tenancy ancestry enforcement
3. RBAC enforcement with V11 roles
4. policy-service enforcement integration
5. billing attribution emission
6. event-bus emission
7. provider fallback and health behavior
8. no direct DB dependency on gateway request path

### C. End-to-end verification
For each strangler phase:
1. old route/behavior still works if intentionally preserved
2. new route/seam produces equivalent transport results
3. attribution and event emission remain intact
4. replaced code path is no longer referenced
5. only then remove legacy path

### D. Required command/test discipline
When implementation begins later:
- use `vitest --run`
- no watch mode
- after code modifications, run:
  - `graphify update .`

---

## 9. Critical Files to Modify in the Refactor

Primary refactor files:
- `lib/app.js`
- `lib/copilot-proxy.js`
- `lib/platform-context.js`
- `lib/provider-registry.js`
- `lib/token-store.js`
- `lib/metering.js`
- `lib/metering-db.js`
- `lib/metering-dblayer.js`
- `lib/event-bus.js`
- `server.js`

Likely removals or migrations:
- `lib/project-context.js`
- `lib/cli.js`
- `bin/llmproxy.js`
- `lib/service-manager.js`
- `lib/service/launchd.js`
- `lib/service/systemd.js`
- `lib/service/docker-launchd-entry.js`

Tests to update/add:
- `tests/app.test.js`
- `tests/app-platform.test.js`
- `tests/provider-registry.test.js`
- `tests/metering.test.js`
- `tests/metering-db.test.js`
- `tests/metering-dblayer.test.js`

---

## 10. Recommended First Implementation Slice

When you want me to start execution, the safest first slice is:

1. **Extract canonical gateway routes from `lib/app.js`**
2. **Fence off legacy `/api/*` routes as compatibility-only**
3. **Introduce a pure transport service seam around current proxy logic**
4. **Add tests that lock the canonical V11 boundary**
5. **Do not delete anything yet**

That gives the strangler trunk something stable to grow around before auth, metering, and secret-management replacement.

---

## 11. Actionable Task Checklist

### Phase 1 — Freeze boundary
1. Add canonical-vs-legacy route inventory docs in plan/work notes.
2. Identify all `lib/app.js` handlers that are true gateway routes.
3. Identify all `lib/app.js` handlers that are compatibility/control-plane routes.
4. Add/adjust tests to explicitly cover only canonical gateway responsibilities.
5. Mark `/api/*`, local auth, service control, and project-introspection paths as legacy in code comments/docs when implementation starts.

### Phase 2 — Extract transport seam
6. Introduce a dedicated gateway transport service interface around current proxy execution.
7. Move canonical route handlers in `lib/app.js` to call that service instead of inline orchestration.
8. Keep `lib/copilot-proxy.js` behind the new seam without rewriting behavior yet.
9. Add regression tests for:
   - non-streaming completion
   - streaming
   - fallback
   - provider/model translation
   - health/models endpoints

### Phase 3 — Auth and tenancy alignment
10. Define the normalized V11 request context contract for Module 45.
11. Add middleware/adapter for standardized auth + hierarchy context extraction.
12. Replace ad hoc role checks with V11 RBAC role checks.
13. Tighten hierarchy validation to match full ancestry rules.
14. Keep old header/body parsing only as a temporary compatibility adapter.
15. Add tests for:
   - valid scope ancestry
   - invalid ancestry
   - missing hierarchy context
   - role-based provider registry permissions

### Phase 4 — Metering replacement
16. Separate “usage/cost attribution generation” from “persistence/query/stats.”
17. Introduce a new attribution sink abstraction.
18. Implement V11-facing integrations for:
   - billing-ledger attribution
   - event-bus / telemetry emission
19. Redirect write path away from JSONL/Mongo/db-layer persistence.
20. Keep old metering read/query endpoints only temporarily if still needed.
21. Add tests for:
   - attribution payload shape
   - billing emission
   - event emission
   - no direct DB write on canonical request path

### Phase 5 — Provider credentials and secret ownership
22. Split provider routing metadata from provider secret storage.
23. Preserve non-secret routing data only if required by proxy behavior.
24. Replace local token/API-key ownership with governed credential resolution.
25. Remove gateway dependence on local token wallet behavior after replacement is verified.
26. Add tests for:
   - provider resolution
   - scoped provider selection
   - secret resolution path
   - no local secret persistence on canonical flow

### Phase 6 — Remove non-gateway logic
27. Redirect consumers away from `/api/*` control-plane routes.
28. Remove CLI-over-HTTP handlers from `lib/app.js`.
29. Remove dependency on `lib/cli.js` and `bin/llmproxy.js`.
30. Remove service lifecycle management from runtime boundary.
31. Remove project/workspace/.claude introspection from execution path.
32. Remove local `/auth/status` and `/auth/logout` behavior if no longer part of approved contract.
33. Add regression tests to prove canonical gateway routes still work after removals.

### Phase 7 — Framework shell alignment
34. Move app composition to a V11-compliant shell.
35. Preserve extracted routes/services/adapters during shell migration.
36. Re-run full canonical route suite and integration suite.
37. Remove obsolete hosting/bootstrap code once parity is confirmed.

---

## 12. File Order

### First files to touch
1. `lib/app.js`
2. `tests/app.test.js`
3. `tests/app-platform.test.js`

### Then extract core transport
4. `lib/copilot-proxy.js`
5. `lib/openai-translate.js`
6. `lib/openai-format.js`

### Then auth/tenancy
7. `lib/platform-context.js`
8. `lib/provider-registry.js`
9. `tests/provider-registry.test.js`

### Then metering/integrations
10. `lib/metering.js`
11. `lib/metering-dblayer.js`
12. `lib/metering-db.js`
13. `lib/event-bus.js`
14. `tests/metering.test.js`
15. `tests/metering-dblayer.test.js`
16. `tests/metering-db.test.js`

### Then secret/token cleanup
17. `lib/token-store.js`
18. `lib/copilot-auth.js`

### Last removals/migrations
19. `lib/project-context.js`
20. `lib/cli.js`
21. `bin/llmproxy.js`
22. `lib/service-manager.js`
23. `lib/service/launchd.js`
24. `lib/service/systemd.js`
25. `lib/service/docker-launchd-entry.js`
26. `server.js`

---

## 13. Test Order

1. Lock current canonical gateway behavior with route tests.
2. Add transport seam regression tests.
3. Add tenancy/RBAC validation tests.
4. Add attribution/event integration tests.
5. Add provider credential resolution tests.
6. Re-run full suite after each strangler redirect.
7. Only delete legacy code after the replacement tests pass.

### Commands for later execution
- `vitest --run`
- after code changes: `graphify update .`

---

## 14. Safe First Execution Slice

If you want the lowest-risk starting point, begin with:

1. refactor `lib/app.js` to separate canonical gateway routes from legacy routes
2. add/adjust tests in `tests/app.test.js` and `tests/app-platform.test.js`
3. introduce a transport service seam without changing behavior
4. stop there and verify before moving to auth or metering
