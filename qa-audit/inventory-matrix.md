# Inventario canonico QA full-audit — llmproxy

- Task: T1 matrice inventario comandi/funzionalità/endpoint/flag (playbook qa-full-audit)
- Run: `01M17YH0KKC1CSYRJYVZKSNMMK` — Spec: `01M17YH7QZQJEHMM3H9CXKMVEC`
- Worktree: `/Users/alessiobacin/Development/Modules-platform-implementation/llmProxy/.worktrees/qa-full-audit`
- Autore: `qa-inventory-analyst-01`
- Date: 2026-08-29
- Ambiente di verifica (contratto): dev locale `127.0.0.1:5045`, `NODE_ENV=development`, MongoDB sandbox `llmproxy_qa` su 27017, `LLMPROXY_HOME` temporaneo nel worktree. Produzione (7045/7046) off-limits.
- Versione attesa: `llmproxy version` = `0.3.119` (package.json).
- Convenzione: nessuna voce è "verificata" — questo documento è il **contratto** per qa-functional-verifier. Colonna Fonte = dove è dichiarato; colonna "Test esistente" = copertura automatica presente nel repo (non esito).

## 1. Matrice canonica

### 1.1 Comandi CLI (`bin/llmproxy.js` / `llmproxy`, alias `llmp`)

