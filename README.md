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
- verifies Node.js 22+ and npm
- installs the latest `llmProxy` package directly from the GitHub repository tarball
- registers the native persistent service (launchd / systemd / Windows Service)
- forces a final `llmproxy service:restart` so the Docker-backed runtime is created/recreated and health-checked before the installer exits
- auto-selects English or Italian output based on your locale

> **Next step after install**: `llmproxy provider:add copilot`

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
pppnpm run install:persistent-it
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

- Italian: `pppnpm run install:persistent-it` or `llmproxy install:persistent-it`
- English: `pppnpm run install:persistent-en`, `node bin/llmproxy.js install:persistent-en`, `node bin/llmproxy.js install`, or `llmproxy install`

Compatibility:

- `ppnpm run install:persistent` still points to the Italian path
- `llmproxy install:persistent` still works as a legacy alias for the Italian path

The bootstrap flow:

- automatically detects the supported OS (`macOS`, `Linux`, or `Windows`)
- verifies the required prerequisites before the global install starts
- prints OS-specific remediation commands when `npm`, `systemd`, Docker, or Docker Compose are missing
- installs the current CLI globally from the repository package
- removes any duplicate global wrappers
- launches `llmproxy service:start` through the newly installed global binary

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

### 3. Add the Copilot provider

```bash
llmproxy provider:add copilot
```

The CLI:

1. requests a device code from GitHub
2. prints the authorization URL and code
3. waits for login completion
4. stores the provider locally

`llmproxy login` still exists as a deprecated compatibility alias of `llmproxy provider:add copilot`.

### 4. Start in foreground

```bash
llmproxy run
```

By default the server starts on:

```text
http://127.0.0.1:5045
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

### 6. Install as a persistent service

```bash
llmproxy service:start
```

Or, if you want global installation plus service activation in one step:

```bash
pppnpm run install:persistent-it
```

For the same flow in English:

```bash
pppnpm run install:persistent-en
```

On macOS this creates and loads a user `LaunchAgent`.
On Linux this creates and enables a `systemd --user` service.

### 7. Configure Claude Code with the desired model

```bash
llmproxy models:list
llmproxy claude:setup --model 2
```

### 8. Service status and logs

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

You can route different models to different providers directly from `ANTHROPIC_DEFAULT_MODEL` using a comma-separated list:

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
GET    /api/providers/available
GET    /api/providers/status
GET    /api/providers/usage
POST   /api/providers/{id}/login
POST   /api/providers/{id}/api-key
POST   /api/providers/order
POST   /api/providers/{id}/rename
DELETE /api/providers/{id}

GET    /api/stats
POST   /api/smart/add
GET    /api/smart/status
POST   /api/smart/test
POST   /api/smart/refresh

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
| `llmproxy login` | `POST /api/auth/login` (legacy alias of `provider:add copilot`) |
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
| `llmproxy provider:available` | `GET /api/providers/available` |
| `llmproxy provider:list` | `GET /api/providers` |
| `llmproxy provider:status` | `GET /api/providers/status` |
| `llmproxy provider:usage` | `GET /api/providers/usage` |
| `llmproxy provider:add <id> [--name <n>] [--vision <t|f>]` | `POST /api/providers/{id}/login` |
| `llmproxy provider:add <id> --api-key <key> --vision <t|f>` | `POST /api/providers/{id}/api-key` |
| `llmproxy provider:key <id> --api-key <key> [--vision <t|f>]` | `POST /api/providers/{id}/api-key` |
| `llmproxy provider:order <id> <position>` | `POST /api/providers/order` |
| `llmproxy provider:rename <id> <name>` | `POST /api/providers/{id}/rename` |
| `llmproxy provider:remove <id>` | `DELETE /api/providers/{id}` |
| `llmproxy stats` | `GET /api/stats` |
| `llmproxy smart:add ...` | `POST /api/smart/add` |
| `llmproxy smart:status` | `GET /api/smart/status` |
| `llmproxy smart:test` | `POST /api/smart/test` |
| `llmproxy smart:refresh` | `POST /api/smart/refresh` |
| `llmproxy config:list [--project\|--service]` | `GET /api/config` |
| `llmproxy config:get <key> [--project\|--service]` | `GET /api/config/{key}` |
| `llmproxy config:set <key> <value> [--project\|--service]` | `POST /api/config/{key}` |
| `llmproxy config:unset <key> [--project\|--service]` | `DELETE /api/config/{key}` |
| `llmproxy update` | `POST /api/update` |
| `llmproxy uninstall` | `POST /api/uninstall` |

## CLI Commands

### `llmproxy setup`

Prepares runtime directories and shows the selected service manager.

### `llmproxy login`

Deprecated compatibility alias. It runs the same GitHub Copilot device flow as `llmproxy provider:add copilot` and stores or updates the default Copilot provider.

### `llmproxy logout`

Removes all local Copilot providers.

### `llmproxy run`

Starts the proxy in the foreground.

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
- `llmproxy test -i --all-providers` still runs one real inference, then prints the remaining fallback chain after the winning provider

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
- the vision capability is shown as `vision=true` or `vision=false`
- for `qwen`, the saved plan is shown as `plan=subscription` or `plan=payg`
- the residual credit is shown as `credit=...` when the provider exposes a balance endpoint
- if the provider does not expose a readable balance endpoint, or the current key cannot read it, the suffix is `credit=n/a` or `credit=unavailable`
- the current provider price is shown as `price=...`
- the cheapest alternative discovered through the CloudPrice pricing API is shown as `best=... (...)`

Pricing notes:

- the price comparison uses the public CloudPrice model pricing API: `GET /models/{id}/pricing/calculate`
- the comparison is normalized on `tier=standard`, `input_tokens=1000000`, `output_tokens=1000000`
- this makes the numbers directly comparable across providers for the same model
- the rendered label shows both token dimensions explicitly: `in=...` and `out=...`
- if CloudPrice cannot resolve the current provider/model pair, the command prints `price=n/a` or `price=unavailable`

### `llmproxy provider:test`

Tests the vision capability of all configured providers by sending a test image and analyzing responses.

Use it to verify:

- that the `--vision` flag is correctly set for each provider
- that vision-capable models actually process images
- that non-vision models correctly skip image processing

Example output:

```
Test visione provider...

