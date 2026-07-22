# llmProxy

`llmProxy` is a standalone package that exposes a GitHub Copilot and multi-provider proxy with an Anthropic-compatible `/v1/messages` endpoint plus a global CLI for setup, provider management, status, logs, persistent service management, and fallback across multiple providers. It is currently optimized for Claude Code workflows.

> **v11 platform mode**: `LLMPROXY_MODE=standalone` is the default and is the recommended path for local checkout, `llmproxy run`, and the persistent user install. `LLMPROXY_MODE=platform` remains available as an explicit compatibility mode for the V11 gateway boundary on `/v1/llm/*`. Background and refactor notes: [docs/V11-REFACTOR-IMPLEMENTATION-PLAN.md](docs/V11-REFACTOR-IMPLEMENTATION-PLAN.md).

## Quick Start

### 0. One-liner install (no clone needed)

The fastest way to install `llmProxy` globally with a persistent native service:

```bash
curl -fsSL https://raw.githubusercontent.com/alessiobacin/llmProxy/main/scripts/install.sh | sh
```

Or with `wget`:

```bash
wget -qO- https://raw.githubusercontent.com/alessiobacin/llmProxy/main/scripts/install.sh | sh
```

The script automatically:

- detects the OS (macOS, Linux, Windows via Git Bash/WSL)
- verifies Node.js 22+, npm, Docker, and Docker Compose
- attempts to auto-install missing dependencies before installing `llmProxy`
- if multiple Node versions are installed, it prefers a detected `node >= 22` binary even when an older `nvm` version is first in `PATH`
- on Linux distributions that expose `nodejs` instead of `node`, it creates a temporary shim so the installer can keep using a consistent `node` command
- if the global npm prefix is system-owned, it automatically retries the package install with `sudo`
- if a writable global install is still not possible, it falls back to a user-local install under `~/.local`
- installs the latest `llmProxy` package directly from the GitHub repository tarball
- registers the native persistent service (launchd / systemd / Windows Service)
- forces a final `llmproxy service:restart` so the Docker-backed runtime is created/recreated and health-checked before the installer exits
- auto-selects English or Italian output based on your locale

> **Next step after install**: configure at least one provider with `llmproxy provider:add <provider>`. Use `copilot` only if you explicitly want GitHub Copilot OAuth.

### 1. Clone the repository (alternative)

If you are starting from scratch, clone the repository locally and enter the project directory:

```bash
git clone https://github.com/alessiobacin/llmProxy.git
cd llmProxy
```

Then install the local checkout dependencies:

```bash
pnpm install
```

If you do not have `pnpm`, install it first:

```bash
npm install -g pnpm
```

### Recommended persistent bootstrap

If you want to install the CLI persistently with a single command, you can explicitly choose between the Italian and English variants.

### Install `llmProxy` in Italian or English

#### Italian variant

Use these commands if you want the installation flow to keep showing messages and explanations in Italian:

```bash
pnpm run install:persistent-it
```

If the CLI is already available in your `PATH` because you installed it globally before, you can also use:

```bash
llmproxy install:persistent-it
```

#### English variant

Use these commands if you want the installation flow to show messages, help, and errors in English:

If you prefer using an English CLI command directly from the local checkout, you can get the same result with:

```bash
node bin/llmproxy.js install
```

If `llmproxy` is already available in your `PATH`, you can use directly:

```bash
llmproxy install
```

`llmproxy install` is an alias for `llmproxy install:persistent-en`.
If you also want the command help in English, use:

```bash
llmproxy help install
```

In short:

- Italian: `pnpm run install:persistent-it` or `llmproxy install:persistent-it`
- English: `pnpm run install:persistent-en`, `node bin/llmproxy.js install:persistent-en`, `node bin/llmproxy.js install`, or `llmproxy install`

Compatibility:

- `pnpm run install:persistent` still points to the Italian path
- `llmproxy install:persistent` still works as a legacy alias for the Italian path

The bootstrap flow:

- automatically detects the supported OS (`macOS`, `Linux`, or `Windows`)
- verifies the required prerequisites before the global install starts
- prints OS-specific remediation commands when `npm`, `systemd`, Docker, or Docker Compose are missing
- installs the current CLI globally from the repository package
- removes any duplicate global wrappers
- launches `llmproxy service:start` through the newly installed global binary
- forces the persistent service defaults to `LLMPROXY_MODE=standalone` and `LLMPROXY_SERVICE_RUNTIME=native` during bootstrap

This way the persistent service always points to the final global installation starting from the local repository checkout.
For Docker-backed profiles, the installer accepts both `docker compose` and the legacy `docker-compose` binary.

### Windows support

On Windows, the persistent installation works the same way but uses **Windows Service Control Manager (`sc.exe`)** instead of systemd or launchd:

- **Prerequisites**: Node.js 22+ LTS (via [nodejs.org](https://nodejs.org)), npm, PowerShell 5.1+
- The CLI is installed globally via `npm install -g <github-tarball>` (no `sudo` needed)
- The service is registered as a native **Windows Service** with automatic start and auto-restart on crash
- Logs are written to `%APPDATA%\llmProxy\logs\`
- The service runs under the `SYSTEM` account (via the wrapper batch file) and persists across reboots

> **Note**: Run PowerShell as **Administrator** if you encounter permission issues during `npm install -g <github-tarball>`. On modern Windows (10+), standard user installs often work without elevation.

### 2. Verify runtime setup

```bash
llmproxy setup
```

Shows:

- the package data root
- the native service manager selected for the OS

### 3. Add a provider

If you want GitHub Copilot via device flow:

```bash
llmproxy provider:add copilot
```

The CLI:

1. requests a device code from GitHub
2. prints the authorization URL and code
3. waits for login completion
4. stores the provider locally

If you want an API-key provider instead, no `/login` is required:

```bash
llmproxy provider:add openrouter --api-key "$OPENROUTER_API_KEY" --model openai/gpt-4o --vision true
```

### 4. Start in foreground

```bash
llmproxy run
```

By default the server starts on:

```text
http://127.0.0.1:7045
```

To stop only the local/dev foreground instance on `5045` from another shell:

```bash
llmproxy stop
```

### 5. Add additional providers and fallback order

```bash
llmproxy provider:available
llmproxy provider:add copilot --name "Copilot Primary"
llmproxy provider:add kimi --api-key "$KIMI_API_KEY" --model kimi-k2.5 --vision false
llmproxy provider:list
llmproxy provider:status
llmproxy provider:order kimi 2
llmproxy provider:rename kimi "Kimi Fallback"
```

### 6. Proxy Registry (Rotazione Proxy)

Puoi registrare proxy URL per usarli in rotazione quando `--proxy` viene passato senza valore:

```bash
# Aggiungi un proxy
llmproxy proxy:add http://user:pass@proxy.esempio.com:10001

# Elenca proxy registrati
llmproxy proxy:list

# Testa tutti i proxy
llmproxy proxy:test

# Riordina proxy (primo = prioritario in failover)
llmproxy proxy:reorder proxy-a.com proxy-b.com

# Rimuovi un proxy
llmproxy proxy:remove proxy-a.com
```

**Usare la rotazione in un provider:**

```bash
# --proxy senza valore = rotazione automatica su tutti i proxy registrati
llmproxy provider:add opencode --name "bacin2" --api-key "<key>" --model deepseek-v4-flash-free --vision false --proxy --free-model
```

Il provider ruoterà in failover sequenziale: prova il primo proxy, se fallisce passa al successivo.

**Compatibilità:** `--proxy <url>` con valore esplicito continua a funzionare come prima (proxy specifico sul provider).

```bash
# --proxy con URL = proxy specifico (comportamento esistente)
llmproxy provider:add opencode --name "bacin2" --api-key "<key>" --model deepseek-v4-flash-free --proxy "http://user:pass@host:7064" --vision false --free-model
```

Per testare tutti i provider attraverso tutti i proxy registrati:

```bash
llmproxy provider:test --all-proxies
```

### 7. Install as a persistent service

```bash
llmproxy service:start
```

Or, if you want global installation plus service activation in one step:

```bash
pnpm run install:persistent-it
```

For the same flow in English:

```bash
pnpm run install:persistent-en
```

On macOS this creates and loads a user `LaunchAgent`.
On Linux this creates and enables a `systemd --user` service.

### 8. Configure Claude Code with the desired model

```bash
llmproxy models:list
llmproxy claude:setup --model 2
```

### 9. Service status and logs

```bash
llmproxy status
llmproxy test
llmproxy test -i
llmproxy test --all-providers
llmproxy test -i --all-providers
llmproxy stats
llmproxy logs
llmproxy logs --follow
llmproxy help
llmproxy version
```

## Configure Claude Code

If you want to use `llmProxy` as the backend for Claude Code, you need to point Claude to the local proxy instead of the direct Anthropic endpoint.

In the project where you want to use Claude Code, you can automatically configure `.claude/settings.json` by running:

```bash
llmproxy models:list
llmproxy claude:setup --model 2
```

The command creates or updates `.claude/settings.json` in the current folder by merging the `env` section with values compatible with `llmProxy`.
`ANTHROPIC_AUTH_TOKEN` is handled automatically and is written only to the global Claude settings in `~/.claude/settings.json`, so you do not need to add it manually to the project file.
The `--model` option accepts the numeric index from `llmproxy models:list`.
When you are authenticated, `llmproxy models:list` reads the live catalog from GitHub Copilot and stores it in the local cache, so the index reflects the models actually available for your account.

If you prefer manual configuration, set both the top-level `model` field and the `env` section consistently:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "LLMPROXY_SHORT_ANSWER": "1"
  }
}
```

### Optional concise answers with `shortAnswer`

### `LLMPROXY_REORDERING`

Service-scoped variable (read from the running proxy's own environment, not per-project `.claude/settings.json`).

Supported values: an ordered, `-`-separated list of criteria, most important first. Valid tokens: `price`, `power`, `speed`. Any subset is allowed (e.g. just `price`).

Related variable:

- `LLMPROXY_REORDERING_MINUTES=<n>` — how often the reordering cycle runs (default `5` when `LLMPROXY_REORDERING` is set)

What it does:

- every `LLMPROXY_REORDERING_MINUTES` minutes, ranks all registered providers using live data and persists the result as the new provider fallback order
- `price`: real cost from the CloudPrice pricing API (`free_model=true` providers count as cost `0`)
- `power`: real `coding_index` benchmark score from the CloudPrice benchmarks API
- `speed`: real inference-latency probe (a minimal `max_tokens: 1` request to each provider)
- providers missing data for a given criterion rank last on that criterion only — ranking still proceeds using the remaining criteria
- the persisted order is the single source of truth: it's what `llmproxy provider:list` shows, what `/v1/messages` fallback uses, and what a manual `llmproxy provider:order` sets until the next automatic cycle

Important:

- if `LLMPROXY_REORDERING` is unset or empty, no automatic reordering happens — the order stays whatever was last set manually
- run `llmproxy provider:reorder` to force an immediate cycle without waiting for the timer

### Example service `.env`

```
LLMPROXY_REORDERING=price-speed-power
LLMPROXY_REORDERING_MINUTES=5
```

In this configuration, every 5 minutes the proxy re-ranks providers: cheapest (free) first; among equal-cost providers, fastest measured latency next; among equal-cost-and-speed providers, highest coding benchmark score last.

If you want to reduce completion length and save output tokens, you can enable a concise-answer mode.

Project-level default in `.claude/settings.json`:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "LLMPROXY_SHORT_ANSWER": "1"
  }
}
```

Per-request override on `/v1/messages`:

```json
{
  "model": "claude-sonnet-4-5",
  "shortAnswer": true,
  "stream": false,
  "max_tokens": 128,
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "Summarize this diff" }]
    }
  ]
}
```

Notes:

- `LLMPROXY_SHORT_ANSWER=1` makes concise answers the project default when Claude uses the local proxy.
- If `LLMPROXY_SHORT_ANSWER` is unset, the default is off.
- `shortAnswer: true` enables it for one request only.
- `shortAnswer: false` disables it for one request even if the project default is enabled.
- llmProxy always injects a short execution-status instruction so each reply starts with a brief progress hint and ends by explicitly saying whether the task is completed.

### Provider-targeted model preferences and fallback chain

You can route different models to different providers directly from `ANTHROPIC_DEFAULT_MODEL` using a comma-separated list. Two syntaxes are supported:

**Provider:model** (colon separator) — specify model per provider:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "ANTHROPIC_DEFAULT_MODEL": "copilot:gpt-5.4,kimi:kimi-k2.5",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  },
  "model": "llmProxy"
}
```

**provider#model** (hash separator) — force a specific provider as first in the list:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7045",
    "ANTHROPIC_DEFAULT_MODEL": "openrouter#deepseek-v4-flash"
  }
}
```

The `#` separator avoids ambiguity with model names containing `/` (e.g. `tencent/hy3:free`). When you use `provider#model`:

- The **specified provider** is moved to the **top of the effective provider list** — it becomes the first fallback candidate.
- `llmproxy provider:list` shows `(override: provider#model)` and the provider appears first in the displayed chain.
- The remaining providers follow in their configured order (or reordering order if `LLMPROXY_REORDERING` is active).
- This is ideal when you want a specific provider (e.g. `openrouter`) to always be tried first for a project, without changing the global provider order.

How it works:

- `copilot:gpt-5.4,kimi:kimi-k2.5` means: use `gpt-5.4` when the active provider is Copilot, and use `kimi-k2.5` when the request falls back to Kimi.
- Precedence is explicit: project override from `.claude/settings.json` `ANTHROPIC_DEFAULT_MODEL` > provider/model chain explicitly sent in the request > provider `default_model` and user fallback order.
- If the chain is partial, llmProxy appends the remaining configured providers in the user's current order and uses each provider's `default_model`.
- Inside a project with `ANTHROPIC_DEFAULT_MODEL`, `llmproxy provider:list` shows the effective execution chain in the real order used by fallback.
- On retryable failures (for example `401`, `408`, `429`, many `5xx`, network errors, or invalid model errors), `llmProxy` moves to the next provider.
- `model` can be a UI label such as `llmProxy`; routing logic is driven by `ANTHROPIC_DEFAULT_MODEL` and provider defaults.

Example setup flow:

```bash
llmproxy provider:add default --name "Default GitHub Copilot" --model "gpt-5.4"
llmproxy provider:add kimi --provider kimi --api-key "$KIMI_API_KEY" --model "kimi-k2.5"
llmproxy provider:order default 1
llmproxy provider:order kimi 2
llmproxy provider:order qwen 3
llmproxy provider:list
```

### Meaning of the variables

- `model`
  This is mainly the label Claude Code shows in the UI/session. You can keep it as `llmProxy`.

- `ANTHROPIC_BASE_URL`
  It must point to the `llmProxy` service. The default for this package is `http://127.0.0.1:5045`.
- `ANTHROPIC_DEFAULT_MODEL`
  Optional. Use it only when you want project-local routing overrides such as a single model or a provider chain like `copilot:gpt-5.4,kimi:kimi-k2.5`.
