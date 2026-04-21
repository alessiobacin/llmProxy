# llmProxy

`llmProxy` is a standalone package that exposes a GitHub Copilot proxy with an Anthropic-compatible `/v1/messages` endpoint plus a global CLI for login, startup, status, logs, persistent service management, and fallback across multiple GitHub Copilot accounts.

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
  "model": "claude-opus-4.5",
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "proxy-local",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
    "ANTHROPIC_DEFAULT_MODEL": "claude-opus-4.5",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  }
}
```

### Meaning of the variables

- `model`
  This is the model Claude Code considers active in the session and displays in the UI. It must match the model you want to route through `llmProxy`.

- `ANTHROPIC_AUTH_TOKEN`
  With `llmProxy` this can be any non-empty placeholder value, for example `proxy-local`.
- `ANTHROPIC_BASE_URL`
  It must point to the `llmProxy` service. The default for this package is `http://127.0.0.1:3015`.
- `ANTHROPIC_DEFAULT_MODEL`
  It must be a model supported by GitHub Copilot. You can get it from `llmproxy models:list`.
- `API_TIMEOUT_MS`
  You can keep a high timeout if you want to avoid premature timeouts on long tasks.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  Useful if you want more predictable behavior in Claude Code.

### Differences from other local configurations

If you were already using another local proxy or a previous Claude Code configuration, here are the important differences:

- `ANTHROPIC_BASE_URL` must point to the `llmProxy` service
- `model` and `ANTHROPIC_DEFAULT_MODEL` should have the same value if you want the Claude Code UI, canonical request, and logs to stay aligned
- `ANTHROPIC_DEFAULT_MODEL` must be a valid GitHub Copilot model
- PM2 is not needed: the persistent service is managed by the native service manager (`launchd` or `systemd --user`)

Minimal example:

```json
{
  "model": "claude-sonnet-4.5",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
    "ANTHROPIC_DEFAULT_MODEL": "claude-sonnet-4.5"
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

### Anthropic-compatible proxy

```http
POST /v1/messages
```

Minimal example body:

```json
{
  "model": "claude-sonnet-4-5",
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

### `llmproxy provider:add <id> [--name <name>]`

Runs a new GitHub Copilot login and stores an additional provider identified by `id`.

### `llmproxy provider:list`

Shows the current fallback order of configured Copilot providers.

### `llmproxy provider:status`

Shows the active provider and the ordered list of Copilot providers with the current fallback state.

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

### `llmproxy update`

Updates the global `llmproxy` installation by cloning the latest version from the GitHub repository `alessiobacin/llmProxy` and reinstalling it globally.
After the update, it relaunches the updated binary with `llmproxy version` to verify that the new installation is active.
During the update, only one active global installation is kept, and any duplicate `pnpm` wrappers are removed.

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

### `llmproxy provider:add <id> [--name <name>]`

Runs a new GitHub Copilot login and stores an additional provider identified by `id`.

### `llmproxy provider:list`

Shows the current fallback order of configured Copilot providers.

### `llmproxy provider:status`

Shows the active provider and the ordered list of Copilot providers with the current fallback state.

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