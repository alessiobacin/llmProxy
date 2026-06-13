# llmProxy

`llmProxy` is a standalone package that exposes a GitHub Copilot proxy with an Anthropic-compatible `/v1/messages` endpoint plus a global CLI for login, startup, status, logs, persistent service management, and fallback across multiple GitHub Copilot accounts. It is currently optimized for Claude Code workflows.

> **v8 platform mode**: llmProxy can also run as Tool #45 of the v8 architecture, exposing `/v1/llm/messages` and `/v1/llm/health` with mandatory HierarchyContext / MeteringContext. Set `LLMPROXY_MODE=platform`. Full details in [docs/CHANGELOG-v8-platform-tool.md](docs/CHANGELOG-v8-platform-tool.md).

## Quick Start

### 0. Clone the repository

If you are starting from scratch, clone the repository locally and enter the project directory:

```bash
git clone https://github.com/alessiobacin/llmProxy.git
cd llmProxy
```

Then install the local checkout dependencies:

```bash
pnpm install
```

If you do not have `pnpm`, you can also use:

```bash
npm install
```

### Recommended persistent bootstrap

If you want to install the CLI persistently with a single command, you can explicitly choose between the Italian and English variants.

### Install `llmProxy` in Italian or English

#### Italian variant

Use these commands if you want the installation flow to keep showing messages and explanations in Italian:

```bash
npm run install:persistent-it
```

If the CLI is already available in your `PATH`, you can also use:

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

- Italian: `npm run install:persistent-it` or `llmproxy install:persistent-it`
- English: `npm run install:persistent-en`, `node bin/llmproxy.js install:persistent-en`, `node bin/llmproxy.js install`, or `llmproxy install`

Compatibility:

- `npm run install:persistent` still points to the Italian path
- `llmproxy install:persistent` still works as a legacy alias for the Italian path

The bootstrap flow:

- automatically detects the supported OS (`macOS` or `Linux`)
- installs the current CLI globally with `npm install -g`
- removes any duplicate global wrappers
- launches `llmproxy service:start` through the newly installed global binary

This way the persistent service always points to the final global installation starting from the local repository checkout.

### 1. Verify runtime setup

```bash
llmproxy setup
```

Shows:

- the package data root
- the native service manager selected for the OS

### 2. Log in to GitHub Copilot

```bash
llmproxy login
```

The CLI:

1. requests a device code from GitHub
2. prints the authorization URL and code
3. waits for login completion
4. stores the token locally

### 3. Start in foreground

```bash
llmproxy run
```

By default the server starts on:

```text
http://127.0.0.1:3015
```

### 4. Add a fallback Copilot provider

```bash
llmproxy provider:available
llmproxy provider:add backup --name "Backup Copilot"
llmproxy provider:list
llmproxy provider:status
llmproxy provider:order backup 1
llmproxy provider:rename backup "Backup EU"
```

### 5. Install as a persistent service

```bash
llmproxy service:start
```

Or, if you want global installation plus service activation in one step:

```bash
npm run install:persistent-it
```

For the same flow in English:

```bash
npm run install:persistent-en
```

On macOS this creates and loads a user `LaunchAgent`.
On Linux this creates and enables a `systemd --user` service.

### 6. Configure Claude Code with the desired model

```bash
llmproxy models:list
llmproxy claude:setup --model 2
```

### 7. Service status and logs

```bash
llmproxy status
llmproxy test
llmproxy test --all-providers
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
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "LLMPROXY_SHORT_ANSWER": "1"
  }
}
```

### Optional concise answers with `shortAnswer`

If you want shorter completions to save output tokens, you can enable concise-answer mode.

Project-level default in `.claude/settings.json`:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
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
- `shortAnswer: true` enables it only for one request.
- `shortAnswer: false` disables it for one request even if the project default is enabled.

### Provider-targeted model preferences and fallback chain

