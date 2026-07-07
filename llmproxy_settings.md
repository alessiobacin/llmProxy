# llmProxy settings

This file documents only `LLMPROXY_*` variables. Non-llmProxy settings such as `CLAUDE_CODE_*`, `ANTHROPIC_*`, `HOST`, `PORT`, `NODE_ENV`, `DBLAYER_URL`, or `SENDGRID_*` are intentionally excluded here.

For each variable, this file states:

- whether the variable may be omitted
- what value is assumed when it is omitted
- an example value

## `LLMPROXY_AUTO_ESCALATE`

This controls retry escalation after repeated failures on the same task. It does not optimize for price on the first attempt; it helps the proxy move to a stronger fallback after the current path has proven ineffective.

May be omitted: yes.  
Value when omitted: effectively off, usually treated as `0`.  
Example: `LLMPROXY_AUTO_ESCALATE=1`

## `LLMPROXY_DOCKER_COMPOSE_FILE`

This points to the Docker Compose file used when the service runtime is `docker`. It matters only for Docker-managed persistent installs.

May be omitted: yes.  
Value when omitted: the built-in compose file path is used automatically.  
Example: `LLMPROXY_DOCKER_COMPOSE_FILE=docker-compose.production.yml`

## `LLMPROXY_DOCKER_POLL_MS`

This sets how often the Docker runtime checks container health and status.

May be omitted: yes.  
Value when omitted: the runtime default is used automatically.  
Example: `LLMPROXY_DOCKER_POLL_MS=30000`

## `LLMPROXY_DOCKER_SERVICE`

This is the service name inside the Compose file. It is only relevant when `LLMPROXY_SERVICE_RUNTIME=docker`.

May be omitted: yes.  
Value when omitted: `llmproxy`.  
Example: `LLMPROXY_DOCKER_SERVICE=llmproxy`

## `LLMPROXY_ENV`

This selects the llmProxy environment: development, staging, or production. It is used to derive defaults and runtime behavior.

May be omitted: yes.  
Value when omitted: automatic, based on the runtime/profile resolution logic.  
Example: `LLMPROXY_ENV=production`

## `LLMPROXY_GLOBAL_SERVICE`

This enables the reserved-port global service behavior.

May be omitted: yes.  
Value when omitted: off, effectively `0`.  
Example: `LLMPROXY_GLOBAL_SERVICE=1`

## `LLMPROXY_HOME`

This is the llmProxy runtime data directory. It affects where tokens, service data, and runtime state are stored.

May be omitted: yes.  
Value when omitted: an OS-specific default path is used automatically.  
Example: `LLMPROXY_HOME=/Users/alessio/Library/Application Support/llmProxy`

## `LLMPROXY_HOST_PROJECTS_ROOT`

This is mainly useful in Docker-based setups, where the host projects root needs to be mounted into the container.

May be omitted: yes.  
Value when omitted: an OS-specific default is inferred automatically.  
Example: `LLMPROXY_HOST_PROJECTS_ROOT=/Users`

## `LLMPROXY_INFERENCE_INFO_INLINE`

This prepends the selected provider/model information inline in the response. It is useful when you want to see exactly what the proxy used.

May be omitted: yes.  
Value when omitted: for project settings, effectively off, so `0`.  
Example: `LLMPROXY_INFERENCE_INFO_INLINE=1`

## `LLMPROXY_LOCALE`

This controls the language of install/update CLI messaging where locale support exists.

May be omitted: yes.  
Value when omitted: automatic locale selection.  
Example: `LLMPROXY_LOCALE=en`

## `LLMPROXY_LOG_MAX_BYTES`

This sets the maximum size of a JSONL log file before rotation happens.

May be omitted: yes.  
Value when omitted: `5242880`.  
Example: `LLMPROXY_LOG_MAX_BYTES=5242880`

## `LLMPROXY_LOG_MAX_FILES`

This limits how many rotated log files are retained.

May be omitted: yes.  
Value when omitted: `5`.  
Example: `LLMPROXY_LOG_MAX_FILES=5`

## `LLMPROXY_LOG_RETENTION_DAYS`

This controls log retention. Development/staging and production may use different runtime defaults.

May be omitted: yes.  
Value when omitted: typically `7` in development/staging and `30` in production.  
Example: `LLMPROXY_LOG_RETENTION_DAYS=30`

## `LLMPROXY_METERING_INLINE`

This appends metering/token information inline in the response.

May be omitted: yes.  
Value when omitted: for project settings, effectively off, so `0`.  
Example: `LLMPROXY_METERING_INLINE=1`

## `LLMPROXY_MODE`

This chooses the runtime mode of the proxy. In most local setups, `standalone` is the correct choice.

May be omitted: yes.  
Value when omitted: `standalone`.  
Example: `LLMPROXY_MODE=standalone`

## `LLMPROXY_MONGODB_CONNECTION_STRING`

This is the complete MongoDB connection string used for local metering/log persistence when the proxy runs in `standalone` mode. If `LLMPROXY_MODE=platform`, the platform services take priority instead.

May be omitted: yes.  
Value when omitted: unset, meaning MongoDB-backed persistence is not configured.  
Example: `LLMPROXY_MONGODB_CONNECTION_STRING=mongodb://user:password@localhost:27017/llmproxy`

## `LLMPROXY_PRICE_PERFORMANCE_ROUTING`

This enables the first-attempt reordering that prefers cheaper options, with special preference for free models when available. This is the variable that affects cost-aware initial ranking.

May be omitted: yes.  
Value when omitted: off, effectively `0`.  
Example: `LLMPROXY_PRICE_PERFORMANCE_ROUTING=1`

## `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER`

This is used only when price/performance routing is enabled and multiple candidates have the same effective cost. It decides whether the proxy should prefer the stronger model or the faster one.

May be omitted: yes.  
Value when omitted: `power`.  
Example: `LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER=speed`

## `LLMPROXY_PROVIDER_CREDIT_INLINE`

This exposes provider credit or pricing information inline when such information is available.

May be omitted: yes.  
Value when omitted: effectively off, so `0`.  
Example: `LLMPROXY_PROVIDER_CREDIT_INLINE=1`

## `LLMPROXY_RUNTIME_PROFILE`

This is the higher-level profile selector used to derive several runtime defaults together.

May be omitted: yes.  
Value when omitted: automatic profile resolution.  
Example: `LLMPROXY_RUNTIME_PROFILE=production`

## `LLMPROXY_SECRET`

This is the optional HMAC secret used for internal signing/security-sensitive flows.

May be omitted: yes.  
Value when omitted: unset, meaning no explicit secret is configured.  
Example: `LLMPROXY_SECRET=replace-with-a-real-secret`

## `LLMPROXY_SERVICE_RUNTIME`

This selects whether the persistent service runs natively or under Docker.

May be omitted: yes.  
Value when omitted: automatic/default runtime selection, usually `native`.  
Example: `LLMPROXY_SERVICE_RUNTIME=docker`

## `LLMPROXY_SHORT_ANSWER`

This controls concise-answer behavior. The setting is intentionally numeric because different compactness behaviors may exist.

May be omitted: yes.  
Value when omitted: `0`, meaning off.  
Example: `LLMPROXY_SHORT_ANSWER=1`
