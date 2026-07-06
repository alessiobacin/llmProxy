# llmProxy Postman Kit

English:
This folder contains everything you need to exercise the llmProxy HTTP endpoints, including the ones that wrap CLI commands.

Italiano:
Questa cartella contiene tutto il necessario per provare gli endpoint HTTP di llmProxy, inclusi quelli che fanno da wrapper ai comandi CLI.

## Contenuto

- `llmproxy.endpoints.postman_collection.json`
  Collection completa con copertura di tutti gli endpoint esposti da `lib/app.js`.
- `llmproxy.local.postman_environment.json`
  Environment locale con variabili base (`baseUrl`, `hierarchyContext`, `traceId`, ecc.).

## Import in Postman

1. Apri Postman.
2. Importa prima l'environment `llmproxy.local.postman_environment.json`.
3. Importa la collection `llmproxy.endpoints.postman_collection.json`.
4. Seleziona l'environment `llmProxy Local`.

## Prerequisiti

1. Avvia llmProxy in locale. L'environment incluso punta al profilo installato/Docker su `http://127.0.0.1:7045`; se stai usando il server di sviluppo repo-local cambia `baseUrl` a `http://127.0.0.1:5045`.
2. Per test LLM reali, assicurati che ci sia almeno un provider valido configurato. Copilot non e` obbligatorio: va bene anche un provider API-key.
3. Per endpoint `/v1/llm/*`, fornisci un `HierarchyContext` valido.

## Billing context richiesto su /v1/llm/*

Le chiamate platform API `/v1/llm/*` richiedono contesto gerarchico valido per attribuzione costi.

Regole principali:

Ogni scope richiede `master_company` + il proprio ID primario. I parent IDs (`tenant_id`, `client_id`) sono **opzionali** e indicano il livello gerarchico — se forniti devono essere non vuoti.

| scope_type | Livello gerarchia | Campi obbligatori |
|---|---|---|
| `master` | — | `master_company` |
| `agency` | — | `master_company`, `tenant_id` |
| `client` | direttamente sotto master_company | `master_company`, `client_id` |
| `client` | sotto agency/tenant | `master_company`, `tenant_id`, `client_id` |
| `project` | direttamente sotto master_company | `master_company`, `project_id` |
| `project` | sotto agency/tenant | `master_company`, `tenant_id`, `project_id` |
| `project` | sotto client di agency | `master_company`, `tenant_id`, `client_id`, `project_id` |
| `user` | livello master | `master_company`, `user_id` |
| `user` | sotto agency/tenant | `master_company`, `tenant_id`, `user_id` |
| `user` | sotto client | `master_company`, `tenant_id`, `client_id`, `user_id` |

In caso di assenza contesto: `HIERARCHY_CONTEXT_REQUIRED` (400)
In caso di contesto incompleto: `HIERARCHY_CONTEXT_INVALID` (400)

## Copertura collection

La collection è organizzata in 4 cartelle:

1. `01 - Runtime Base Endpoints`
2. `02 - API endpoints equivalent to CLI commands`
3. `03 - LLM Compatibility (Standalone-friendly)`
4. `04 - LLM Platform API (/v1/llm/*)`

## Mappa CLI ↔ Endpoint API

- `version` → `GET /api/version`
- `help` / `help <command>` → `GET /api/help`
- `setup` → `GET /api/setup`
- `login` (legacy alias for Copilot only) → `POST /api/auth/login`
- `logout` → `POST /api/auth/logout`
- `status` → `GET /api/service/status`
- `service:start` → `POST /api/service/start`
- `service:stop` → `POST /api/service/stop`
- `service:restart` → `POST /api/service/restart`
- `service:runtime` → `POST /api/service/runtime`
- `logs` → `GET /api/logs`
- `models:list` → `GET /api/models`
- `test` → `POST /api/test`
- `claude:setup` → `POST /api/claude/setup`
- `config:list` → `GET /api/config`
- `config:get` → `GET /api/config/:key`
- `config:set` → `POST /api/config/:key`
- `config:unset` → `DELETE /api/config/:key`
- `provider:add` (Copilot/OAuth only) → `POST /api/providers/:id/login`
- `provider:add --api-key` / `provider:key` → `POST /api/providers/:id/api-key`
- `provider:list` → `GET /api/providers`
- `provider:status` → `GET /api/providers/status`
- `provider:order` → `POST /api/providers/order`
- `provider:rename` → `POST /api/providers/:id/rename`
- `provider:remove` → `DELETE /api/providers/:id`

Comandi solo CLI, senza endpoint REST equivalente diretto:

- `provider:available`
- `stats`

Endpoint non equivalenti alla CLI (solo API runtime/platform):

- `GET /health`
- `GET /auth/status`
- `POST /auth/logout`
- `GET /api/logs/stream` (SSE)
- `POST /v1/messages`
- `POST /v1/chat/completions`
- `GET /v1/llm/health`
- `POST /v1/llm/messages`
- `POST /v1/llm/chat/completions`
- `GET/POST/DELETE /v1/llm/providers`

## Note operative

- La request `GET /api/logs/stream` è SSE: nel runner di Postman può restare aperta, quindi conviene eseguirla singolarmente.
- I test della collection usano assert tolleranti (`200/400`, `200/401`) per accomodare ambienti autenticati e non autenticati.
- `GET /auth/status` now reports `authenticated=true` when at least one provider is configured, including API-key providers. It is no longer Copilot-only.
- Le risposte LLM riuscite tramite llmProxy aggiungono una riga iniziale con provider/modello effettivamente usati e un footer finale con le statistiche token della richiesta. La collection lo verifica su `POST /v1/messages`.
- La request `POST /v1/messages` puo` includere `shortAnswer: true` per chiedere una risposta piu` concisa; in alternativa puoi renderlo il default del progetto con `LLMPROXY_SHORT_ANSWER=1` in `.claude/settings.json`.
- Per testare la configurazione via REST, imposta `configScope` a `project`, `global` oppure `service`. Esempio: `configScope=global`, `configKey=LLMPROXY_LLM_STATS_API_KEY`, `configValue=your-free-key`, poi ripeti la request `POST /api/config/:key`.
- Per testare le notifiche progetto, prova `configKey=LLMPROXY_SENDGRID_TO_MESSAGE_TYPE` e `configValue=service_unreachable,provider_error`.
- `scope=global` scrive e legge i default utente in `~/.claude/settings.json`; `scope=project` lavora nel `.claude/settings.json` del progetto corrente; `scope=service` agisce sulla configurazione persistente del servizio.
- La request `POST /api/claude/setup` usa un indice numerico (`claudeSetupModelIndex`) coerente con la CLI attuale, non il nome raw del modello.
- Le request `GET /api/config` e `GET /api/config/:key` restituiscono i valori effettivi della configurazione, quindi includono anche i default risolti da llmProxy quando una chiave non e` stata persistita esplicitamente.
- La request `POST /v1/llm/providers` salva automaticamente l'id in `providerEntryId` per la request di delete successiva.