- `API_TIMEOUT_MS`
  You can keep a high timeout if you want to avoid premature timeouts on long tasks.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  Useful if you want more predictable behavior in Claude Code.
- `LLMPROXY_SHORT_ANSWER`
  Optional. Default: disabled when unset. Set it to `1`, `true`, `yes`, or `on` to ask llmProxy to inject a concise-answer instruction on every proxied inference for that project.

### Differences from other local configurations

If you were already using another local proxy or a previous Claude Code configuration, here are the important differences:

- `ANTHROPIC_BASE_URL` must point to the `llmProxy` service
- `model` can be a stable UI label (`llmProxy`) and does not need to match the routing chain
- `ANTHROPIC_DEFAULT_MODEL` is optional and should be set only if you want project-local routing overrides
- PM2 is not needed: the persistent service is managed by the native service manager (`launchd` or `systemd --user`)

If `ANTHROPIC_DEFAULT_MODEL` is empty or omitted:

- `llmProxy` does not derive a provider chain from `model: llmProxy`.
- Routing falls back to request model and/or provider `default_model` values (if configured with `provider:add ... --model ...`).
- If neither is available, Copilot path falls back to the internal default mapped model.

Minimal example:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045"
  }
}
```

Project-local override example:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "ANTHROPIC_DEFAULT_MODEL": "claude-sonnet-4.5"
  }
}
```

### Recommended sequence

1. install or start `llmProxy`
2. run `llmproxy provider:add copilot`
3. run `llmproxy service:start` or `llmproxy run`
4. run `llmproxy models:list`
5. run `llmproxy claude:setup --model <index>` in the project where you want to use Claude Code
6. reopen Claude Code or restart the tool session

## HTTP Endpoints

In addition to the core endpoints (`/health`, `/auth/status`, `/auth/logout`, `/v1/messages`), `llmProxy` also exposes REST endpoints for runtime CLI commands.

### Billing attribution context for `/v1/llm/*`

For platform-facing endpoints (`/v1/llm/messages`, `/v1/llm/chat/completions`) the caller must provide a hierarchy context for chargeback attribution.

Always required in `X-Hierarchy-Context`:

- `master_company`
- `project_id`
- `scope_type`
- `scope_id`

Optional, depending on the billing hierarchy:

- `tenant_id` — present when the masterCompany provides the SaaS platform to a tenant
- `client_id` — present when the project belongs to a client (of the masterCompany or of a tenant)

Optional user identity fields (per org level):

- `user_id` — generic identifier for the end-user within the current scope (backward-compatible alias)
- `master_user_id` — user ID within the masterCompany identity system
- `tenant_user_id` — user ID within the tenant identity system
- `client_user_id` — user ID within the client identity system
- `project_user_id` — user ID within the project identity system

All `*_user_id` fields are optional and independent of each other. They are emitted as-is in metering records for chargeback attribution at the user level.

Valid combinations:

| Scenario | Required fields |
|---|---|
| MC direct project | `master_company` + `project_id` |
| Tenant project | `master_company` + `tenant_id` + `project_id` |
| MC → direct client | `master_company` + `client_id` + `project_id` |
| Full chain | `master_company` + `tenant_id` + `client_id` + `project_id` |

Example (full chain with per-level user IDs):

```http
X-Hierarchy-Context: {"scope_type":"project","scope_id":"p-1","master_company":"mc-1","tenant_id":"t-1","client_id":"c-1","project_id":"p-1","master_user_id":"u-mc","tenant_user_id":"u-tenant","client_user_id":"u-client","project_user_id":"u-project"}
```

Example (MC direct client, no tenant, with user identity):

```http
X-Hierarchy-Context: {"scope_type":"project","scope_id":"p-1","master_company":"mc-1","client_id":"c-1","project_id":"p-1","master_user_id":"u-mc","project_user_id":"u-project"}
```

Optional metering dimensions can be sent via `X-Metering-Context` under `custom_dimensions` and are emitted in metering records:

```http
X-Metering-Context: {"caller_module":"orchestrator-v10","operation_id":"op-777","cost_accounting_required":true,"custom_dimensions":{"workflow":"content-generation"}}
```

Standard response format for runtime REST endpoints:

```json
{
  "success": true,
  "exitCode": 0,
  "command": "status",
  "data": {
    "output": "...",
    "error": "..."
  },
  "timestamp": "2026-04-24T12:00:00.000Z"
}
```

`success=true` means `exitCode=0`. For application-level command failures, the API returns `400` with `success=false`.

### Metering query API (platform mode)

When the proxy runs in platform mode (`LLMPROXY_MODE=platform`), every proxied request is appended as a JSON line to the metering sink file. Two HTTP endpoints let you query that data without having to parse the file directly.

#### `GET /v1/llm/metering` — paginated record list

Returns raw metering records. Each record is an audit-ready snapshot of a single inference request:

| Field | Description |
|---|---|
| `timestamp` | UTC ISO 8601, when the response was sent |
| `request_id` | Proxy-generated unique ID (`req_<16 hex chars>`) |
| `trace_id` | Caller-supplied `X-Trace-Id`, for correlation |
| `provider` / `model_used` | What actually served the request |
| `duration_ms` | Wall-clock latency from receipt to response |
| `success` / `error_code` | Outcome |
| `tokens_input` / `tokens_output` | Token counts |
| `fallback_count` | How many providers were tried before success |
| `master_company` / `tenant_id` / `client_id` / `project_id` | Billing hierarchy |
| `scope_type` / `scope_id` | Current billing scope |
| `master_user_id` / `tenant_user_id` / `client_user_id` / `project_user_id` | Per-level end-user IDs |
| `caller_module` / `operation_id` / `custom_dimensions` | Metering context dimensions |
| `agent` / `mansione` / `task_id` | Agent-level dimensions (from `custom_dimensions`) |

**Query parameters** (all optional):

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer 1–1000 | Records per page (default `100`) |
| `offset` | integer ≥ 0 | Skip N records (default `0`) |
| `order` | `desc` \| `asc` | Newest first (default) or oldest first |
| `from` | ISO 8601 | Filter: `timestamp >= from` |
| `to` | ISO 8601 | Filter: `timestamp <= to` |
| `success` | `true` \| `false` | Filter by outcome |
| `project_id` | string | Exact-match filter |
| `tenant_id` | string | Exact-match filter |
| `client_id` | string | Exact-match filter |
| `master_company` | string | Exact-match filter |
| `scope_type` | string | Exact-match filter |
| `scope_id` | string | Exact-match filter |
| `provider` | string | Exact-match filter |
| `master_user_id` / `tenant_user_id` / `client_user_id` / `project_user_id` / `user_id` | string | Exact-match per-level user filter |
| `request_id` | string | Look up a single specific request |

**Example — last 20 requests for a project:**

```http
GET /v1/llm/metering?project_id=p-1&limit=20&order=desc
```

**Example — failed requests in a time window:**

```http
GET /v1/llm/metering?success=false&from=2026-05-01T00:00:00Z&to=2026-05-01T23:59:59Z
```

**Response shape:**

```json
{
  "records": [ /* array of MeteringRecord */ ],
  "total": 142,
  "limit": 20,
  "offset": 0,
  "order": "desc"
}
```

`total` is the count of all records matching the filters (not just the current page). Use `offset` for pagination:

```
page 1: offset=0,  limit=20  → records 0–19
page 2: offset=20, limit=20  → records 20–39
```

#### `GET /v1/llm/metering/stats` — aggregate statistics

Accepts the same filter parameters as the list endpoint (pagination params are ignored). Returns aggregate statistics over the entire filtered record set:

**Example — cost summary for a project, current month:**