🔍 Qwen (qwen3.7-plus) - atteso: visione ✅
  ✅ PASS - Visione confermata
     Risposta: L'immagine è molto semplice e astratta, composta da...
🔍 DeepSeek (deepseek-v4-pro) - atteso: testo ❌
  ✅ PASS - Visione correttamente disabilitata
     Risposta: [empty response]

Risultati: 2 pass, 0 fail, 0 skip
```

### `llmproxy provider:status`

Shows the active provider and the ordered list of providers with the current fallback state.

### `llmproxy provider:order <id> <position>`

Moves a provider to the requested fallback position.

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

### `llmproxy claude:setup`

Creates or updates `.claude/settings.json` in the current folder with the `env` variables required to use `llmProxy` as the local backend for Claude Code.

Supports `--model <index>` to show the selected default model in CLI output while keeping `.claude/settings.json` minimal (`model: llmProxy` plus proxy base URL).

### `llmproxy config:list|get|set|unset`

These commands expose the full supported configuration surface both from CLI and REST.

- `--project` writes only variables that belong in `.claude/settings.json`, such as `ANTHROPIC_DEFAULT_MODEL`, `LLMPROXY_SMART_ROUTE`, and `LLMPROXY_SHORT_ANSWER`.
- `--service` writes only variables that govern the runtime service, such as `PORT`, `LLMPROXY_MODE`, and `LLMPROXY_SECRET`.
- Scope mismatches are rejected both by CLI and REST. For example, `PORT` cannot be written with `--project`.

### Smart Router

The smart router automatically selects the best model for each request based on complexity, vision, and tool requirements. It uses a lightweight LLM classifier to analyze incoming requests and route them to the most cost-effective model that meets the requirements.

#### How it works

1. **Classifier**: A small, fast LLM (e.g., DeepSeek on OpenRouter) analyzes each request and classifies it by:
   - `complexity`: simple, moderate, complex
   - `needsVision`: whether the request contains images
   - `needsTools`: whether the request uses tool definitions
   - `type`: coding, creative, reasoning, qa

2. **Routing rules**: Based on the classification, the router selects a model from the registered providers:
   - `economy` tier (deepseek-chat, gpt-4o-mini, etc.) for simple requests without tools
   - `standard` tier (claude-haiku-4.5, gpt-4.1, etc.) for requests with vision or moderate complexity
   - `premium` tier (claude-opus-4, gpt-5, etc.) for complex requests with many tools or long context

3. **Preference modes**: You can bias the routing with `LLMPROXY_SMART_PREFERENCE`:
   - `balanced` (default): prefer lowest tier that meets requirements, then lowest cost
   - `economy`: always prefer the cheapest model that works
   - `quality`: always prefer the most capable model that works

#### Configuration

**Step 1: Add the classifier**

Configure a lightweight LLM as the classifier. Use a fast, cheap model like `deepseek-chat` on OpenRouter:

```bash
llmproxy smart:add --provider openrouter --model deepseek-chat --api-key sk-or-xxx
```

This saves the classifier configuration to `~/.local/share/llmProxy/smart-router.json` (Linux) or `~/Library/Application Support/llmProxy/smart-router.json` (macOS).

**Step 2: Enable smart routing in your project**

Add these environment variables to your project's `.claude/settings.json`:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "LLMPROXY_SMART_ROUTE": "hybrid",
    "LLMPROXY_SMART_PREFERENCE": "balanced"
  }
}
```