| ID | Voce | Fonte | Risultato atteso (output/exit/effetto/invariante) | Mutante? | Note |
|---|---|---|---|---|---|
| C-01 | `llmproxy help` / `--help` / `-h`/`help <cmd>` | help reale; README §Help+§Alias; cli.js COMMAND_HELP | guida completa, exit 0; `help <cmd>` scheda dettagliata (exit 0; 1 se non documentato) | no | — |
| C-02 | `llmproxy version` / `--version` / `-v` | help reale; README §version; cli.js | stampa `0.3.119`, exit 0 | no | — |
| C-03 | `llmproxy setup` | help reale; README §setup; cli.js | `Runtime root: <dataRoot>` + `Service manager: <kind>`, exit 0; crea dir runtime se assenti | sì (dir runtime) | — |
| C-04 | `llmproxy release-notes [--version <v>] [--locale <it\|en>]` | cli.js COMMAND_HELP | changelog per versione/locale su stdout, exit 0; locale default da env/install-locale | no | non in README EN/IT |
| C-05 | `llmproxy login` | README-IT §login; cli.js | warning legacy + device flow GitHub (URL+code), exit 0 a completamento | sì (token copilot) | — |
| C-06 | `llmproxy logout` | README-IT §logout; cli.js | rimuove token/registry (`clear()`), exit 0 | sì (removes copilot-token.json) | — |
| C-07 | `llmproxy run` | help reale; README §run; server.js | proxy dev foreground `127.0.0.1:5045`, `llmProxy listening on http://127.0.0.1:5045`; bloccante | sì (processo 5045) | — |
| C-08 | `llmproxy stop` | help reale; README §stop; cli.js | termina solo istanza dev 5045 (non servizio persistente), exit 0 anche senza istanza | sì (stato processo) | — |
| C-09 | `llmproxy status [--docker]` | help reale; README §status; cli.js | manager, stato servizio, token presence, provider attivo, fallback order; `--docker` mostra container | no | — |
| C-10 | `llmproxy models:list` / `--all-providers`(`--all`) | README §models:list; cli.js | lista numerata `idx. provider:model (credit=.., coding=.., bench=..)`; senza provider → stderr+exit 1; con live catalog → aggiorna cache | sì (cache copilot-models.json) | — |
| C-11 | `llmproxy test` | README §test; cli.js | probe provider attivo: `ok`/`fail`; exit 0/1; senza provider → errore+1 | sì (metering+request logs) | — |
| C-12 | `llmproxy test -i/--inference` | README §test; cli.js | inferenza reale prompt fisso; stampa provider/modello + `response:`; exit 0; fallback rotti in `-i --all-providers` → `invalid fallback`+exit 1 | sì (metering+request logs) | — |
| C-13 | `llmproxy test --all-providers` | README §test; cli.js | una riga per provider; `-i` valida fallback dopo il winner | sì (metering+request logs) | — |
| C-14 | `llmproxy test --proxy <url>` / `--provider <id>` | README §provider:test; cli.js | forza proxy specifico / provider singolo (id o indice) | sì (metering+request logs) | — |
| C-15 | `llmproxy stats` | README §stats; cli.js; metering-dblayer | report aggregato (total, success, fail, token, by-provider, by-model), exit 0 | no | — |
| C-16 | `llmproxy stats:reset [--hard]` | help reale; cli.js | tronca `logs/metering.jsonl` → `Statistiche azzerate: metering.` exit 0; senza file → `Nessun file…` exit 0; `--hard` dichiara reset cache smart-router+auto-rank (impl: no-op oltre metering — vedi A-02) | sì (svuota metering.jsonl) | `--hard` NON coerente doc/help vs impl |
| C-17 | `llmproxy logs` | help reale; README §logs | tail stdout/stderr servizio + ultimo `requests-*.jsonl`; vuoto → `Nessun log disponibile.` exit 0 | no | — |
| C-18 | `llmproxy logs --follow` | help reale; README §logs | segue flussi in tempo reale (file nativi); bloccante per il terminale | no | mai via REST (vedi A-03) |
| C-19 | `llmproxy service:start` | help; README §service:start | installa+avvia servizio persistente (native/docker), health check; exit 0; prerequisiti mancanti → remediation+exit 1 | sì (unit servizio+config+container) | — |
| C-20 | `llmproxy service:stop` | help; README §service:stop | ferma servizio persistente; exit 0 | sì (stato servizio) | — |
| C-21 | `llmproxy service:restart` | README §service:restart | riavvia servizio; docker profile → valida/recrea container; health finale; exit 0 | sì (riavvio) | — |
| C-22 | `llmproxy service:runtime <docker\|native\|launchd\|systemd>` | README §service:runtime; cli.js | switch netto runtime: pulizia precedente, persiste `LLMPROXY_SERVICE_RUNTIME`, health check, exit 0 | sì (runtime persistente+artefatti) | launchd/systemd alias OS-specific |
| C-23 | `llmproxy provider:add <id> [--name] [--api-key] [--model] [--vision] [--plan] [--free-model] [--proxy [<url>]] [--proxy-key]` | README §provider:add+§Proxy; help; cli.js | registra provider (API-key: `--vision` obbligatorio; copilot: device flow; qwen `--plan` valida; `--proxy` nudo=rotazione); senza id → usage+1 | sì (registry copilot-token.json) | REST `/api/providers/:id/api-key` forza `vision=true` default (A-04) |
| C-24 | `llmproxy provider:key <id> --api-key <k> [--model] [--vision] [--plan] [--free-model]` | README §provider:key | aggiorna solo la API key (vision preservata se omessa); exit 0/1 | sì (credenziale registry) | — |
| C-25 | `llmproxy provider:available` | README §provider:available; help | elenco provider supportati (id/alias/auth); exit 0 | no | — |
| C-26 | `llmproxy provider:list` | README §provider:list (EN+IT) | fallback order; `model=..,credit=..,coding=..,price=..,best=..,bench=..,vision=..,plan=..`; chain effettiva con override `ANTHROPIC_DEFAULT_MODEL` | no | — |
| C-27 | `llmproxy provider:status` | README-IT §provider:status; help | provider attivo + stato sintetico ordinato; exit 0 | no | — |
| C-28 | `llmproxy provider:usage` | help reale; cli.js | consumo token giornaliero/settimanale/mensile per provider/modello; exit 0 | no | non in README EN/IT |
| C-29 | `llmproxy provider:order <id> <pos>` | README §provider:order; token-store | sposta provider; exit 0; id inesistente → `Provider non trovato`+1 | sì (ordine registry) | — |
| C-30 | `llmproxy provider:reorder` | README §provider:reorder (EN+IT); HANDOFF | ciclo immediato se `LLMPROXY_REORDERING` set (criteri, ordine, score); senza → `non configurato`; persiste ordine | sì (ordine registry) | — |
| C-31 | `llmproxy provider:rename <id> <name>` | README §provider:rename; cli.js | aggiorna display name; exit 0/1 | sì (name registry) | — |
| C-32 | `llmproxy provider:update <id> [--vision] [--free-model] [--name]` | help (COMMAND_HELP); app.js PATCH | patch flags senza toccare credenziali/modello; valori non booleani → errore+1 | sì (metadati registry) | — |
| C-33 | `llmproxy provider:remove <id>` | README §provider:remove | rimuove provider; exit 0; inesistente → errore | sì (entry registry) | — |
| C-34 | `llmproxy provider:test [--vision] [--all-proxies] [--proxy <url>] [--provider <id>]` | README §provider:test (IT); README §Proxy; help | inferenza testuale; `--vision` immagini; `--all-proxies` coppie provider×proxy; 429 = reachable; ≥1 coppia fail → exit 1 | sì (metering+request logs) | — |
| C-35 | `llmproxy proxy:add <url> [--name <n>]` | README §Proxy Registry; help; proxy-store | registra proxy (id=dominio); senza url → usage+1; exit 0 | sì (proxy registry) | nessun test CLI diretto |
| C-36 | `llmproxy proxy:list` | README §Proxy Registry; cli.js | elenco proxy in ordine failover; vuoto → `Nessun proxy registrato.` exit 0 | no | nessun test CLI diretto |
| C-37 | `llmproxy proxy:remove <id>` | README §Proxy Registry; cli.js | rimuove per id; inesistente → exit 1 | sì (proxy registry) | nessun test CLI diretto |
| C-38 | `llmproxy proxy:reorder <id1> <id2> …` | README §Proxy Registry; cli.js | `Ordine proxy aggiornato.` exit 0; <2 proxy o id non validi → usage/errore | sì (ordine proxy registry) | nessun test CLI diretto |
| C-39 | `llmproxy proxy:test` | README §Proxy Registry; cli.js | probe 3 host per proxy; `Risultati: N pass, M fail`; ≥1 fail → exit 1 | no (solo fetch di rete) | nessun test CLI diretto |
| C-40 | `llmproxy model:set <model>` | README §model:set | aggiorna `model`+`env.ANTHROPIC_DEFAULT_MODEL` in `.claude/settings.json`; vuoto → errore+1; prod-profile → base URL 7045 | sì (settings progetto) | — |
| C-41 | `llmproxy claude:setup [--model <indice>]` | README §claude:setup; README-IT §6 | crea/merge `.claude/settings.json`; `ANTHROPIC_AUTH_TOKEN` solo in globale `~/.claude/settings.json`; indice non numerico → errore | sì (settings progetto+globale) | — |
| C-42 | `llmproxy pi:setup` | README §pi:setup; help; cli.js | scrive `.pi/models.json` (anthropic-messages, baseUrl locale, apiKey `proxy-local`) + `.pi/settings.json` (`defaultProvider/Model: llmproxy`); exit 0 | sì (file .pi) | nessun test diretto |
| C-43 | `llmproxy vscode-chat:setup` | help (COMMAND_HELP); cli.js | scrive `chatLanguageModels.json` VS Code (vendor openai, URL `${baseUrl}/v1`, tutti i modelli), sostituisce entry llmproxy; exit 0 | sì (config VS Code) | nessun test diretto |
| C-44 | `llmproxy vscode-claude:setup [--model <indice>]` | help (COMMAND_HELP); cli.js | configura Claude Code in VS Code (come claude:setup, `omitAuthToken`); exit 0 | sì (config VS Code) | nessun test diretto |
| C-45 | `llmproxy config:list [--project\|--global\|--service\|--scope <scope>]` | README §config:list; cli.js | sezioni project/global/service con valori effettivi; fuori progetto → solo service; exit 0 | no | — |
| C-46 | `llmproxy config:get <key> [--scope …]` | README §config:get | legge valore effettivo; exit 0 | no | — |
| C-47 | `llmproxy config:set <key> <value> [--scope …]` | README §config:set+service; cli.js; configuration.js | scrive valore; chiave fuori catalogo (CONFIG_SPECS) → errore+1; scope mismatch → errore+1; `LLMPROXY_MODE=platform` valida db-layer/event-bus; **CLI non riavvia** (solo REST) | sì (settings/service config) | REST restartRequired → auto service:restart (vedi E-30) |
| C-48 | `llmproxy config:unset <key> [--scope …]` | README §config:unset | rimuove override; exit 0 | sì (rimozione chiave) | — |
| C-49 | `llmproxy config:migrate` | cli.js (solo codice) | migra chiavi legacy → nomi supportati; `Config migration completed: …/no changes` exit 0 | sì (riscrittura config) | non in help/README |
| C-50 | `llmproxy update` | README §update (EN+IT); cli.js | clone→reinstall globale→smoke (`version`,`config:list`,`status`)→riavvio; rollback se smoke fail; killa 7045; una installazione attiva | sì (package globale+servizio+config) | — |
| C-51 | `llmproxy install:persistent-it` | README §install:persistent-it; help; cli.js | install globale + servizio nativo, output **IT**; preflight fail → remediation+1; Linux linger note | sì (install+unit+install-locale.txt+config) | — |
| C-52 | `llmproxy install:persistent-en` / `llmproxy install` | README §install:persistent-en+§install | idem, output **EN**; `install` = alias en | sì (idem) | — |
| C-53 | `llmproxy install:persistent` (alias legacy) | help reale; README §Alias; package.json | = percorso **IT** | sì (idem) | — |
| C-54 | `llmproxy uninstall` | README §uninstall; cli.js | ferma servizio, rimuove unit, docker down, **rimuove data root**, uninstall package; `Disinstallazione completata.` exit 0 | sì (rimozione totale) | — |
| C-55 | Alias brevi `llmp <alias>` (h,su,v,rn,up,un,in,li,lo,sto,st,sa,lg,t,p:*,c:*,sv:*,m:l,m:s,cc:s,pi:s,vsc:*,sa:r,in:*,px:*) | help reale; cli.js SHORT_COMMAND_ALIASES | espansione = comando full (stesso contratto) | = comando espanso | — |