```http
GET /v1/llm/metering/stats?project_id=p-1&from=2026-05-01T00:00:00Z
```

**Response shape:**

```json
{
  "filtered_total": 1284,
  "total_requests": 1284,
  "success_count": 1279,
  "error_count": 5,
  "total_tokens_input": 4820000,
  "total_tokens_output": 612000,
  "total_tokens": 5432000,
  "avg_tokens_input": 3754,
  "avg_tokens_output": 477,
  "avg_duration_ms": 1823,
  "p50_duration_ms": 1640,
  "p95_duration_ms": 4210,
  "earliest_timestamp": "2026-05-01T08:12:43.000Z",
  "latest_timestamp": "2026-05-04T17:58:02.000Z",
  "by_provider": {
    "copilot": { "requests": 1001, "tokens_input": 3800000, "tokens_output": 490000 },
    "openai":  { "requests":  283, "tokens_input": 1020000, "tokens_output": 122000 }
  },
  "by_scope_type": {
    "project": { "requests": 1284, "tokens_input": 4820000, "tokens_output": 612000 }
  },
  "by_project_id": {
    "p-1": { "requests": 1284, "tokens_input": 4820000, "tokens_output": 612000 }
  }
}
```

**Notes:**
- Both endpoints return `404` if the proxy is not in platform mode.
- The JSONL file is read on every HTTP request — no in-memory cache is maintained.
- Records are appended in chronological order; `order=desc` reverses the slice after filtering.
- Fields are redacted of sensitive content (message bodies, API keys) before being written to disk, so the stored records do not contain prompt text.

### Health

```http
GET /health
```

Example response:

```json
{
  "ok": true,
  "authenticated": true
}
```

### Local auth status

```http
GET /auth/status
```

### Local logout

```http
POST /auth/logout
```

### Runtime API (CLI via REST)

The CLI progressively uses this REST control plane as its primary path when the local service is reachable. Bootstrap commands that may run before the service exists (`run`, `service:start`, install flows) keep a local fallback.

```http
GET  /api/version
GET  /api/help
GET  /api/help?command=status
GET  /api/setup
GET  /api/release-notes

POST /api/auth/login
POST /api/auth/logout

GET  /api/service/status
POST /api/service/start
POST /api/service/stop
POST /api/service/restart

GET  /api/logs
GET  /api/logs/stream
GET  /api/models
POST /api/model/set
POST /api/test
POST /api/claude/setup

GET    /api/providers
GET    /api/providers/status
POST   /api/providers/{id}/login
POST   /api/providers/{id}/api-key
POST   /api/providers/order
POST   /api/providers/{id}/rename
DELETE /api/providers/{id}

GET    /api/stats

GET    /api/config
GET    /api/config/{key}
POST   /api/config/{key}
DELETE /api/config/{key}

POST   /api/update
POST   /api/uninstall
```

Operational notes:

- `GET /api/logs` is a snapshot (static tail).
- `GET /api/logs/stream` is live streaming via Server-Sent Events (SSE).
- optional `intervalMs` query on `/api/logs/stream` (minimum 200ms).
- `POST /api/claude/setup` accepts JSON body:

```json
{
  "projectPath": "/absolute/project/path",
  "model": "2"
}
```

- `POST /api/providers/order` accepts:

```json
{
  "id": "backup",
  "position": 1
}
```

- `POST /api/providers/{id}/rename` accepts:

```json
{
  "name": "Backup EU"
}
```

- `POST /api/providers/{id}/api-key` sets an API-key credential for a known provider (non-Copilot):

```json
{
  "api_key": "sk-...",
  "name": "My OpenRouter key"
}
```

### Anthropic-compatible proxy

```http
POST /v1/messages
```

Minimal example body:

```json
{
  "model": "claude-sonnet-4-5",
  "shortAnswer": true,
  "stream": false,
  "max_tokens": 128,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Hello"
        }
      ]
    }
  ]
}
```

To improve logging for the calling project, add this header when possible:

```http
x-project-path: /absolute/path/to/project
```

### CLI -> REST mapping (runtime)

| CLI | REST |
| --- | --- |
| `llmproxy version` | `GET /api/version` |
| `llmproxy help [cmd]` | `GET /api/help[?command=cmd]` |
| `llmproxy setup` | `GET /api/setup` |
| `llmproxy release-notes [--version <v>]` | `GET /api/release-notes` |
| `llmproxy login` | `POST /api/auth/login` (legacy compatibility alias; prefer `llmproxy provider:add copilot`) |
| `llmproxy logout` | `POST /api/auth/logout` |
| `llmproxy status` | `GET /api/service/status` |
| `llmproxy service:start` | `POST /api/service/start` |
| `llmproxy service:stop` | `POST /api/service/stop` |
| `llmproxy service:restart` | `POST /api/service/restart` |
| `llmproxy logs` | `GET /api/logs` |
| `llmproxy logs --follow` | `GET /api/logs/stream` |
| `llmproxy models:list` | `GET /api/models` |
| `llmproxy model:set <model>` | `POST /api/model/set` |
| `llmproxy test` | `POST /api/test` |
| `llmproxy claude:setup --model <n>` | `POST /api/claude/setup` |
| `llmproxy pi:setup` | `POST /api/pi/setup` |
| `llmproxy provider:list` | `GET /api/providers` |
| `llmproxy provider:status` | `GET /api/providers/status` |
| `llmproxy provider:add <id> [--name <n>] [--vision <t|f>]` | `POST /api/providers/{id}/login` |
| `llmproxy provider:add <id> --api-key <key> --vision <t|f>` | `POST /api/providers/{id}/api-key` |
| `llmproxy provider:key <id> --api-key <key> [--vision <t|f>]` | `POST /api/providers/{id}/api-key` |
| `llmproxy provider:order <id> <position>` | `POST /api/providers/order` |
| `llmproxy provider:reorder` | `POST /api/providers/reorder` |
| `llmproxy provider:rename <id> <name>` | `POST /api/providers/{id}/rename` |
| `llmproxy provider:remove <id>` | `DELETE /api/providers/{id}` |
| `llmproxy stats` | `GET /api/stats` |
| `llmproxy config:list [--scope <project\|global\|service>]` | `GET /api/config` |
| `llmproxy config:get <key> [--scope <project\|global\|service>]` | `GET /api/config/{key}` |
| `llmproxy config:set <key> <value> [--scope <project\|global\|service>]` | `POST /api/config/{key}` |
| `llmproxy config:unset <key> [--scope <project\|global\|service>]` | `DELETE /api/config/{key}` |
| `llmproxy update` | `POST /api/update` |
| `llmproxy uninstall` | `POST /api/uninstall` |

## CLI Commands

### `llmproxy setup`

Prepares runtime directories and shows the selected service manager.

### `llmproxy run`

Starts the local/dev proxy in the foreground on `127.0.0.1:5045`.
It loads runtime variables from the local package `.env` in development and falls back to the built-in defaults when a variable is missing.

### `llmproxy stop`

Stops only the local/dev foreground instance on `127.0.0.1:5045`. It does not stop the persistent service runtime.

### `llmproxy status`

Shows:

- detected service manager
- service status
- whether a Copilot token is present
- active provider
- configured fallback order

### `llmproxy models:list`

Shows the numbered list of models you can use with `llmproxy claude:setup --model <index>`.

If you are authenticated, the command queries the live catalog `https://api.githubcopilot.com/models` and stores the result in the local cache.
If the live catalog is unavailable, it uses the local cache or the static fallback included in the project.

### `llmproxy test`

Supports two different modes.

Default mode: provider probe