**Environment variables:**

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `LLMPROXY_SMART_ROUTE` | `rules`, `llm`, `hybrid`, disabled | disabled | Routing mode: `rules` uses only static heuristics, `llm` uses only the classifier, `hybrid` combines rules plus classifier |
| `LLMPROXY_SMART_PREFERENCE` | `balanced`, `economy`, `quality` | `balanced` | Cost vs quality tradeoff |
| `LLMPROXY_SMART_CACHE_TTL` | milliseconds | `300000` (5 min) | How long to cache provider availability checks |

**Step 3: Verify configuration**

Check the smart router status and simulate routing:

```bash
llmproxy smart:status    # shows classifier config, API key (masked), registered providers
llmproxy smart:test      # simulates routing for simple/moderate/complex scenarios
```

#### CLI commands

| Command | Description |
|---------|-------------|
| `llmproxy smart:add --provider <p> --model <m> --api-key <k>` | Configure the classifier LLM |
| `llmproxy smart:status` | Show smart router status and classifier config |
| `llmproxy smart:test` | Simulate routing for 3 scenarios (simple, moderate, complex) |
| `llmproxy smart:refresh` | Invalidate provider availability cache |

#### Example: routing behavior

With providers `qwen (qwen3.7-max)`, `deepseek (deepseek-v4-pro)`, and `kimi (kimi-k2.6)`:

- **Simple chat** (no tools, no vision) → `qwen3.7-max` (economy tier, lowest cost)
- **Moderate with tools** → `qwen3.7-max` (economy tier, supports tools)
- **Complex with vision + tools** → no suitable model (none of the registered models support vision)

To handle vision requests, add a provider with a vision-capable model:

```bash
llmproxy provider:add openrouter --model claude-sonnet-4 --api-key sk-or-xxx
```

### `llmproxy model:set <model>`

Quickly updates `model` and `env.ANTHROPIC_DEFAULT_MODEL` in the current project without re-running `claude:setup`.

Use it when you want to switch to a raw provider-aware value such as `deepseek:deepseek-v4-flash` or set an explicit chain such as `copilot:gpt-5.4,deepseek:deepseek-v4-flash`.

### `llmproxy update`

Updates the global `llmproxy` installation by cloning the latest version from the GitHub repository `alessiobacin/llmProxy` and reinstalling it globally.
After the update, it relaunches the updated binary with `llmproxy version` to verify that the new installation is active.
During the update, only one active global installation is kept, and any duplicate `pnpm` wrappers are removed.
The reinstall is forced even when the package version string is unchanged, so same-version maintenance builds still replace the installed files.

On Linux systems where npm global is under `/usr/local` (owned by root), the command automatically detects the permission error and retries with `sudo`. There is no need to manually run `sudo llmproxy update`.

### `llmproxy install:persistent-it`