You can route different models to different providers directly from `ANTHROPIC_DEFAULT_MODEL` using a comma-separated list:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
    "ANTHROPIC_DEFAULT_MODEL": "copilot:gpt-5.4,kimi:kimi-k2.5",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  },
  "model": "llmProxy",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Glob|Grep",
        "hooks": [
          {
            "type": "command",
            "command": "[ -f graphify-out/graph.json ] && echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"graphify: Knowledge graph exists. Read graphify-out/GRAPH_REPORT.md for god nodes and community structure before searching raw files.\"}}' || true"
          }
        ]
      }
    ]
  }
}
```

How it works:

- `copilot:gpt-5.4,kimi:kimi-k2.5` means: use `gpt-5.4` when the active provider is Copilot, and use `kimi-k2.5` when the request falls back to Kimi.
- Provider fallback order follows your configured provider order (`llmproxy provider:list`). You can change priority with `llmproxy provider:order <providerId> <position>`.
- On retryable failures (for example `401`, `408`, `429`, many `5xx`, network errors, or invalid model errors), `llmProxy` moves to the next provider.
- `model` can be a UI label such as `llmProxy`; routing logic is driven by `ANTHROPIC_DEFAULT_MODEL` and provider defaults.

Example setup flow:

```bash
llmproxy provider:add default --name "Default GitHub Copilot" --model "gpt-5.4"
llmproxy provider:add kimi --provider kimi --api-key "$KIMI_API_KEY" --model "kimi-k2.5"
llmproxy provider:order default 1
llmproxy provider:order kimi 2
llmproxy provider:list
```

### Meaning of the variables

- `model`
  This is mainly the label Claude Code shows in the UI/session. You can keep it as `llmProxy`.

- `ANTHROPIC_BASE_URL`
  It must point to the `llmProxy` service. The default for this package is `http://127.0.0.1:3015`.
- `ANTHROPIC_DEFAULT_MODEL`
  Optional. Use it only when you want project-local routing overrides such as a single model or a provider chain like `copilot:gpt-5.4,kimi:kimi-k2.5`.
- `API_TIMEOUT_MS`
  You can keep a high timeout if you want to avoid premature timeouts on long tasks.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  Useful if you want more predictable behavior in Claude Code.
- `LLMPROXY_SHORT_ANSWER`
  Optional. Set it to `1`, `true`, `yes`, or `on` to ask llmProxy to inject a concise-answer instruction on every proxied inference for that project.

### Differences from other local configurations

If you were already using another local proxy or a previous Claude Code configuration, here are the important differences:

- `ANTHROPIC_BASE_URL` must point to the `llmProxy` service
- `model` can be a stable UI label (`llmProxy`) and does not need to match the routing chain
- `ANTHROPIC_DEFAULT_MODEL` should contain your explicit primary model or chain if you want deterministic routing
- PM2 is not needed: the persistent service is managed by the native service manager (`launchd` or `systemd --user`)

If `ANTHROPIC_DEFAULT_MODEL` is empty:

- `llmProxy` does not derive a provider chain from `model: llmProxy`.
- Routing falls back to request model and/or provider `default_model` values (if configured with `provider:add ... --model ...`).
- If neither is available, Copilot path falls back to the internal default mapped model.