- `llmproxy test` probes only the active provider and prints one compact line: `ok` or `fail`
- `llmproxy test --all-providers` probes every configured provider in order and prints one line per provider
- this mode is meant for operator checks and never prints the assistant body

Inference mode: real fallback execution

- `llmproxy test -i` runs one real inference through the normal fallback chain and prints the provider/model that actually answered
- `llmproxy test -i --all-providers` still runs one real inference, then validates every remaining configured fallback after the winner

The inference test sends this fixed prompt:

```text
Rispondi solo: llmproxy-test-inference
```

Examples:

```text
inference: ok (kimi | kimi-k2.7-code)
response: llmproxy-test-inference
```

```text
inference: ok (kimi | kimi-k2.7-code)
1st fallback: openrouter | minimax-m3
2nd fallback: qwen | qwen3.7-plus
3rd fallback: opencode | deepseek-v4-flash-free
response: llmproxy-test-inference
```

Notes:

- failed providers before the real winner are not shown as fallback entries in `-i --all-providers`
- remaining configured providers after the winner are re-tested one by one; only working providers are numbered as `1st fallback`, `2nd fallback`, ...
- broken remaining providers are printed as `invalid fallback: ...` and make the command exit with failure
- llmProxy inline metadata lines are stripped from the printed `response:`
- if the provider returns only llmProxy metadata and the request succeeded, the test still reports `inference: ok` and omits the `response:` line
- use this command to verify the real runtime fallback order seen by an actual inference, not just individual provider reachability

### `llmproxy stats`

Shows aggregate token usage grouped by provider and model.

Depending on the runtime mode, the command reads statistics from:

- the configured db-layer sink, when available
- the local JSONL metering fallback, when db-layer is unavailable
- the standalone local metering file, when running outside platform mode

Use it when you want a quick operator view of:

- total requests, successes, and failures
- input/output/total tokens
- per-provider usage
- per-model usage

### `llmproxy provider:add <id> [--name <name>] [--api-key <key>] [--model <model>] [--vision <true|false>] [--plan <plan>]`

Adds a provider identified by `<id>`. Behaviour depends on the provider type:

- **Copilot OAuth providers** (unknown ids or `copilot`): starts the GitHub Copilot device flow.
- **API-key providers** (e.g. `openrouter`, `groq`, `anthropic`, `openai`, `deepseek`, `mistral`, `xai`, `perplexity`, `together`, `fireworks`, `kimi`, `zai`): stores the supplied `--api-key` directly without any browser flow. Requires `--vision <true|false>` to indicate whether the model supports image input.

The `--vision` flag is **mandatory** for API-key providers. When a request contains images, providers with `vision: false` are automatically skipped during fallback.

Known API-key providers:

| id | Service |
|---|---|
| `openrouter` | OpenRouter |
| `qwen` | Qwen |
| `openai` | OpenAI |
| `anthropic` | Anthropic |
| `groq` | Groq |
| `deepseek` | DeepSeek |
| `mistral` | Mistral AI |
| `xai` | xAI / Grok |
| `perplexity` | Perplexity AI |
| `together` | Together AI |
| `fireworks` | Fireworks AI |
| `kimi` | Kimi (Moonshot) |
| `zai` / `z.ai` | Z.ai |

`qwen` note: `llmproxy` automatically uses the Token Plan OpenAI-compatible endpoint for `sk-sp-...` keys and keeps using `dashscope-intl` for standard pay-as-you-go keys. If you want to force the choice during setup, use `--plan subscription` or `--plan payg`.

Example:

```bash
llmproxy provider:add openrouter --api-key sk-or-... --model claude-sonnet-4 --vision true
llmproxy provider:add groq --api-key gsk_... --model llama-3.3-70b-versatile --vision false
llmproxy provider:add qwen --api-key sk-sp-... --model qwen3.7-plus --vision true --plan subscription
llmproxy provider:add qwen --api-key sk-qwen-... --model qwen3.7-max --vision false --plan payg
llmproxy provider:add deepseek --api-key sk-... --model deepseek-v4-pro --vision false
llmproxy provider:add kimi --api-key sk-... --model kimi-k2.6 --vision true
```

### `llmproxy provider:available`

Shows the providers supported by the CLI before you configure them.

Use it to confirm:

- the canonical provider id to pass to `provider:add`
- the display name shown by llmProxy
- which providers use OAuth vs API-key authentication

### `llmproxy provider:key <id> --api-key <key> [--model <model>] [--vision <true|false>] [--plan <plan>]`

Sets or replaces the API-key credential for an existing API-key provider without going through the OAuth flow. Equivalent to `provider:add <id> --api-key <key>` when the provider is already registered. The `--vision` flag is optional; if omitted, the existing vision setting is preserved.

```bash
llmproxy provider:key openrouter --api-key sk-or-new-key --vision true
llmproxy provider:key qwen --api-key sk-sp-... --vision true --plan subscription
```

### `llmproxy provider:list`

Shows the current fallback order of configured providers. For each provider:

- the selected model is shown as `model=...`
- the coding benchmark score is shown as `coding=...`
- the vision capability is shown on a new line as `vision=true` or `vision=false`
- for `qwen`, the saved plan is shown as `plan=subscription` or `plan=payg`
- the residual credit is shown as `credit=...` when the provider exposes a balance endpoint (or inline if `LLMPROXY_PROVIDER_CREDIT_INLINE=1` is set in the service config)
- if the provider does not expose a readable balance endpoint, or the current key cannot read it, the suffix is `credit=n/a` or `credit=unavailable`
- the current provider price is shown as `price=...`
- the cheapest alternative discovered through the CloudPrice pricing API is shown as `best=... (...)`
- the live speed probe (latency) is shown as `bench=...ms` or `bench=errore <code>` if the probe fails (e.g., `bench=errore 429`)

Pricing notes:

- the price comparison uses the public CloudPrice model pricing API: `GET /models/{id}/pricing/calculate`
- the comparison is normalized on `tier=standard`, `input_tokens=1000000`, `output_tokens=1000000`
- this makes the numbers directly comparable across providers for the same model
- the rendered label shows both token dimensions explicitly: `in=...` and `out=...`
- if CloudPrice cannot resolve the current provider/model pair, the command prints `price=n/a` or `price=unavailable`

### `llmproxy provider:reorder`

Forces an immediate automatic reordering cycle (price/power/speed, per `LLMPROXY_REORDERING`) without waiting for the timer. Prints the criteria used, the resulting order, and the raw score for each provider. Does nothing (and says so) if `LLMPROXY_REORDERING` is unset.

### `llmproxy provider:rename <id> <name>`

Updates a provider display name without changing its identifier.

### `llmproxy provider:remove <id>`

Removes the specified provider from the local registry.

### `llmproxy logs`

Shows the static tail of service stdout/stderr logs and of the latest JSONL audit log, if available.

### `llmproxy logs --follow`

Follows logs in real time using the native service files.

### `llmproxy service:start`

Installs and starts the native persistent service.
When the installed profile is Docker-backed, it also validates the runtime container and supports both `docker compose` and legacy `docker-compose`.

On macOS the service restarts after reboot when the user session is loaded.
It is not a global system daemon: it runs in the user context.

### `llmproxy service:stop`

Stops the native persistent service.

### `llmproxy help`

Shows a descriptive guide to the available commands, including:

- what each command does
- when to use it
- the recommended flow for first setup, persistent service, fallback providers, and updates
- a troubleshooting section for common issues

It also supports `llmproxy help <command>` to show a more detailed card for a single command.
The single-command card includes syntax, description, when to use it, and a practical example.

### `llmproxy service:restart`

