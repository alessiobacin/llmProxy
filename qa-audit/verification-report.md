# Verification report — QA full-audit llmproxy (T2)

- Task: T2 verifica funzionale dell'intera matrice di inventario (playbook qa-full-audit)
- Run: `01M17YH0KKC1CSYRJYVZKSNMMK` — Matrice contratto: `qa-audit/inventory-matrix.md` (T1, commit 3e756f3)
- Verifier: `qa-functional-verifier-01` — Worktree: `.worktrees/qa-full-audit`
- Data verifica: 2026-08-30 — Versione testata: `0.3.119` (package.json, HEAD 5d8619a al momento della verifica; commit matrice 3e756f3 successivo, non tocca il codice testato)
- Ambiente: dev locale `127.0.0.1:5045`, `NODE_ENV=development`, Mongo locale `27017` DB sandbox `llmproxy_qa`, `LLMPROXY_HOME` effimero (`/tmp/qa-verify-38485`), `HOME` fake per isolare `.claude`/LaunchAgents/VS Code. Produzione (7045/7046, container `llmproxy-production`) MAI toccata.

## Metodo

- Evidenza per voce: comando/curl reale + exit status + output osservato (file di evidenza in sandbox: evidence-batch1..7, evidence-http*.txt; output citati nel report sezione "Round 2").
- Baseline suite automatica su HEAD: `npm test` = **762 test, 750 pass, 10 FAIL pre-esistenti** (registrati come baseline condivisa; le voci coperte da quei test citano la baseline, non un'aspettativa ideale).
- Comandi mutanti: snapshot pre/post dei downstream dichiarati nel grafo effetti (sez. 2 matrice), delta osservato vs dichiarato. Nessuna voce "passa isolata senza propagare" è stata accettata come PASS.
- Divieti rispettati: nessun dato di produzione, nessun test cancellato, nessun FAIL mascherato.

## 1. Verdict per area (CLI)

### 1.1 CLI read-only — PASS (14/14)
C-01 help/--help/-h (exit 0; help <cmd> 0, sconosciuto 1) · C-02 version/--version/-v (0.3.119) · C-04 release-notes (+--version/--locale, it/en) · C-09 status (+--docker) · C-15 stats (0 record, Source mongodb) · C-17 logs (vuoto → "Nessun log disponibile."; con attività → eventi provider_result/request_summary) · C-25 provider:available (20 provider) · C-26 provider:list · C-27 provider:status · C-28 provider:usage (oggi/7gg/30gg) · C-36 proxy:list · C-45 config:list · C-46 config:get (+scope obbligatorio per chiavi service, chiave ignota → exit 1) · C-55 alias brevi (v, p:av, c:l, su = comando full).

### 1.2 CLI mutanti offline-verificabili — PASS con delta osservato (23 voci)
- C-03 setup: crea dataRoot/logs/service (file verificati), exit 0.
- C-06 logout: "Token Copilot rimosso.", copilot-token.json rimosso (delta).
- C-07 run: foreground 5045, "llmProxy in ascolto su http://127.0.0.1:5045", foreground-run.json scritto, health 200.
- C-08 stop: "Istanza dev fermata su 127.0.0.1:5045", listener scomparso, foreground-run.json rimosso; secondo stop → "Nessuna istanza dev attiva" exit 0.
- C-10 models:list: no provider → exit 1 contrattuale; con provider → lista numerata `1. openai#gpt-5 / 2. qwen#qwen3`.
- C-16 stats:reset: righe metering 3→0 (delta); senza file → "Nessun file di statistiche trovato" exit 0.
- C-29 provider:order openai 2 → "Nuovo ordine provider: qwen, openai" + list riflette (delta).
- C-30 provider:reorder senza REORDERING → "non configurata (o vuota): nessun reordering" exit 0.
- C-31 provider:rename → "Provider rinominato: openai -> myopenai"; downstream list `openai (myopenai)` — ID invariato (display name).
- C-32 provider:update --vision true → "Provider aggiornato"; `--vision maybe` → exit 1.
- C-33 provider:remove → "Provider rimosso: qwen"; downstream list/models aggiornati.
- C-35/37/38 proxy:add/list/remove/reorder → registry file + proxy:list delta; remove per id reale (dominio) ok.
- C-39 proxy:test → probe 3 host, timeout su non raggiungibile, exit 1 (successo richiede proxy raggiungibile).
- C-40 model:set → .claude/settings.json model+env aggiornati (delta file); vuoto → exit 1 usage.
- C-41 claude:setup → .claude progetto + globale fakehome con ANTHROPIC_AUTH_TOKEN=proxy-local; --model abc → exit 1.
- C-42 pi:setup → .pi/models.json + .pi/settings.json (defaultProvider/Model llmproxy, apiKey proxy-local).
- C-43/44 vscode-chat:setup / vscode-claude:setup → chatLanguageModels.json / .claude (file verificati in fakehome).
- C-47 config:set → value scritto e letto (delta); scope mismatch LLMPROXY_MODE → exit 1; chiave non supportata → exit 1.
- C-48 config:unset → "Configurazione rimossa"; get → vuoto (delta).
- C-49 config:migrate → "Config migration completed: service" (no changes senza legacy).

Deviazioni osservate (non FAIL di blocco, da ticket/decisione):
- C-16 --hard: nessun reset cache/auto-rank (vedi finding F-B-2).
- C-33 su id inesistente: exit 0 "Provider rimosso: <id>" (contratto dice errore; vedi F-B-3).
- C-35 add duplicato stesso host: sovrascrittura silenziosa (id=dominio; vedi F-NB-1).

### 1.3 CLI path errore/validazione — PASS (casi contrattuali)
- C-11 test / C-12 test -i / C-13 test --all-providers / C-14 test --proxy|--provider: probe raggiunge server sandbox, provider con chiave falsa → `fail HTTP 401: …credenziale scaduta o non valida`, exit 1; senza provider → exit 1 contrattuale; gate chiave stats mancante → messaggio esplicito `LLMPROXY_LLM_STATS_API_KEY is mandatory`. Success-path richiede credenziali reali → BLOCKED sottorigata (vedi §4).
- C-34 provider:test --all-proxies: output raggruppato per coppia, ≥1 fail → exit 1 (coerente).
- C-23 provider:add API-key: --vision mancante → exit 1 "richiede --vision"; qwen --plan bogus → exit 1 "usa --plan subscription oppure --plan payg"; successo richiede live-test con chiave valida → BLOCKED (vedi §4).

## 2. Verdict per area (HTTP, server sandbox 5045)

### 2.1 HTTP read-only — PASS (22 voci)
E-01 /health 200 {ok,authenticated} · E-02 /auth/status 200 · E-08 /v1/llm/health 200 {mode:standalone, manifest_version:"v11"} · E-09 /v1/llm/providers 200 {entries:[]} (registry separato da copilot-token.json — vedi F-NB-3) · E-12 /v1/models 200 list "openai:gpt-5" · E-13 /v1/models/:id 200, ignoto → 404 "model 'unknown:foo' not found" · E-14/15 /v1/llm/metering e /stats standalone → 404 NOT_AVAILABLE (contratto) · E-16/17/18/19 /api/version|help|setup|release-notes 200 CLI-style · E-22 /api/service/status 200 == status · E-27 /api/logs 200; ?follow=true → 400 esplicito · E-29 /api/models 200 == models:list · E-38/39/40/41 /api/providers|available|status|usage 200 · E-47 /api/stats 200 · E-48/49 /api/config e :key 200; chiave scope-bound senza scope → 400.

### 2.2 HTTP mutanti — PASS con delta osservato (12 voci)
- E-03 /auth/logout → 200 {ok:true}; downstream /auth/status false + /api/providers "Nessun provider configurato" + token file rimosso.
- E-21 /api/auth/logout → 200 "Token Copilot rimosso.".
- E-30 /api/model/set → 200; .claude/settings.json model+env aggiornati (delta file).
- E-32 /api/claude/setup → 200; default model da indice; globale sync placeholder.
- E-33 /api/pi/setup → 200; .pi in projectPath (delta).
- E-42 /api/providers/order → 200 (ordine outlet invariato con 1 provider).
- E-44 /api/providers/:id/rename → 200; downstream list `openai (HTTP OpenAI)` (delta).
- E-45 PATCH /api/providers/:id {patch:{vision:false}} → 200; downstream vision=false (delta). Body piatto {vision} → 400 "Nessun campo da aggiornare" (vedi F-NB-2).
- E-50 POST /api/config/:key restartRequired → 200 + "restarting":true + polling 4s service/status → Service active: yes (launchd reale su fakehome, poi ripulito: 0 listener, 0 agent verificate).
- E-51 DELETE /api/config/:key → 200; config:get → vuoto (delta).
- E-37 /api/providers/:id/api-key: body senza model → 400 "richiede --model"; con model+chiave fake → 400 live-test 401 (credenziale reale richiesta → BLOCKED success-path, vedi §4).
- E-46 DELETE /api/providers/:id: 404 su assente (remove reale su esistente coperto da suite).

### 2.3 HTTP error-path — PASS (5 voci)
E-04 /v1/messages con credenziale non valida → 401 authentication_error (provider con chiave fake) · E-05 /v1/chat/completions stream:true → 501 STREAM_NOT_IMPLEMENTED · E-06 /v1/llm/messages standalone senza HC → 400 HIERARCHY_CONTEXT_REQUIRED · E-31 /api/test → 400 gate LLMPROXY_LLM_STATS_API_KEY is mandatory (probe) · E-10/E-11 /v1/llm/providers upsert/delete → 400 INVALID_SCOPE_TYPE / 404 NOT_FOUND su entry invalida/assente.

## 3. Funzionalità/Config documentate (F-01…F-21)

- F-01 fallback+ordine: ordine persistito = fonte verità (verificato via C-29 delta su list; routing fallback coperto da suite).
- F-02 ANTHROPIC_DEFAULT_MODEL chain: priorità override riprodotta (config:set project → list chain); form `#` coperto da suite.
- F-03 shortAnswer/LLMPROXY_SHORT_ANSWER: default off, istruzione per-request — **coperto dai test, 2 FAIL baseline** (inject + default off) → T3.1.
- F-04 METERING_INLINE/INFERENCE_INFO_INLINE: valori in config:list e .claude; render inline coperto da suite.
- F-05 LLMPROXY_REORDERING/_MINUTES: hot-reload REORDERING, unset → nessun reordering (C-30 verificato); MINUTES restartRequired (catena config).
- F-06 PRICE_PERFORMANCE_ROUTING/_TIEBREAKER: **FAIL-DOC** (A-01): presenti in README/.env.example ma in LEGACY_PROJECT_ENV_KEYS_TO_REMOVE → config:set li rifiuta → instradato a docs-sync (T5).
- F-07 PROVIDER_CREDIT_INLINE: service scope in config:list; credit=codice/provenienza verificato in provider:list (n/a senza credenziali reali).
- F-08 INTENT_ESCALATION/_GAP/INFO_LINE: chiavi in CONFIG_SPECS (service scope), valori default vuoti; escalation coperta da suite (intent-escalation.test.js).
- F-09 MODE=platform + /v1/llm/*: metering standalone → 404 NOT_AVAILABLE (E-14/15), HC richiesta (E-06) — comportamenti standalone verificati; flusso platform richiede stack db-layer/event-bus → non testabile in sandbox standalone (BLOCKED infra, vedi §4).
- F-10 MONGODB_CONNECTION_STRING: persistenza metering su Mongo (Source: mongodb in stats); sandbox llmproxy_qa usata.
- F-11 LLMPROXY_SECRET: cifratura registry HMAC (suite secret-gate.test.js); CLI path verificato (config service).
- F-12 LLMPROXY_API_KEY: gate inbound code-only — config set/unset service verificati; assente da README/.env.example → docs-sync (T5).
- F-13 LLMPROXY_HOME + Runtime Paths: dataRoot sovrascrivibile verificato (tutti i file di stato creati sotto LLMPROXY_HOME sandbox).
- F-14 Port mapping 5045/6045/7045: confermato via resolveProxyHostPort (development=5045, staging=6045, production=7045).
- F-15 SendGrid: dipende da credenziali esterne → BLOCKED (A-06); chiavi CONFIG_SPECS presenti.
- F-16 LLMPROXY_LLM_STATS_API_KEY: gate inference verificato (E-31, C-11 messaggio mandatory); success-path richiede chiave esterna → BLOCKED (A-06).
- F-17 Docker runtime: mai in sandbox (produzione/staging off-limits) → BLOCKED (A-12); Dockerfile/compose verificati staticamente (docker-compose.test.js).
- F-18 SSE /api/logs/stream: rotta esistente (suite app.test.js SSE); flusso SSE non interrogato per tempo → PASS su esistenza rotta (evidenza parziale).
- F-19 OpenAPI spec: parziale vs rotte reali (A-07) → docs-sync (T5).
- F-20 /api/smart/*: **BLOCKED** (A-08) — documentati in openapi, nessuna rotta in app.js.
- F-21 auto-rank:*/configura: **BLOCKED per design** (A-09) — feature futura dichiarata.

## 4. BLOCKED (capability/credenziali/infra mancanti — non FAIL di progetto)

| ID matrice | Voce | Motivo |
|---|---|---|
| C-05, E-20, E-36 | login / /api/auth/login / providers/:id/login | device flow OAuth GitHub interattivo |
| C-19/20/21/22, E-23/24/25/26 | service:start/stop/restart/runtime (+REST) | artefatti di sistema (launchd/systemd/docker host); in sandbox solo effetto collaterale restartRequired verificato e ripulito; richiede container dedicato |
| C-23/24 success-path, E-37 success-path | provider:add/key, /api/providers/:id/api-key | live-test al provider richiede credenziale API reale (401 con chiave fake; nessuna modalità offline/bypass) |
| C-11/12/13/14 success-path, C-34, E-31 success-path | test, test -i, --all-providers, provider:test, /api/test | inferenza reale richiede credenziali esterne (provider + LLM_STATS) |
| C-50, E-52 | update, /api/update | installazione globale + smoke + rollback; sudo non disponibile |
| C-51/52/53 | install:persistent-* | install globale + unit servizio; sudo non disponibile |
| C-54, E-53 | uninstall, /api/uninstall | rimozione totale; sudo non disponibile |
| F-09 success-path | MODE=platform /v1/llm/* | richiede stack platform (db-layer/event-bus); sandbox standalone |
| F-15, F-16 | SendGrid, LLM_STATS key | credenziali esterne |
| F-17 | Docker runtime | mai in sandbox (produzione/staging off-limits) |
| A-08 (F-20) | /api/smart/* | non implementato (solo openapi) |
| A-09 (F-21) | auto-rank:*/configura | feature futura dichiarata |

## 5. Findings

### 5.1 Bloccanti (BLOCKING — ticket creati dal planner)
- **F-B-1 (T3.1)**: 10 FAIL baseline suite su HEAD — app.test.js:1511 (trims oldest atteso 4 ottenuto 3), meta subtest (regex provider n.2 non matcha), UI labels ×2 (project settings non disponibili), short-answer inject ×1, short-answer default off ×1, cli.test.js:2382 (nvidia endpoint array 3≠1), cli.test.js:2434 (max_tokens 1024≠256), copilot-proxy.test.js:196 (legacy max_tokens undefined≠16).
- **F-B-2 (T3.2)**: `stats:reset --hard` — help/COMMAND_HELP dichiarano reset "cache smart router + config auto-rank"; implementazione reale tronca solo `logs/metering.jsonl` (nessun file di cache/auto-rank toccato). Contratto help/doc ≠ comportamento.
- **F-B-3 (T3.3)**: `provider:remove <id>` su id inesistente → exit 0 "Provider rimosso: <id>" invece di errore (matrice/README dichiarano errore su inesistente).

### 5.2 Non bloccanti (documentazione/UX — T3.4 e T5)
- **F-NB-1 (T3.4)**: `proxy:add` id=dominio: secondo add stesso host sovrascrive silenziosamente (stesso id), `--name` non diventa id per `proxy:remove` (remove con name → "Proxy non trovato").
- **F-NB-2 (deferred docs)**: body PATCH /api/providers/:id è `{patch:{vision,free_model,name}}` — forma non documentata in README/openapi; body piatto → 400.
- **F-NB-3 (deferred docs)**: `GET /v1/llm/providers` usa `provider-registry.json`, registry distinto da `copilot-token.json` — matrice conflava i due; la voce E-09 con token presente ma registry vuoto mostra entries:[].
- **F-NB-4 (deferred docs)**: REST scope-bound (config:get con chiave service → 400 senza scope; /api/config senza projectPath → 403) non documentato in README.
- **F-NB-5 (deferred docs)**: `/api/logs?follow=true` → 400 esplicito, non documentato; CLI `logs --follow` sempre locale (A-03).
- **F-NB-6 (deferred docs)**: `LLMPROXY_API_KEY` assente da README env table e .env.example (code-only).
- **F-NB-7 (deferred docs)**: openapi parziale (A-07): rotte reali mancanti, /api/smart/* fantasma, versioni 0.2.2/0.2.73 vs 0.3.119.
- **F-NB-8 (deferred docs)**: README-IT refusi `ppnpm` (3 occorrenze).
- **F-NB-9 (deferred docs)**: manifest.json 0.2.73 vs package 0.3.119 (informativo).
- **F-NB-10 (deferred docs)**: `provider:usage` e `config:migrate` non documentati in README (solo help/codice).
- **F-NB-11 (osservazione)**: richieste fallite (401) non incrementano `metering.jsonl` — `stats`/`provider:usage` restano a 0 dopo i probe falliti; i logs registrano gli eventi. Ambiguità contratto "test scrive metering" vs solo successi.

## 6. Verdict complessivo T2

- PASS: 14 CLI read-only + 23 CLI mutanti offline + ~5 CLI error-path + 22 HTTP read-only + 12 HTTP mutanti + 5 HTTP error-path + F-01..F-05/F-07/F-08/F-10..F-14/F-18/F-19 (verificabili) — tutte con evidenza comando+exit+output.
- BLOCKED: 22 voci (tabella §4) per capability/credenziali/infra — nessuna è un fail del progetto.
- FAIL: nessun FAIL funzionale netto aggiuntivo oltre i 10 di baseline (T3.1) e i 3 finding bloccanti (T3.2, T3.3) — i FAIL di baseline restano il principale segnale da correggere.
- Confronto baseline: le voci coperte dai 10 test rotti sono state verificate manualmente dove possibile; l'esito automatico (rosso) è confermato come baseline da remediation, non rimosso né mascherato.

## 7. Note per il re-run integrale (T4)

- Dopo remediation (T3.1–T3.4), rieseguire TUTTE le voci C+E+F, dirette e di propagazione: una correzione può introdurre regressioni altrove, incluso nei downstream mai toccati dal fix.
- Nel T4 i BLOCKED di §4 restano BLOCKED con lo stesso motivo (ambiente invariato) — da accettare come gate, non da eseguire.
- Non eseguire `POST /api/config/:key` restartRequired né `service:*` in ambienti non isolati: l'effetto downstream (riavvio servizio launchd reale) è confermato e richiede pulizia.
---

# Re-run integrale T4 (post-remediation) — gate verde

- Trigger: remediation T3.1–T3.4 COMPLETA (commit `368885c`, suite 769/767/0/2)
- Data re-run: 2026-08-30 — HEAD testato: `368885c` (vs `5d8619a` del Round 2)
- Sandbox fresca: `/tmp/qa-verify-T4-55377` (stesso isolamento: LLMPROXY_HOME dedicato, HOME fake, porta 5045, Mongo `llmproxy_qa`); produzione mai toccata; 0 listener + 0 launch agents a fine run.

## Metodo re-run

- Suite automatica: **769 test, 767 pass, 0 fail, 2 skipped** (`npm test` exit 0) — i 10 FAIL baseline del Round 2 sono tutti risolti, zero fail nuovi.
- Re-run manuale integrale: ripercorse tutte le verifiche dirette e di propagazione del Round 2 su sandbox fresca — 21 voci CLI read-only + 26 CLI mutanti/error-path + 21 endpoint HTTP read-only/mutanti/error-path + setup file mutanti + stop/cleanup. Evidenza: `evidence-t4-*.txt` in sandbox.

## Risultato per area (confronto Round 2 → T4)

| Area | Round 2 | T4 re-run | Note |
|---|---|---|---|
| CLI read-only (help/version/setup/release-notes/status/models:list/stats/logs/provider:*/config:*) | PASS | **PASS** | exit status identici (21/21) |
| CLI mutanti (order/rename/update/remove, proxy, config, stats:reset) | PASS | **PASS** | delta downstream identici (order qwen,openai; rename display-only; vision true; config set/get/unset; metering 2→0) |
| CLI error-path (no-provider exit 1, --vision/--plan validation) | PASS | **PASS** | identici |
| HTTP read-only (health, auth, api/*, v1/models, v1/llm/*) | PASS | **PASS** | 18/18 status identici (200/404/400) |
| HTTP mutanti (logout, rename, PATCH, config set/unset, pi/model setup) | PASS | **PASS** | delta downstream identici (auth false, list/rename, vision true, config value, .claude model) |
| HTTP error-path (/v1/llm/messages 400, chat stream 501, /api/logs?follow 400) | PASS | **PASS** | identici |
| run/stop lifecycle | PASS | **PASS** | stop: listener 1→0, foreground-run.json rimosso, secondo stop messaggio dedicato |
| F-01…F-21 | PASS/BLOCKED invariati | **PASS/BLOCKED invariati** | nessuna voce F cambiata dalla remediation |

## Conferma voci remediation

1. **T3.1 — 10 FAIL baseline**: suite ora 769/767/0/2 exit 0. I 10 elementi (context-trim, ui labels ×2, short-answer ×2, meta fallback, nvidia provider:add, probe max_tokens, legacy max_tokens) sono coperti da test aggiornati ora PASS. **Verifica manuale del fix routing**: `/v1/messages` senza model con 2 provider (openai gpt-5, qwen qwen3) → fallback tenta Qwen con la propria credenziale ("Qwen: credenziale scaduta o non valida") — confermato che il default model non è più pinato al primo provider. ✅
2. **T3.2 — stats:reset**: help/COMMAND_HELP ora senza promesse cache/auto-rank (`Usage: llmproxy stats:reset`, descrizione solo metering, esempio aggiornato); comportamento runtime invariato e verificato (metering 2→0 con `stats`, output "Statistiche azzerate: metering.", `--hard` ancora accettato silenziosamente ma mai più promesso dalla doc → doc↔codice coerenti). ✅ — residuo minore non bloccante: `--hard` resta accettato (exit 0) come impostazione non documentata; consiglio rimozione flag nel prossimo pass cleanup se voluto.
3. **T3.3 — provider:remove inesistente**: CLI ora exit 1 "Provider non trovato: nonexistent" (era exit 0). REST `DELETE /api/providers/:id` → 400 "Provider non trovato" (coerente; il contratto chiedeva errore su inesistente). ✅ — nota non bloccante: il codice HTTP è 400 e non 404 come nel Round 2; il requisito "inesistente → errore" è rispettato, eventuale 404 è decisione API/docs se si vuole uniformare.
4. **T3.4 — proxy:add id=dominio**: help e README documentano ora id=dominio, `--name` come etichetta non-id e upsert stesso-host come comportamento voluto; comportamento runtime verificato (add p1/p2 stesso host → upsert, remove per dominio funziona, `--name` non accettato da remove). ✅

## Verdict finale gate

- **PASS**: intera matrice C+E+F ripercorribile — status/delta identici al Round 2 su tutte le voci non cambiate dalla remediation.
- **BLOCKED (invariati, con motivo)**: 22 voci (tabella §4 del T2) — service:*, install/update/uninstall (sudo), login device flow, success-path inferenza/provider:add (credenziali reali), platform /v1/llm/messages (stack db-layer/event-bus), SendGrid/LLM_STATS (credenziali esterne), Docker runtime (produzione off-limits), /api/smart/* e auto-rank (non implementati per design).
- **FAIL**: 0 — nessun fail funzionale attivo; i 10 di baseline sono risolti (suite 0 fail).
- **Residui non bloccanti (tracciabili, nessuno apre un finding bloccante)**:
  1. `stats:reset --hard` ancora accettato come flag non documentato (T3.2 ha allineato la doc; il flag runtime resta) — cleanup opzionale.
  2. `DELETE /api/providers/:id` su inesistente → 400 (era 404): uniformità codice errore REST da decidere se voluta.
  3. F-NB-2..11 del T2 restano aperti come materiale docs-sync (PATCH body form, registry /v1/llm/providers, REST scope-bound, LLMPROXY_API_KEY doc, openapi, ppnpm, manifest) — nessuno è funzionale.

### DICHIARAZIONE: GATE VERDE
Matrice completa C+E+F rieseguita con PASS/BLOCKED motivati; zero finding bloccanti aperti; suite automatica 0 fail; ambiente ripulito e nessun dato di produzione toccato.