Minimal example:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015"
  }
}
```

### Recommended sequence

1. install or start `llmProxy`
2. run `llmproxy login`
3. run `llmproxy service:start` or `llmproxy run`
4. run `llmproxy models:list`
5. run `llmproxy claude:setup --model <index>` in the project where you want to use Claude Code
6. reopen Claude Code or restart the tool session

## HTTP Endpoints

In addition to the core endpoints (`/health`, `/auth/status`, `/auth/logout`, `/v1/messages`), `llmProxy` also exposes REST endpoints for runtime CLI commands.

### Billing attribution context for `/v1/llm/*`

For platform-facing endpoints (`/v1/llm/messages`, `/v1/llm/chat/completions`) the caller must provide a complete hierarchy context for chargeback attribution.

Required fields in `X-Hierarchy-Context`:

- `master_company`
- `tenant_id`
- `client_id`
- `project_id`
- `scope_type`
- `scope_id`

Example:

```http
X-Hierarchy-Context: {"scope_type":"project","scope_id":"p-1","master_company":"mc-1","tenant_id":"t-1","client_id":"c-1","project_id":"p-1"}
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

```http
GET  /api/version
GET  /api/help
GET  /api/help?command=status
GET  /api/setup

POST /api/auth/login
POST /api/auth/logout

GET  /api/service/status
POST /api/service/start
POST /api/service/stop
POST /api/service/restart

GET  /api/logs
GET  /api/logs/stream
GET  /api/models
POST /api/test
POST /api/claude/setup

GET    /api/providers
GET    /api/providers/status
POST   /api/providers/{id}/login
POST   /api/providers/{id}/api-key
POST   /api/providers/order
POST   /api/providers/{id}/rename
DELETE /api/providers/{id}
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
| `llmproxy login` | `POST /api/auth/login` |
| `llmproxy logout` | `POST /api/auth/logout` |
| `llmproxy status` | `GET /api/service/status` |
| `llmproxy service:start` | `POST /api/service/start` |
| `llmproxy service:stop` | `POST /api/service/stop` |
| `llmproxy service:restart` | `POST /api/service/restart` |
| `llmproxy logs` | `GET /api/logs` |
| `llmproxy logs --follow` | `GET /api/logs/stream` |
| `llmproxy models:list` | `GET /api/models` |
| `llmproxy test` | `POST /api/test` |
| `llmproxy claude:setup --model <n>` | `POST /api/claude/setup` |
| `llmproxy provider:list` | `GET /api/providers` |
| `llmproxy provider:status` | `GET /api/providers/status` |
| `llmproxy provider:add <id> [--name <n>] [--vision <t|f>]` | `POST /api/providers/{id}/login` |
| `llmproxy provider:add <id> --api-key <key> --vision <t|f>` | `POST /api/providers/{id}/api-key` |
| `llmproxy provider:key <id> --api-key <key> [--vision <t|f>]` | `POST /api/providers/{id}/api-key` |
| `llmproxy provider:order <id> <position>` | `POST /api/providers/order` |
| `llmproxy provider:rename <id> <name>` | `POST /api/providers/{id}/rename` |
| `llmproxy provider:remove <id>` | `DELETE /api/providers/{id}` |

CLI-only commands without a dedicated REST wrapper:

- `llmproxy provider:available`
- `llmproxy stats`

## CLI Commands

### `llmproxy setup`

Prepares runtime directories and shows the selected service manager.

### `llmproxy login`

Runs the GitHub Copilot device flow and stores or updates the default provider `default`.

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

Runs a quick inference test against the local proxy by sending this fixed prompt:

```text
Ciao! rispondimi solo: ciao creatore
```

If the proxy responds correctly, the command prints only the text returned by the assistant.
It is useful for quickly checking that the local service is running and that the `/v1/messages` path is working.

Use `llmproxy test --all-providers` if you want to probe every configured provider instead of only the active one.
The command strips llmProxy metadata lines from the printed assistant text, so the terminal shows only the visible answer.

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

Shows the current fallback order of configured providers. For each provider, the vision capability is shown as `vision=true` or `vision=false`. For `qwen`, the saved plan is shown as `plan=subscription` or `plan=payg`.

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

Restarts the native persistent service.

### `llmproxy claude:setup`

Creates or updates `.claude/settings.json` in the current folder with the `env` variables required to use `llmProxy` as the local backend for Claude Code.

Supports `--model <index>` to set `ANTHROPIC_DEFAULT_MODEL` from the available model catalog.

### `llmproxy model:set <model>`

Quickly updates `model` and `env.ANTHROPIC_DEFAULT_MODEL` in the current project without re-running `claude:setup`.

Use it when you want to switch to a raw provider-aware value such as `deepseek:deepseek-v4-flash` or set an explicit chain such as `copilot:gpt-5.4,deepseek:deepseek-v4-flash`.

### `llmproxy update`

Updates the global `llmproxy` installation by cloning the latest version from the GitHub repository `alessiobacin/llmProxy` and reinstalling it globally.
After the update, it relaunches the updated binary with `llmproxy version` to verify that the new installation is active.
During the update, only one active global installation is kept, and any duplicate `pnpm` wrappers are removed.

On Linux systems where npm global is under `/usr/local` (owned by root), the command automatically detects the permission error and retries with `sudo`. There is no need to manually run `sudo llmproxy update`.

### `llmproxy install:persistent-it`

Explicit Italian path for persistent installation.

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
npm run install:persistent-it
```

If the CLI is already installed globally, you can use:

```bash
llmproxy install:persistent-it
```

The command installs the current CLI globally and enables the native persistent service for the OS.
When you use this command, the command output, dedicated help text, and error messages for this path are shown in Italian.

### `llmproxy install:persistent-en`

Explicit English path for persistent installation.

If you are working from the local checkout and do not yet have `llmproxy` in your `PATH`, run:

```bash
npm run install:persistent-en
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

### `llmproxy status`

Shows:

- detected service manager
- service status
- whether a Copilot token is present
- active provider
- configured fallback order

### `llmproxy provider:add <id> [--name <name>] [--api-key <key>]`

Adds a provider. For Copilot OAuth providers, starts the device flow. For API-key providers (openrouter, groq, anthropic, openai, deepseek, mistral, xai, perplexity, together, fireworks, kimi, zai), stores the supplied `--api-key` directly.

### `llmproxy provider:key <id> --api-key <key>`

Sets or replaces the API-key credential for an existing API-key provider.

### `llmproxy provider:list`

Shows the current fallback order of configured providers.

### `llmproxy provider:status`

Shows the active provider and the ordered list of providers with the current fallback state.

### `llmproxy provider:order <id> <position>`

### `llmproxy provider:remove <id>`

Removes the specified provider from the local registry.

### `llmproxy logs`

Shows the static tail of service stdout/stderr logs.

### `llmproxy logs --follow`

Follows logs in real time using the native service files.

### `llmproxy service:start`

Installs and starts the native persistent service.

On macOS the service restarts after reboot when the user session is loaded.
It is not a global system daemon: it runs in the user context.

### `llmproxy service:stop`

Stops the native persistent service.

### `llmproxy service:restart`

Restarts the native persistent service.

### `llmproxy claude:setup`

Creates or updates `.claude/settings.json` in the current folder with the `env` variables required to use `llmProxy` as the local backend for Claude Code.

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
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7045",
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
| `LLMPROXY_SMART_ROUTE` | `rules`, `llm`, `hybrid`, disabled | disabled | Routing mode: `rules` uses static heuristics, `llm` uses classifier only, `hybrid` combines both |
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
- `smart-router.json`
- `logs/service.out.log`
- `logs/service.err.log`
- `logs/requests-YYYY-MM-DD.jsonl`

`copilot-token.json` stores both the default provider and any additional Copilot providers together with their fallback order.
`copilot-models.json` stores the latest model catalog fetched from the GitHub Copilot live endpoint.

## Environment Variables

See also [.env.example](.env.example).

| Variable | Default | Usage |
| --- | --- | --- |
| `PORT` | `3015` | proxy port |
| `HOST` | `127.0.0.1` | server bind host |
| `LLMPROXY_HOME` | auto | runtime data directory |
| `LLMPROXY_LOG_RETENTION_DAYS` | `7` | JSONL log retention |
| `LLMPROXY_LOG_MAX_BYTES` | `5242880` | maximum size of a JSONL log file before rotation |
| `LLMPROXY_LOG_MAX_FILES` | `5` | maximum number of archived JSONL log files per day |

## Persistence After Reboot

### macOS

The `llmproxy service:start` command installs a user `LaunchAgent`.
This means:

- the service becomes available again after reboot
- it restarts when the user session is loaded
- it does not require PM2
- it does not start before the user logs in

If you use `npm run install:persistent`, the command first installs the CLI globally and then registers the same `LaunchAgent`, so restart after reboot keeps working.

### Linux

The `llmproxy service:start` command installs a `systemd --user` service.

Practical note:

- in many environments the user service starts when the user logs in
- if you need persistence even without a graphical or shell login, you may need to configure `linger`

With the one-shot bootstrap:

```bash
npm run install:persistent
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

### `llmproxy login` fails

- verify that you are connected to the Internet
- run the command again and complete the GitHub device flow
- if the token expired, use `llmproxy logout` and then `llmproxy login`

### The proxy responds with `authentication_error`

The local token is missing or no longer valid:

```bash
llmproxy login
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