Restarts the persistent service and also validates the Docker runtime when the installed profile is Docker-backed. If the managed `llmproxy` container is missing or stopped, the command also recreates it with `docker compose up -d` or legacy `docker-compose up -d` (and `--build` when required by the wrapper) before the final health check.

### `llmproxy service:runtime`

Explicit runtime switch command:

- `llmproxy service:runtime docker`
  Removes the native persistent service artifacts, stops/removes the managed Docker runtime if present, recreates the `llmproxy` container, persists `LLMPROXY_SERVICE_RUNTIME=docker`, and verifies `/health`.
- `llmproxy service:runtime launchd`
  macOS-only alias for the native runtime. Stops/removes the managed Docker runtime, installs the user `LaunchAgent`, persists `LLMPROXY_SERVICE_RUNTIME=native`, and verifies `/health`.
- `llmproxy service:runtime native`
  Cross-platform native selector (`launchd` on macOS, `systemd --user` on Linux, Windows Service on Windows).
- `llmproxy service:runtime systemd`
  Linux-only alias for the native runtime.

Practical examples:

```bash
llmproxy service:runtime docker
llmproxy service:runtime launchd
```

### `llmproxy claude:setup`

Creates or updates `.claude/settings.json` in the current folder with the `env` variables required to use `llmProxy` as the local backend for Claude Code.

As part of the setup, llmProxy also synchronizes a small global Claude support entry in `~/.claude/settings.json` for the local auth placeholder used by Claude itself. This is not the project configuration and does not replace the `.claude/settings.json` created in the current folder.

Supports `--model <index>` to show the selected default model in CLI output while keeping `.claude/settings.json` minimal (`model: llmProxy` plus proxy base URL).

### `llmproxy pi:setup` (alias `llmp pi:s`)

Creates `.pi/models.json` and `.pi/settings.json` in the current folder to configure PI Agent to use llmProxy as its provider.

```bash
llmproxy pi:setup
```

Generates two files:

**`.pi/models.json`** — defines the `llmproxy` provider with `anthropic-messages` type, local baseUrl and `proxy-local` apiKey.

**`.pi/settings.json`** — sets `defaultProvider: "llmproxy"` and `defaultModel: "llmproxy"`.

The command writes project-level files only, never touching `~/.pi/` global configurations.

### `llmproxy config:list|get|set|unset`

These commands expose the full supported configuration surface both from CLI and REST.

- `--scope project` writes project variables into the current folder's `.claude/settings.json`, such as `ANTHROPIC_DEFAULT_MODEL`, `LLMPROXY_PRICE_PERFORMANCE_ROUTING`, and `LLMPROXY_SHORT_ANSWER`.
- `--scope global` writes project-scope defaults into `~/.claude/settings.json`, so they become user-level fallbacks for every Claude project on the same machine.
- `--scope service` writes service variables into the persistent llmProxy runtime config, such as `PORT`, `LLMPROXY_MODE`, and `LLMPROXY_SECRET`.
- Effective precedence is `project` > `global` > `service`.
- Scope mismatches are rejected both by CLI and REST. For example, `PORT` cannot be written with `--scope project`, and `LLMPROXY_MODE` cannot be written with `--scope global`.

### Price/Performance Routing

`LLMPROXY_PRICE_PERFORMANCE_ROUTING` is the project-scoped routing control that remains available after the smart router removal.

#### How it works

1. `llmProxy` starts from the configured provider order.
2. If `LLMPROXY_PRICE_PERFORMANCE_ROUTING=1`, it reorders the first attempt to prefer:
   - free providers first (`free_model=true`)
   - otherwise the lowest estimated cost
3. If more than one candidate has the same effective cost, `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER` decides whether to prefer:
   - `power`
   - `speed`

#### Configuration

Add these variables to your project's `.claude/settings.json`:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "LLMPROXY_PRICE_PERFORMANCE_ROUTING": "1",
    "LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER": "power"
  }
}
```

**Environment variables:**

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `LLMPROXY_PRICE_PERFORMANCE_ROUTING` | `0`, `1`, `false`, `true` | disabled | Enables cost-aware provider reordering before the first attempt |
| `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER` | `power`, `speed` | `power` | Chooses whether equal-cost candidates prefer stronger or faster models |

#### Example behavior

With providers `openai (gpt-5, free_model=false)`, `opencode (deepseek-v4-flash-free, free_model=true)`, and `nvidia (z-ai/glm-5.2, free_model=true)`:

- with `LLMPROXY_PRICE_PERFORMANCE_ROUTING=0`, the manual provider order is used
- with `LLMPROXY_PRICE_PERFORMANCE_ROUTING=1`, free providers are moved ahead of paid ones
- with `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER=speed`, the faster free provider wins among the free candidates

### `llmproxy model:set <model>`

Quickly updates `model` and `env.ANTHROPIC_DEFAULT_MODEL` in the current project without re-running `claude:setup`.

Use it when you want to switch to a raw provider-aware value such as `deepseek:deepseek-v4-flash` or set an explicit chain such as `copilot:gpt-5.4,deepseek:deepseek-v4-flash`.

### `llmproxy update`

Updates the global `llmproxy` installation by cloning the latest version from the GitHub repository `alessiobacin/llmProxy` and reinstalling it globally.
After the update, it relaunches the updated binary with `llmproxy version` to verify that the new installation is active.
Before confirming success, it now runs a smoke test on the freshly installed CLI (`version`, `config:list`, `status`).
If that verification fails, `llmproxy update` automatically restores the previously installed global package and restarts the managed service from the restored version.
During the update, only one active global installation is kept, and any duplicate `pnpm` wrappers are removed.
The reinstall is forced even when the package version string is unchanged, so same-version maintenance builds still replace the installed files.
As part of the update, llmProxy also migrates managed configuration files to the current schema: legacy keys such as `LLM_STATS_API_KEY`, unprefixed `SENDGRID_*`, `LLMPROXY_SMART_*`, and the old split MongoDB variables are removed or rewritten to the supported names such as `LLMPROXY_LLM_STATS_API_KEY`, `LLMPROXY_SENDGRID_*`, and `LLMPROXY_MONGODB_CONNECTION_STRING`.
Before reinstalling, the updater now proactively kills anything listening on port `7045`, removes stale global wrappers, best-effort uninstalls previous npm/pnpm copies, and purges legacy install directories discovered in common global locations. This is meant to make upgrades from `0.2.77` and older resilient even on machines with multiple historical installs.

On Linux systems where the global npm prefix is under `/usr/local` (root-owned), the CLI now stops before changing anything if it cannot use `sudo` non-interactively. Run `sudo -v` first and then `llmproxy update`, or invoke `sudo llmproxy update` directly.

### `llmproxy install:persistent-it`

Explicit Italian path for persistent installation.

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
pnpm run install:persistent-it
```

If the CLI is already installed globally, you can use:

```bash
llmproxy install:persistent-it
```

The command installs the current CLI globally and enables the native persistent service for the OS.
Before changing anything, it validates prerequisites such as `npm`, the service manager, Docker, and Docker Compose, then prints OS-specific remediation commands if something is missing.
If the global npm prefix is root-owned, pre-authorize sudo with `sudo -v` before running this CLI command, or run the command itself with `sudo`.
When you use this command, the command output, dedicated help text, and error messages for this path are shown in Italian.

### `llmproxy install:persistent-en`