### 1.2 Endpoint HTTP (`lib/app.js`, gateway files; porte 5045/6045/7045)

| ID | Voce | Fonte | Risultato atteso (status/body/note) | Mutante? | Note |
|---|---|---|---|---|---|
| E-01 | `GET /health` | README §Health; app.js; manifest | 200 `{ok:true, authenticated:<bool>}` (tutti i mode) | no | — |
| E-02 | `GET /auth/status` | README §Local auth status; openapi | 200 `{authenticated:<bool>}` | no | — |
| E-03 | `POST /auth/logout` | README §Local logout; app.js | 200 `{ok:true}`; clear tokens | sì | downstream: E-02, E-17, C-10, C-25 |
| E-04 | `POST /v1/messages` | README §Anthropic proxy; openapi; manifest | Anthropic Messages; fallback; shortAnswer; streaming; metadata inline; 200/400/401/503; x-project-path header | sì (metering+request logs+demote) | — |
| E-05 | `POST /v1/chat/completions` | app.js (legacy); openapi: assente | OpenAI-shaped; `stream:true` → **501 STREAM_NOT_IMPLEMENTED** | sì (idem E-04) | non in README/openapi |
| E-06 | `POST /v1/llm/messages` | README §Billing; openapi; manifest | come E-04 + **HierarchyContext obbligatoria** (400 se assente/invalida) | sì (idem) | — |
| E-07 | `POST /v1/llm/chat/completions` | app.js (canonical) | come E-05 + enforce hierarchy | sì (idem) | non in openapi |
| E-08 | `GET /v1/llm/health` | manifest; openapi | 200 `{ok,mode,authenticated,providers[],manifest_version:"v11"}` | no | — |
| E-09 | `GET /v1/llm/providers` | app.js (codice) | 200 `{entries:[…]}`; filter scope_type/scope_id/provider | no | non in openapi |
| E-10 | `POST /v1/llm/providers` | app.js (codice) | 201 entry; platform: HC richiesta (400) + admin/owner (403 AUTH_REQUIRED) | sì (provider-registry.json) | non in openapi |
| E-11 | `DELETE /v1/llm/providers/:id` | app.js (codice) | 204; 404 NOT_FOUND; platform: HC richiesta | sì (registry) | non in openapi |
| E-12 | `GET /v1/models` | openapi /v1/models; app.js; commit 4fae96c | 200 `{object:"list", data:[{id:"<provider>:<model>",…}]}` | no | README non la documenta |
| E-13 | `GET /v1/models/:modelId` | openapi; app.js | 200 entry; 404 `model '<id>' not found`; mancante → 400 | no | — |
| E-14 | `GET /v1/llm/metering` | README §Metering; openapi | 200 `{records,total,limit,offset,order}`; standalone → **404 NOT_AVAILABLE**; param invalidi → 400 | no | solo lettura (platform) |
| E-15 | `GET /v1/llm/metering/stats` | README §Metering; openapi | 200 aggregati; standalone → 404 | no | — |
| E-16 | `GET /api/version` | README §Runtime API; app.js | 200 payload CLI-style `{success,exitCode,data.output,data.version}` | no | — |
| E-17 | `GET /api/help [?command=]` | README §Runtime API | 200 CLI-style | no | — |
| E-18 | `GET /api/setup` | README §Runtime API | 200 CLI-style | no | — |
| E-19 | `GET /api/release-notes [version][locale]` | openapi; app.js | 200 CLI-style | no | — |
| E-20 | `POST /api/auth/login` | README §Runtime API | == `provider:add copilot` (device flow) | sì (token copilot) | — |
| E-21 | `POST /api/auth/logout` | README §Runtime API | == `logout` | sì (clear tokens) | — |
| E-22 | `GET /api/service/status` | README §Runtime API | == `status` | no | — |
| E-23 | `POST /api/service/start` | README §Runtime API; openapi? (non doc) | == `service:start` | sì (servizio) | CLI non instrada via REST (A-03) |
| E-24 | `POST /api/service/stop` | README §Runtime API | == `service:stop` | sì | — |
| E-25 | `POST /api/service/restart` | README §Runtime API | == `service:restart` | sì | — |
| E-26 | `POST /api/service/runtime` (body runtime) | README §Runtime API; openapi | == `service:runtime <t>` | sì | — |
| E-27 | `GET /api/logs [?follow=true]` | README §Runtime API | 200 CLI-style tail; `follow=true` → **400** esplicito | no | — |
| E-28 | `GET /api/logs/stream [?intervalMs]` | README §Runtime API+SSE note; app.js | SSE: event `ready`+`log` ogni intervalMs (min 200) | no | — |
| E-29 | `GET /api/models` | README §Runtime API | == `models:list` | no | — |
| E-30 | `POST /api/model/set` | README §Runtime API; openapi | == `model:set` | sì (settings) | — |
| E-31 | `POST /api/test` | README §Runtime API (mapping) | == `test` probe | sì (metering) | CLI non instrada via REST (A-03) |
| E-32 | `POST /api/claude/setup` | README §Runtime API | == `claude:setup --model N` | sì (settings) | — |
| E-33 | `POST /api/pi/setup` | app.js (codice) | == `pi:setup` | sì (.pi) | README mapping non lo elenca |
| E-34 | `POST /api/vscode/chat/setup` | app.js (codice) | == `vscode-chat:setup` | sì (config VS Code) | non in README |
| E-35 | `POST /api/vscode/claude/setup` | app.js (codice) | == `vscode-claude:setup` | sì (config VS Code) | non in README |
| E-36 | `POST /api/providers/:id/login` | README §Runtime API; app.js | == `provider:add <id>` (copilot: device flow) | sì (registry) | — |
| E-37 | `POST /api/providers/:id/api-key` | README §Runtime API; openapi (parziale) | == `provider:add <id> --api-key …`; `vision` default **true** se assente | sì (credenziale) | diverge dalla CLI (A-04) |
| E-38 | `GET /api/providers [?projectPath]` | README §Runtime API | == `provider:list` (con override chain) | no | — |
| E-39 | `GET /api/providers/available` | openapi; app.js | == `provider:available` | no | — |
| E-40 | `GET /api/providers/status` | README §Runtime API | == `provider:status` | no | — |
| E-41 | `GET /api/providers/usage` | openapi; app.js | == `provider:usage` | no | — |
| E-42 | `POST /api/providers/order` | README §Runtime API | == `provider:order` | sì (ordine) | — |
| E-43 | `POST /api/providers/reorder` | README §Runtime API | == `provider:reorder` | sì (ordine) | — |
| E-44 | `POST /api/providers/:id/rename` | README §Runtime API | == `provider:rename` | sì (name) | — |
| E-45 | `PATCH /api/providers/:id` | app.js; cli.js mapping | == `provider:update` | sì (metadati) | openapi assente |
| E-46 | `DELETE /api/providers/:id` | README §Runtime API | == `provider:remove` | sì (registry) | — |
| E-47 | `GET /api/stats` | README §Runtime API; openapi | == `stats` | no | — |
| E-48 | `GET /api/config [?scope][projectPath]` | README §Runtime API; openapi | == `config:list`; projectPath bloccato → **403 PROJECT_PATH_NOT_ALLOWED** | no | — |
| E-49 | `GET /api/config/:key` | README §Runtime API; openapi | == `config:get`; 403 senza projectPath | no | — |
| E-50 | `POST /api/config/:key` | README §Runtime API; openapi | 200 `Configurazione aggiornata…`; chiave ignota → **400 Variabile non supportata**; restartRequired → `restarting:true` + **service:restart pianificato (200ms)**; hotReloadable → reconfigure sinks | sì (config+riavvio) | — |
| E-51 | `DELETE /api/config/:key` | README §Runtime API; openapi | == `config:unset` | sì (rimozione) | — |
| E-52 | `POST /api/update` | README §Runtime API; openapi | == `update` | sì (install+servizio) | — |
| E-53 | `POST /api/uninstall` | README §Runtime API; openapi | == `uninstall` | sì (rimozione totale) | — |