Explicit Italian path for persistent installation.

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
ppnpm run install:persistent-it
```

If the CLI is already installed globally, you can use:

```bash
llmproxy install:persistent-it
```

The command installs the current CLI globally and enables the native persistent service for the OS.
Before changing anything, it validates prerequisites such as `npm`, the service manager, Docker, and Docker Compose, then prints OS-specific remediation commands if something is missing.
When you use this command, the command output, dedicated help text, and error messages for this path are shown in Italian.

### `llmproxy install:persistent-en`

Explicit English path for persistent installation.

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
ppnpm run install:persistent-en
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
- `smart-router.json`
- `logs/service.out.log`
- `logs/service.err.log`
- `logs/requests-YYYY-MM-DD.jsonl`

`copilot-token.json` stores both the default provider and any additional Copilot providers together with their fallback order.
`copilot-models.json` stores the latest model catalog fetched from the GitHub Copilot live endpoint.
`provider-registry.json` stores the configured providers with their credentials and fallback order.

## Environment Variables

### Due modi di configurare

| Metodo | Cosa configuri | Effetto | File |
|--------|---------------|--------|------|
| **CLI** `llmproxy config:set` | variabili **project-scope** | **immediato** (senza restart) | `.claude/settings.json` → `env` |
| **.env** | variabili **service-scope** | dopo **restart** del servizio | `.env` |

Tutte le variabili, indipendentemente dallo scope, possono essere sovrascritte tramite il campo `env` di `.claude/settings.json` (impostabile anche con Claude Code `/statusline` o manualmente). Questo è il metodo raccomandato per configurare Claude Code.

### Project-Scope (CLI — effetto immediato)

[.env.example](/Users/alessiobacin/Development/llmProxy/.env.example) is the canonical catalog of all supported variables. Start there if you need a complete list while setting up a fresh clone of the repo.

Important rule for booleans in `.claude/settings.json`:

- if a boolean variable is missing from `.claude/settings.json`, its effective project value is `0` / `false`
- it does not automatically inherit the global container or process value
- this applies in particular to `LLMPROXY_SHORT_ANSWER`, `LLMPROXY_METERING_INLINE`, and `LLMPROXY_INFERENCE_INFO_INLINE`

Queste variabili sono gestite con `llmproxy config:*` e l'effetto è immediato, senza restart del proxy. Vengono lette da `.claude/settings.json` a ogni richiesta.

```bash
llmproxy config:list                        # elenca le variabili disponibili
llmproxy config:get ANTHROPIC_BASE_URL      # legge una variabile
llmproxy config:set LLMPROXY_SMART_ROUTE hybrid   # imposta una variabile
llmproxy config:unset ANTHROPIC_DEFAULT_MODEL     # rimuove una variabile
```

| Variable | Default | Available Values | Description |
| --- | --- | --- | --- |
| `ANTHROPIC_BASE_URL` | auto | URL (e.g. `http://127.0.0.1:7045`) | Anthropic-compatible endpoint base URL (the proxy itself) |
| `ANTHROPIC_DEFAULT_MODEL` | unset | any model ID or fallback chain | default model for Anthropic requests; supports chains like `copilot:claude-sonnet-4-6,openai:gpt-5` |
| `ANTHROPIC_AUTH_TOKEN` | unset | string | authentication token for the Anthropic endpoint |
| `API_TIMEOUT_MS` | auto | milliseconds | API request timeout |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | unset | `0`, `1` | if `1`, disables Claude Code experimental betas |
| `LLMPROXY_SHORT_ANSWER` | unset (`off`) | `0`, `1` | if `1`, enables short answer mode |
| `LLMPROXY_SMART_ROUTE` | unset | `hybrid`, `economy`, `standard`, `premium` | automatic routing strategy based on request complexity |
| `LLMPROXY_SMART_PREFERENCE` | unset | `balanced`, `economy`, `quality` | cost/quality balance preference for smart routing |
| `LLMPROXY_SMART_CACHE_TTL` | unset | seconds | smart router cache TTL |

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
| `LLMPROXY_RUNTIME_PROFILE` | auto | `development` (or `dev`), `staging`, `production` (or `prod`) | runtime profile; determines defaults for NODE_ENV, LLMPROXY_ENV, ports, metering sink |
| `LLMPROXY_MODE` | `standalone` | `standalone`, `platform` | `standalone` for local dev; `platform` for V11 integration with `X-Hierarchy-Context` header |
| `LLMPROXY_METERING_SINK` | `dblayer` | `dblayer`, `jsonl`, `inline`, `noop`, or `+`-separated combos | LLM call metering sink |
| `LLMPROXY_METERING_INLINE` | unset | `0`, `1` | if `1`, appends inline token/metering stats at the end of the inference; if absent in `.claude/settings.json`, the project value is `0` |
| `LLMPROXY_INFERENCE_INFO_INLINE` | unset | `0`, `1` | if `1`, prepends inline provider/model info at the start of the inference; if absent in `.claude/settings.json`, the project value is `0` |
| `DBLAYER_URL` | unset | full URL (e.g. `http://localhost:5046`) | db-layer service URL; if **unset**, db-layer is **not active** (no POST attempts). Set to `localhost:5046` (dev), `localhost:6046` (staging), or `localhost:7046` (production) |
| `EVENTBUS_URL` | unset | full URL (e.g. `http://localhost:5048`) | event-bus service URL; if **unset**, event-bus is **no-op**. Set to `localhost:5048` (dev), `localhost:6048` (staging), or `localhost:7048` (production) |
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
| `LLM_STATS_API_KEY` | unset | string | API key for stats service |
| `SENDGRID_API_KEY` | unset | string | SendGrid API key for email notifications |
| `SENDGRID_FROM_EMAIL` | unset | email | sender address for email notifications |
| `SENDGRID_TO_EMAIL` | unset | email | recipient address for email notifications |

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

If you use `ppnpm run install:persistent`, the command first installs the CLI globally and then registers the same `LaunchAgent`, so restart after reboot keeps working.

### Linux

The `llmproxy service:start` command installs a `systemd --user` service.

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