Explicit English path for persistent installation.

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
pnpm run install:persistent-en
```

Or:

```bash
node bin/llmproxy.js install:persistent-en
```

If the CLI is already installed globally, you can use:

```bash
llmproxy install:persistent-en
```

The command installs the current CLI globally and enables the native persistent service for the OS.
Before changing anything, it validates prerequisites such as `npm`, the service manager, Docker, and Docker Compose, then prints OS-specific remediation commands if something is missing.
If the global npm prefix is root-owned, pre-authorize sudo with `sudo -v` before running this CLI command, or run the command itself with `sudo`.
When you use this command, the command output, dedicated help text, and error messages for this path are shown in English.

### `llmproxy install`

Short English alias for `llmproxy install:persistent-en`.

Quick choice:

- if you want the Italian path, use `llmproxy install:persistent-it`
- if you want the explicit English path, use `llmproxy install:persistent-en`
- if you want the short English path, use `llmproxy install`

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
node bin/llmproxy.js install
```

If the CLI is already installed globally, you can use:

```bash
llmproxy install
```

The command installs the current CLI globally and enables the native persistent service for the OS.
When you use this alias, the command output, dedicated help text, and error messages for this path are shown in English.

### `llmproxy version`

Prints the current installed CLI version.

You can also use the aliases `llmproxy --version` and `llmproxy -v`.

### Useful aliases

- `llmproxy --help` and `llmproxy -h` are equivalent to `llmproxy help`
- `llmproxy install` is equivalent to `llmproxy install:persistent-en`
- `llmproxy install:persistent` is equivalent to the legacy Italian path `llmproxy install:persistent-it`
- `llmproxy --version` and `llmproxy -v` are equivalent to `llmproxy version`

### `llmproxy uninstall`

Removes `llmproxy` from supported global installations and cleans up residual wrappers.
Use it when you want to completely uninstall the CLI from the system.

## Runtime Paths

You can override the data root with `LLMPROXY_HOME`.

Default for macOS:

```text
~/Library/Application Support/llmProxy
```

Default for Linux:

```text
~/.local/share/llmProxy
```

Inside the data root, the following files are created:

- `copilot-token.json`
- `copilot-models.json`
- `copilot-endpoints.json`
- `provider-registry.json`
- `logs/service.out.log`
- `logs/service.err.log`
- `logs/requests-YYYY-MM-DD.jsonl`

`copilot-token.json` stores both the default provider and any additional Copilot providers together with their fallback order.
`copilot-models.json` stores the latest model catalog fetched from the GitHub Copilot live endpoint.
`provider-registry.json` stores the configured providers with their credentials and fallback order.

## Environment Variables

### Two Configuration Paths

| Method | What you configure | Effect | File |
|--------|--------------------|--------|------|
| **CLI** `llmproxy config:set` | **project-scope** variables | immediate, no restart | `.claude/settings.json` → `env` |
| **.env** | **service-scope** variables | after service restart | `.env` |

Any supported variable can still be overridden through the `env` block inside `.claude/settings.json` when Claude Code is the client. That is the recommended configuration path for Claude Code projects.

### Project Scope (CLI, Immediate Effect)

[.env.example](/Users/alessiobacin/Development/llmProxy/.env.example) is the canonical catalog of all supported variables. Start there if you need a complete list while setting up a fresh clone of the repo.

Important rule for booleans in `.claude/settings.json`:

- if a boolean variable is missing from `.claude/settings.json`, its effective project value is `0` / `false`
- it does not automatically inherit unrelated container or process environment values
- this applies in particular to `LLMPROXY_SHORT_ANSWER`, `LLMPROXY_METERING_INLINE`, and `LLMPROXY_INFERENCE_INFO_INLINE`

These variables are managed with `llmproxy config:*`. They take effect immediately and are re-read from `.claude/settings.json` on every request.

```bash
llmproxy config:list                                      # lists effective project + global + service values
llmproxy config:list --scope global                       # lists only ~/.claude/settings.json managed defaults
llmproxy config:get ANTHROPIC_BASE_URL                    # reads a variable from its effective scope
llmproxy config:set LLMPROXY_PRICE_PERFORMANCE_ROUTING 1 --scope project
llmproxy config:set LLMPROXY_LLM_STATS_API_KEY your-free-key --scope global
llmproxy config:unset ANTHROPIC_DEFAULT_MODEL --scope project
```

| Variable | Default | Available Values | Description |
| --- | --- | --- | --- |
| `ANTHROPIC_BASE_URL` | auto | URL (e.g. `http://127.0.0.1:7045`) | Anthropic-compatible endpoint base URL (the proxy itself) |
| `ANTHROPIC_DEFAULT_MODEL` | unset | any model ID or fallback chain | default model for Anthropic requests; supports chains like `copilot:claude-sonnet-4-6,openai:gpt-5` |
| `ANTHROPIC_AUTH_TOKEN` | auto-managed | string | local placeholder used by Claude to call the proxy; injected automatically into `~/.claude/settings.json`, not required in project `.claude/settings.json` |
| `API_TIMEOUT_MS` | auto | milliseconds | API request timeout |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | unset | `0`, `1` | if `1`, disables Claude Code experimental betas |
| `LLMPROXY_LLM_STATS_API_KEY` | unset | string | required Claude Code stats key used by llmProxy inference |
| `LLMPROXY_SENDGRID_API_KEY` | unset | string | SendGrid API key for project-scoped email notifications |
| `LLMPROXY_SENDGRID_FROM_EMAIL` | unset | email | sender address for project-scoped email notifications |
| `LLMPROXY_SENDGRID_TO_EMAIL` | unset | email | recipient address for project-scoped email notifications |
| `LLMPROXY_SENDGRID_TO_MESSAGE_TYPE` | `service_unreachable,service_recovered,provider_error,auto_escalation,provider_credit_exhausted,service_update` | comma-separated list, `all`, `*` | which notification categories are enabled for the project |
| `LLMPROXY_SHORT_ANSWER` | unset (`off`) | `0`, `1` | if `1`, enables short answer mode |
| `LLMPROXY_PRICE_PERFORMANCE_ROUTING` | unset (`off`) | `0`, `1`, `false`, `true` | enables free-first / lower-cost provider reordering |
| `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER` | `power` | `power`, `speed` | tie-breaker used when multiple candidates have the same effective cost |

Example project notification block:

```json
{
  "model": "llmProxy",
  "env": {
    "LLMPROXY_LLM_STATS_API_KEY": "your-free-key",
    "LLMPROXY_SENDGRID_API_KEY": "SG.xxx",
    "LLMPROXY_SENDGRID_FROM_EMAIL": "llmproxy@example.com",
    "LLMPROXY_SENDGRID_TO_EMAIL": "ops@example.com",
    "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE": "service_unreachable,service_recovered,provider_error"
  }
}
```

### Service-Scope (.env — richiede restart)

For a complete ready-to-copy variable list, see `[.env.example](/Users/alessiobacin/Development/llmProxy/.env.example)`.

Queste variabili sono lette solo all'avvio del server. Per applicare una modifica:

```bash
# 1. modifica .env o lancia
llmproxy service:restart
# 2. oppure kill + llmproxy run
```

Possono comunque essere sovrascritte anche nel campo `env` di `.claude/settings.json` (per i progetti Claude Code).