### 1.3 Funzionalità / configurazioni documentate

| ID | Voce | Fonte | Risultato atteso (comportamento) | Mutante? | Note |
|---|---|---|---|---|---|
| F-01 | Fallback multi-provider + ordine | README §Configure/fallback; HANDOFF | ordine persistito = fonte di verità per `/v1/messages`; priorità: project override > provider.default_model | no (lettura/transitorio) | — |
| F-02 | `ANTHROPIC_DEFAULT_MODEL` chain (`provider:model` comma / `provider#model` hash) | README §fallback | `#` forza provider in testa alla chain effettiva; `provider:list` mostra `(override: provider#model)` | no | — |
| F-03 | `shortAnswer` / `LLMPROXY_SHORT_ANSWER` | README; openapi AnthropicMessagesRequest | istruzione risposta breve; default off; `true` per-request; `false` disabilita; sempre status execution | no (per-request) | — |
| F-04 | `LLMPROXY_METERING_INLINE` / `LLMPROXY_INFERENCE_INFO_INLINE` | README; llmproxy_settings.md | footer/prefisso inline su inferenze; default 0 se assenti nei settings progetto | no | — |
| F-05 | `LLMPROXY_REORDERING` / `_MINUTES` | README §LLMPROXY_REORDERING; llmproxy_settings.md; HANDOFF | riordino periodico price/power/speed; formato `-`, subset di price/power/speed; default minutes 5; hot-reload per REORDERING, restart per MINUTES; if unset → niente | no (effetto runtime) | — |
| F-06 | Price/Performance Routing (`LLMPROXY_PRICE_PERFORMANCE_ROUTING` / `_TIEBREAKER`) | README (sezione dedicata); .env.example | free-first / lowest-cost reorder + tiebreaker power/speed | no | **rimosse dal codice** (LEGACY_PROJECT_ENV_KEYS_TO_REMOVE, non in CONFIG_SPECS) → A-01 |
| F-07 | `LLMPROXY_PROVIDER_CREDIT_INLINE` | README; llmproxy_settings.md | credito residuo inline in `provider:list`; service scope | no | — |
| F-08 | `LLMPROXY_INTENT_ESCALATION` / `_GAP` / `LLMPROXY_INTENT_INFO_LINE` | README (service env); configuration.js | escalation intent a provider più potenti su fallimento; finestra GAP | no | — |
| F-09 | `LLMPROXY_MODE=platform` + endpoint `/v1/llm/*` + metering query | README §Billing+§Metering; manifest | HierarchyContext obbligatoria; metering JSONL; 404 se non platform | no | — |
| F-10 | `LLMPROXY_MONGODB_CONNECTION_STRING` | README; .env.example; metering-dblayer.js | standalone persistenza metering su MongoDB; default JSONL fallback | no | sandbox: `llmproxy_qa` |
| F-11 | `LLMPROXY_SECRET` | README; llmproxy_settings.md | HMAC secret firma token interni (cifratura registry) | no | — |
| F-12 | `LLMPROXY_API_KEY` | configuration.js (solo codice) | inbound API key gate (x-api-key) | no | non in README/.env.example → A-05 |
| F-13 | `LLMPROXY_HOME` + Runtime Paths (copilot-token.json, copilot-models.json, provider-registry.json, logs/metering.jsonl) | README §Runtime Paths | data root sovrascrivibile; file di stato elencati | no | sandbox LLMPROXY_HOME |
| F-14 | Port mapping 5/6/7 (5045/6045/7045) | README §Port Mapping; llmproxy_settings | dev/staging/prod | no | — |
| F-15 | SendGrid notifiche (`LLMPROXY_SENDGRID_*`, `TO_MESSAGE_TYPE`) | README; .env.example | notifiche project-scope per categorie | no | richiede credenziali esterne (A-06) |
| F-16 | `LLMPROXY_LLM_STATS_API_KEY` | README; cli.js | stats key per inferenza request `/v1/messages` | no | richiede chiave esterna (A-06) |
| F-17 | Docker runtime (`LLMPROXY_SERVICE_RUNTIME=docker`, compose) | README §service; Dockerfile; docker-compose.production.yml | servizio gestito via docker compose | no | mai in sandbox (produzione/staging off-limits) |
| F-18 | SSE `/api/logs/stream` | README §Runtime API | streaming event `ready`/`log` | no | — |
| F-19 | OpenAPI spec `api/v1.openapi.yaml` | spec openapi | doc API (parziale vs rotte reali) | no | A-07 |
| F-20 | Endpoint `/api/smart/*` (add/status/test/refresh) | openapi (solo) | documentati, **non implementati** in app.js | n/a | A-08 |
| F-21 | Commands `auto-rank:*` + `configura` | docs/nextUp/auto-rank.md | “per implementazione futura” — non implementati | n/a | A-09 |

