# Changelog — v8 Platform Tool alignment

This document records the changes introduced to align `llmProxy` with the
v8 modular architecture, where `llmProxy` is **Tool #45 (deterministic
transport)** and not an AI module.

## Summary

`llmProxy` keeps its standalone behaviour (CLI + `/v1/messages` for Claude
Code) and gains a platform-facing surface: canonical manifest, OpenAPI
contract, HierarchyContext / MeteringContext parsing, metering sink hook
and dedicated platform endpoints. No AI logic, prompts or agent
orchestration is added — orchestration remains the responsibility of the
AI Orchestrator module.

## Decisions

- `llmProxy` stays a tool: no `system_prompt/`, no `agents/`, no LLM
  reasoning inside the proxy.
- `/v1/messages` is preserved verbatim for Claude Code compatibility.
- Platform alias `/v1/llm/messages` is **additive** and shares the same
  handler. HierarchyContext is enforced only when `LLMPROXY_MODE=platform`.
- Standalone control plane is the CLI; platform control plane is the API.
  The local server can still receive HTTP requests in standalone mode —
  the distinction is about *configuration and operations*, not transport.
- Filesystem token store stays as the standalone default. A storage
  adapter seam is exposed for a future DB Layer integration.
- Metering uses an injectable `meteringSink`. Default is no-op +
  optional JSONL. Real sinks (Billing & Metering, Event Bus) are wired
  later when those modules exist.
- Persistent install must produce a **server-wide** `llmproxy` binary
  (every user can run the command). Token / runtime data remain
  user-scoped unless `LLMPROXY_HOME` is explicitly shared.

## What changed

### Added

- `manifest.json` — v8 canonical tool manifest (`type: tool`,
  `slug: llm-proxy`, `llm_required: false`, declared dependencies,
  modes, error codes, emitted events).
- `api/v1.openapi.yaml` — OpenAPI 3.0 contract for runtime,
  platform and control-plane endpoints. Documents HierarchyContext /
  MeteringContext / TraceId headers and the stable error code set.
- `lib/platform-context.js` — parses `HierarchyContext` and
  `MeteringContext` from headers or body, resolves trace id, exposes
  `resolveMode()` and `buildHierarchyContextRequiredError()`.
- `lib/metering.js` — builds deterministic metering records,
  ships a no-op sink and a JSONL sink, plus a redaction helper that
  scrubs prompts, content, tokens and credentials before persistence.
- `lib/app.js` — new endpoints:
  - `GET /v1/llm/health` — platform health and capability descriptor.
  - `POST /v1/llm/messages` — platform alias of `/v1/messages` that
    enforces HierarchyContext when `LLMPROXY_MODE=platform`.
- `graphify/README.md` — placeholder satisfying the v8 tool contract.
- `docs/CHANGELOG-v8-platform-tool.md` — this file.
- Tests:
  - `tests/platform-context.test.js`
  - `tests/metering.test.js`
  - `tests/app-platform.test.js` for the platform endpoints and
    HierarchyContext enforcement.

### Changed

- `lib/app.js`
  - Accepts an optional `meteringSink` and an optional `mode` option.
  - Parses HierarchyContext / MeteringContext / trace id on every
    `/v1/messages` and `/v1/llm/messages` request and forwards them to
    the logger.
  - Returns `HIERARCHY_CONTEXT_REQUIRED` (HTTP 400) on
    `/v1/llm/messages` when the proxy is in platform mode and no valid
    HierarchyContext is supplied.
- `lib/cli.js`
  - `install:persistent-*` script keeps installing globally via
    `npm install -g`. Verification step prints the resolved global
    binary path so administrators can confirm it is on a server-wide
    PATH (e.g. `/usr/local/bin`) rather than a per-user prefix.
- README-IT.md / README-EN.md — short architectural note describing
  standalone vs platform modes and pointing at this changelog.

### Not changed (intentionally)

- `/v1/messages` request / response shape.
- CLI commands, flags and exit codes.
- Filesystem token store layout.
- Service manager (`launchd` / `systemd`) behaviour.

## Compatibility

- Claude Code: unchanged. `/v1/messages` continues to work without
  HierarchyContext and without metering context.
- Existing CLI users: unchanged. All commands keep their previous
  behaviour and exit codes.
- Platform consumers: must set `LLMPROXY_MODE=platform` and send
  `X-Hierarchy-Context` (or `hierarchy_context` in the body) when
  calling `/v1/llm/*` endpoints.

---

## Multi-provider support (post-v8)

### Summary

`llmProxy` gained a scoped multi-provider credential registry that
supports both GitHub Copilot OAuth accounts and third-party LLM providers
authenticated via API-key.

### Added

- `lib/provider-registry.js` — AES-256-GCM encrypted, scoped credential
  store keyed as `scope_type:scope_id:provider`. Supports scope priority
  resolution (project > client > agency > user > master).
- `SUPPORTED_PROVIDERS` expanded to include all major API-key LLM providers:
  `openrouter`, `openai`, `anthropic`, `groq`, `deepseek`, `mistral`,
  `xai`, `perplexity`, `together`, `fireworks`, `kimi`, `zai` / `z.ai`.
- CLI `provider:add <id> --api-key <key>` — adds an API-key provider
  directly without launching any OAuth browser flow.
- CLI `provider:key <id> --api-key <key>` — sets or replaces the
  API-key credential for an already-registered provider.
- API `POST /api/providers/{id}/api-key` — HTTP equivalent of the two
  CLI commands above. Body: `{ "api_key": "...", "name": "..." }`.
- Platform registry endpoints `GET/POST/DELETE /v1/llm/providers` —
  manage per-scope provider registry entries for billing attribution.
- `lib/token-store.js` — `normalizeProvider()` now persists
  `provider_type` and `auth_type` metadata fields (backward compatible).
- `lib/copilot-proxy.js` — `buildProviderCandidates()` now filters to
  Copilot OAuth providers only; API-key providers are excluded from the
  Copilot fallback chain.

### Not changed

- Copilot OAuth flow (`provider:add` with no `--api-key` / unknown ids):
  still triggers the device flow as before.
- Existing token store layout and file paths.
- `/v1/messages` response shape.

### Migration notes

- To add an OpenRouter key: `llmproxy provider:add openrouter --api-key sk-or-...`
- To rotate a key: `llmproxy provider:key openrouter --api-key sk-or-new`
- API-key providers are stored encrypted with `LLMPROXY_SECRET` (AES-256-GCM).
  Set a stable secret in `.env` to allow key rotation without data loss.

## Migration notes

1. To run as a platform tool, set `LLMPROXY_MODE=platform` in the
   environment and route platform clients to `/v1/llm/messages`.
2. Provide a metering sink at startup
   (`createApp({ meteringSink })`). Default is a no-op sink; in
   production wire it to the Billing & Metering module or to the
   Event Bus topic `llmproxy.call.completed`.
3. To enable JSONL accounting locally, build the sink with
   `createJsonlMeteringSink({ filePath })` and inject it.
4. When persistent install is required for multiple operators on the
   same server, run the install command with elevated privileges
   so that the resulting `llmproxy` binary lands in a server-wide
   PATH (e.g. `/usr/local/bin`).