| Variable | Default | Available Values | Description |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | any valid IP/hostname | server bind address |
| `PORT` | auto (from profile) | any valid port | proxy port; auto-derived: `5045` dev, `6045` staging, `7045` production |
| `NODE_ENV` | auto (from profile) | `development`, `staging`, `production` | standard Node.js environment |
| `LLMPROXY_ENV` | auto (from profile) | `development`, `staging`, `production` | llmProxy environment |
| `LLMPROXY_RUNTIME_PROFILE` | auto | `development` (or `dev`), `staging`, `production` (or `prod`) | runtime profile; determines defaults for `NODE_ENV`, `LLMPROXY_ENV`, ports, db-layer URL, and event-bus URL |
| `LLMPROXY_MODE` | `standalone` | `standalone`, `platform` | `standalone` is the default. `platform` is allowed only when both db-layer and event-bus are reachable; default production checks are `http://localhost:7001/health` and `http://localhost:7048/health` |
| `LLMPROXY_MONGODB_CONNECTION_STRING` | unset | full MongoDB connection string | standalone persistence target for metering/log storage; when unset, standalone mode falls back to local JSONL storage. Ignored when `LLMPROXY_MODE=platform` |
| `LLMPROXY_METERING_INLINE` | unset | `0`, `1` | if `1`, appends inline token/metering stats at the end of the inference; if absent in `.claude/settings.json`, the project value is `0` |
| `LLMPROXY_INFERENCE_INFO_INLINE` | unset | `0`, `1` | if `1`, prepends inline provider/model info at the start of the inference; if absent in `.claude/settings.json`, the project value is `0` |
| `LLMPROXY_PROVIDER_CREDIT_INLINE` | `1` (service default) | `0`, `1` | if `1`, shows provider residual credit inline in the provider list (`provider:list`); **service-scope variable**, must be set with `--scope service` |
| `DBLAYER_URL` | auto | full URL | optional explicit db-layer override. If absent, llmProxy derives `5001` dev, `6001` staging, `7001` production. The port is automatically corrected by `resolveServiceUrlForProfile` to match the runtime profile port prefix (5/6/7), so a dev URL with port `6001` would be overwritten to `5001` when running in development profile |
| `EVENTBUS_URL` | auto | full URL | optional explicit event-bus override. If absent, llmProxy derives `5048` dev, `6048` staging, `7048` production. Same automatic port correction as `DBLAYER_URL`: port must match the active runtime profile prefix |
| `LLMPROXY_SECRET` | unset | arbitrary string | optional HMAC secret for internal token signing |
| `LLMPROXY_SERVICE_RUNTIME` | auto | `native`, `docker` | persistent service runtime: `native` (LaunchAgent/systemd) or `docker` (Docker Compose) |
| `LLMPROXY_DOCKER_COMPOSE_FILE` | auto | file path | Docker Compose file for docker runtime |
| `LLMPROXY_DOCKER_SERVICE` | auto | service name | Docker service name in compose file |
| `LLMPROXY_DOCKER_POLL_MS` | auto | milliseconds | poll interval for Docker container health check |
| `LLMPROXY_GLOBAL_SERVICE` | unset | `0`, `1` | if `1`, enables global service on reserved ports 6045/7045 |
| `LLMPROXY_HOME` | auto (OS-specific) | directory path | runtime data directory; default: `~/Library/Application Support/llmProxy` (macOS), `~/.local/share/llmProxy` (Linux), `%APPDATA%\llmProxy` (Windows) |
| `LLMPROXY_LOG_RETENTION_DAYS` | `7` (dev/staging), `30` (production) | integer | JSONL log retention in days |
| `LLMPROXY_LOG_MAX_BYTES` | `5242880` | integer | max JSONL file size before rotation |
| `LLMPROXY_LOG_MAX_FILES` | `5` | integer | max archived JSONL files per day |

### Port Mapping by Environment

Service ports follow the V11 convention: `<prefix><module_number>`, where prefix is `5` (dev), `6` (staging), `7` (production).

| Service | Module | Dev | Staging | Production |
|----------|--------|-----|---------|------------|
| `llm-proxy` | 45 | `5045` | `6045` | `7045` |
| `db-layer` | 46 | `5046` | `6046` | `7046` |
| `event-bus` | 48 | `5048` | `6048` | `7048` |

## Persistence After Reboot

### macOS

The `llmproxy service:start` command installs a user `LaunchAgent`.
This means:

- the service becomes available again after reboot
- it restarts when the user session is loaded
- it does not require PM2
- it does not start before the user logs in

If you use `pnpm run install:persistent`, the command first installs the CLI globally and then registers the same `LaunchAgent`, so restart after reboot keeps working.

If you want to switch the same machine from the Docker runtime back to the native macOS service, use:

```bash
llmproxy service:runtime launchd
```

### Linux

The `llmproxy service:start` command installs a `systemd --user` service.

If you want to switch the same machine from the native runtime to Docker, use:

```bash
llmproxy service:runtime docker
```

Practical note:

- in many environments the user service starts when the user logs in
- if you need persistence even without a graphical or shell login, you may need to configure `linger`
- in production/shared setups, use one global `llmproxy` service backed by the Docker runtime, bound to `127.0.0.1:7045`

With the one-shot bootstrap:

```bash
pnpm run install:persistent
```

the CLI is first installed globally and then the `systemd --user` service is enabled. To guarantee restart even without user login, also enable:

```bash
sudo loginctl enable-linger $USER
```

## Logging

`llmProxy` keeps two log layers:

### 1. Service logs

These are the native service stdout/stderr files, used by `llmproxy logs`.

### 2. JSONL audit logs

Structured request logs are written to `logs/requests-YYYY-MM-DD.jsonl`.

These files are automatically rotated by size:

- default threshold `5 MB` per file
- up to `5` archives per day
- progressive naming `requests-YYYY-MM-DD.jsonl.1`, `.2`, ...
- day-based retention managed by `LLMPROXY_LOG_RETENTION_DAYS`

`llmproxy logs` shows both the service logs and the latest available JSONL audit log.

Each request generates structured entries with:

- timestamp
- `requestId`
- `projectPath`
- source of `projectPath`
- requested model
- selected Copilot endpoint
- result
- duration

## Troubleshooting

### `llmproxy` is not found after global installation

Check where pnpm exposes global binaries:

```bash
pnpm bin -g
command -v llmproxy
```

If you are working from a local checkout, the most reliable path is:

```bash
pnpm link --global
hash -r
command -v llmproxy
```

If the command resolves to a path inside `.pnpm-global/bin`, the CLI is ready.

### `llmproxy provider:add copilot` fails

- verify that you are connected to the Internet
- run the command again and complete the GitHub device flow
- if the token expired, use `llmproxy logout` and then `llmproxy provider:add copilot`

### The proxy responds with `authentication_error`

The local token is missing or no longer valid:

```bash
llmproxy provider:add copilot
```

### The service does not start

1. check `llmproxy status`
2. read `llmproxy logs`
3. start in foreground with `llmproxy run` to isolate errors

### Logs do not show the correct project

Send the explicit path in the header:

```http
x-project-path: /absolute/path/to/project
```

## Development Notes

This project is standalone and does not require runtime dependencies beyond those installed by the package itself.

Recommended workflow:

```bash
pnpm install
pnpm test
pnpm dev
```

Existing tests:

- project context detection
- device flow token polling
- JSONL logger
- launchd service rendering
- HTTP runtime `/health`, `/auth/status`, and `/v1/messages`

### Notable internal changes

**`lib/runtime-env.js`**: `loadRuntimeEnv` now passes `DBLAYER_URL` and `EVENTBUS_URL` through `resolveServiceUrlForProfile(url, expectedPort)`. This function validates that each URL's port matches the profile-appropriate port prefix (5/6/7 for dev/staging/production) and corrects it if a mismatch is detected. This prevents services like event-bus from being contacted on the wrong port when the runtime profile changes (e.g., running on 7045 but connecting to event-bus on 5048 — now correctly forced to 7048).

**`lib/copilot-proxy.js`**: Fixed a fallthrough bug in the inference flow control. Network errors and provider API errors were not properly isolated with `else` branches, causing execution to fall through after an error was already handled. Both paths now terminate with explicit `else` instead of falling through to subsequent logic. This avoids spurious second error reports for the same failed request.