## 2. Grafo effetti di stato (per qa-functional-verifier: snapshot pre/post su downstream)

| Comando mutante | Stato persistente/condiviso che cambia (file/oggetto) | Downstream il cui output atteso cambia | Delta atteso prima → dopo |
|---|---|---|---|
| C-03 `setup` | data root + dir runtime (`logs/`, `copilot-token.json` etc.) se assenti | C-17 `logs`, C-19 `service:start`, C-47 `config:set --scope service`, C-07 `run` | dir assenti → presenti; `logs` da `Nessun log disponibile.` a tail vuoto valido |
| C-05 `login` / C-23 `provider:add <copilot>` / E-20 `/api/auth/login` | `copilot-token.json` (+token device flow) | C-09 `status` (token presence true), C-10/26/27, C-11/12 `test`, E-04 `/v1/messages`, E-02 `/auth/status` | `authenticated:false`→`true`; `provider:list` da vuoto/a voce copilot |
| C-06 `logout` / E-03/E-21 `/auth/logout` | `copilot-token.json` rimosso (`clear()`) | E-02 `/auth/status`→`false`; C-10 `models:list` (live catalog queda), C-26 `provider:list` (vuoto se era unico), C-11 `test` (fail auth) | presenza → assenza |
| C-07 `run` | processo su 5045 attivo | C-08 `stop`, C-09 `status` (dev running), E-01 `/health` 200, CLI via REST (C-11 `test`) | processo assente → presente; `/health` refused → 200 |
| C-08 `stop` | processo 5045 down | C-09 `status` (dev stopped; CLI torna locale), E-01 `/health` refused | presente → assente |
| C-10 `models:list` (autenticato) | `copilot-models.json` aggiornato | C-41 `claude:setup --model N` (indici), C-40 `model:set`, C-43 `vscode-chat:setup` (lista modelli) | cache assente/stale → fresh; indici cambiano |
| C-11/12/13/14 `test` / C-34 `provider:test` / E-04/05/06/07 inferenza / E-31 `/api/test` | `logs/metering.jsonl` + `logs/requests-*.jsonl` (append) | C-15 `stats`, C-28 `provider:usage`, C-17 `logs` | righe 0 → N; `stats` da vuoto/a conteggi |
| C-16 `stats:reset [--hard]` | `logs/metering.jsonl` troncato | C-15 `stats` (azzerato), C-28 `provider:usage` | conteggi N → 0 (nota A-02 su --hard) |
| C-19 `service:start` / E-23 | unit/agent servizio + service config persista + container (dip. profilo) | C-09 `status` (service active), C-21 `service:restart` valid, C-17 `logs` (file servizio), E-01 `/health` | none → active; `/health` possible |
| C-20 `service:stop` / E-24 | stato servizio stopped | C-09 `status`, E-01 `/health` (refused se unico listener) | active → stopped |
| C-21 `service:restart` / E-25 | riavvio servizio + eventuale recreate container | C-09 `status` (uptime/reset), C-17 `logs` (nuovo boot), E-01 `/health` | old PID → new PID |
| C-22 `service:runtime <t>` / E-26 | `LLMPROXY_SERVICE_RUNTIME` persistita + artefatti (unit vs container) | C-09 `status` (runtime mostrato), C-19 `service:start` (stessa famiglia), C-17 `logs` (sorgente logs), E-08 `/v1/llm/health` | famiglia runtime cambia; artefatti vecchi rimossi |
| C-23/24 `provider:add/key` / E-36/37 | `copilot-token.json` (registry + credenziali cifrate) | C-26 `provider:list`, C-27 `provider:status`, C-10 `models:list`, C-11/34 `test`, E-04 `/v1/messages`, E-38 `/api/providers`, E-29 `/api/models` | vuoto → voce presente; test funzionano |
| C-29 `provider:order` / E-42 | ordine in `copilot-token.json` | C-26 `provider:list` (ordine), C-11 `test -i` (winner cambia), E-04 fallback order | posizione cambia |
| C-30 `provider:reorder` / E-43 | ordine ricalcolato+persistito (se REORDERING set) | C-26 `provider:list`, E-04 `/v1/messages`; sovrascrive C-29 fino a prossimo ciclo | ordine manuale → ordine calcolato |
| C-31 `provider:rename` / E-44 | name in registry | C-26 `provider:list`, C-27 `provider:status` | display name cambia (id invariato) |
| C-32 `provider:update` / E-45 | vision/free_model/name in registry | C-26 `provider:list`, E-04 `/v1/messages` (richieste con immagini: con vision=false il provider viene saltato) | flag cambia |
| C-33 `provider:remove` / E-46 | entry rimossa da registry (file se ultimo) | C-26 `provider:list`, C-27 `provider:status`, C-11 `test`, C-10 `models:list`, E-04 | voce presente → assente |
| C-35/37/38 `proxy:add/remove/reorder` | proxy registry file | C-36 `proxy:list`, C-34 `provider:test --all-proxies`, C-39 `proxy:test`, C-23 `provider:add --proxy` (rotazione), E-04 (proxy demote) | entry cambiano |
| C-40 `model:set` / E-30 | `.claude/settings.json` (model+env) | C-26 `provider:list` (chain effettiva), E-04 routing, C-11 `test -i` | model/chain cambia |
| C-41 `claude:setup` / E-32 | `.claude/settings.json` + globale `~/.claude/settings.json` | C-45 `config:list` (project/global), E-04 auth, C-26 `provider:list` override | settings creati/aggiornati |
| C-42 `pi:setup` / E-33 | `.pi/models.json` + `.pi/settings.json` | (consumatore esterno PI Agent) | file creati |
| C-43/44 `vscode-*:setup` / E-34/35 | `chatLanguageModels.json` / config Claude VS Code | (VS Code rilegge al riavvio) | file creati/aggiornati |
| C-47 `config:set` / E-50 | `.claude/settings.json` (project/global) o service config | C-45/46 `config:list/get`, C-47 replay, E-04 (hot-reload: DBLAYER_URL, EVENTBUS_URL, SENDGRID_*, REORDERING), runtime dopo restart per restartRequired | valore cambia; E-50 con restartRequired → servizio riavviato |
| C-48 `config:unset` / E-51 | rimozione chiave | C-45 `config:list`, C-46 `config:get` (default o assente) | chiave presente → assente/default |
| C-49 `config:migrate` | config project/global/service riscritta | C-45 `config:list` (chiavi legacy sparite, nomi nuovi), C-50 `update` (lo invoca) | legacy → nuovi nomi |
| C-50 `update` / E-52 | package globale + servizio + config migrata | C-02 `version` (nuova/uguale versione), C-09 `status`, C-45 `config:list`, E-16 `/api/version` | installazione sostituita; rollback ripristina precedente |
| C-51/52/53 `install:*` | package globale + unit servizio + install-locale.txt + service config | C-02 `version`, C-03 `setup`, C-19 `service:start`, C-09 `status` | CLI non in PATH → in PATH |
| C-54 `uninstall` / E-53 | rimozione totale (servizio, container, data root, package) | tutti i comandi (post-condizione: assenti/fail) | presente → assente |
| E-10/11 `/v1/llm/providers` | `provider-registry.json` (registry separato dal token store) | E-09 `GET /v1/llm/providers`, E-04 routing platform, C-26? (no — registry distinto) | entry upsert/remove |

## 3. Non verificabili / ambigui (con motivo)

| ID | Voce | Problema | Azione attesa verifier |
|---|---|---|---|
| A-01 | `LLMPROXY_PRICE_PERFORMANCE_ROUTING` / `_TIEBREAKER` (README + .env.example) | In `LEGACY_PROJECT_ENV_KEYS_TO_REMOVE` (configuration.js), NON in CONFIG_SPECS → `config:set` le rifiuta; HANDOFF conferma rimozione. README/.env.example le presentano come attive. | Classificare FAIL-DOC (documentazione mente) o verificare comportamento residuo altrove (rotte? provider-reordering usa `LLMPROXY_REORDERING`). Instradare a docs-sync/coder. |
| A-02 | `stats:reset --hard` | Help/COMMAND_HELP: resetta “cache smart router + config auto-rank”; impl reale tronca solo `metering.jsonl`. Concetto “smart router” e “auto-rank” non esistono più nel codebase (smart-router rimosso—HANDOFF; auto-rank solo docs/nextUp). | Verificare comportamento reale; finding candidato (help/doc non allineato). |
| A-03 | Mapping CLI→REST asimmetrico | README: `test→POST /api/test`, `service:start→POST /api/service/start`, `logs --follow→GET /api/logs/stream`; cli.js non instrada questi via REST (fallback locale). Gli endpoint esistono e sono verificabili direttamente. | Verificare endpoint REST direttamente + comportamento CLI locale; annotare differenza di percorso. |
| A-04 | REST `POST /api/providers/:id/api-key` vision default `true` | CLI richiede `--vision` esplicito (obbligatorio per API-key provider); REST forza `true` in assenza del campo. Divergenza di contratto. | Verificare il comportamento effettivo ed eventuale sicurezza (vision assume true per errore). |
| A-05 | `LLMPROXY_API_KEY` | Chiave config supportata + gate inbound in app.js/CLI, ma assente da README env table e .env.example. | Verificare il gate; segnalare doc incompleta. |
| A-06 | `provider:usage` / SendGrid / LLM_STATS / OAuth copilot | Dipendono da credenziali esterne (API key, account Copilot, servizi rete) o da metering accumulato. | Sandbox: usare chiavi fake/placeholder dove il codice lo consente; altrimenti BLOCKED con motivo (oss. `credit=n/a`, `bench=errore` tollerabili se dichiarati). |
| A-07 | OpenAPI spec parziale | openapi non copre molte rotte reali (`/api/help`, `/api/service/*`, `/api/providers*` parziale, `/api/config*`, `/v1/llm/providers`, `/v1/chat/completions`…) e documenta `/api/smart/*` inesistenti; versioni spec (0.2.2/0.2.73 manifest) non allineate a 0.3.119. | Usare README+app.js come fonte primaria; segnalare spec come obiettivo docs-sync. |
| A-08 | `/api/smart/*` (openapi) | Endpoint documentati ma nessuna rotta in app.js. | BLOCKED / non implementato, con evidenza (404 o rotta assente). |
| A-09 | `auto-rank:*` e `configura` (docs/nextUp, LIBRO FUTURO) | Documento dichiara “implementazione futura”; nessun dispatcher/file. | BLOCKED per design (feature futura) — non è regressione; annotare. |
| A-10 | `config:migrate` | Comando esistente in cli.js ma non documentato in `--help`/README (usato da `update`). | Verificabile; segnalare superficie non documentata. |
| A-11 | README-IT refusi `ppnpm` (3 occorrenze) | Errore docs (vs `pnpm`). | Fix docs-sync (non funzionale). |
| A-12 | Installa/update/uninstall/service manager | Mutazioni a livello di sistema (npm global, launchd/systemd, docker). In sandbox: BLOCKED o verifica solo nel worktree/container isolato; MAI su produzione. | BLOCKED con motivo se non isolabile. |
| A-13 | `service:runtime launchd/systemd` su piattaforme incrociate | README dichiara alias OS-specific senza definire comportamento su OS non corrispondente. | Verificare per-piattaforma; annotare comportamento atteso mancante. |
| A-14 | Manifest.json version 0.2.73 / endpoint list | manifest non aggiornato a 0.3.119; elenca solo 3 endpoint + prefix `/api` (parziale). | Informativo; non bloccante. |
| A-15 | Node runtime | Spec: verifica su Node del sistema (v26.5.0?); package dichiara 22 LTS+; differenza runtime = finding. | Registrare `node --version` nell'evidenza. |