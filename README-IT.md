# llmProxy

`llmProxy` e` un package standalone che espone un proxy multi-provider Anthropic-compatible su `/v1/messages` e una CLI globale per setup, gestione provider, status, log, servizio persistente e fallback tra più provider. Al momento e` ottimizzato principalmente per workflow Claude Code.

> **Modalita` platform v11**: `LLMPROXY_MODE=standalone` e` il default ed e` il percorso consigliato per checkout locale, `llmproxy run` e installazione persistente utente. `LLMPROXY_MODE=platform` resta disponibile come modalità di compatibilita` esplicita per il boundary gateway V11 su `/v1/llm/*`. Note di contesto: [docs/V11-REFACTOR-IMPLEMENTATION-PLAN.md](docs/V11-REFACTOR-IMPLEMENTATION-PLAN.md).

## Quick Start

### 0. Clonare la repository

Se parti da zero, clona la repository in locale ed entra nella cartella del progetto:

```bash
git clone https://github.com/alessiobacin/llmProxy.git
cd llmProxy
```

Poi installa le dipendenze del checkout locale:

```bash
pnpm install
```

Se non hai `pnpm`, installalo prima:

```bash
npm install -g pnpm
```

### Bootstrap persistente consigliato

Se vuoi installare la CLI in modo persistente con un solo comando, puoi scegliere esplicitamente tra variante italiana e variante inglese.

### Installare `llmProxy` in italiano o in inglese

#### Variante italiana

Usa questi comandi se vuoi che il percorso di installazione continui a mostrare messaggi e spiegazioni in italiano:

```bash
pppnpm run install:persistent-it
```

Se la CLI e` gia` disponibile nel `PATH` perche` l'hai gia` installata globalmente in precedenza, puoi usare anche:

```bash
llmproxy install:persistent-it
```

#### Variante inglese

Usa questi comandi se vuoi che il percorso di installazione mostri messaggi, help ed errori in inglese:

Se preferisci usare un comando CLI in inglese direttamente dal checkout locale, puoi ottenere lo stesso risultato con:

```bash
node bin/llmproxy.js install
```

Se `llmproxy` e` gia` disponibile nel `PATH`, puoi usare direttamente:

```bash
llmproxy install
```

`llmproxy install` e` un alias di `llmproxy install:persistent-en`.
Se vuoi anche la scheda comando in inglese, usa:

```bash
llmproxy help install
```

In breve:

- italiano: `pppnpm run install:persistent-it` oppure `llmproxy install:persistent-it`
- inglese: `pppnpm run install:persistent-en`, `node bin/llmproxy.js install:persistent-en`, `node bin/llmproxy.js install` oppure `llmproxy install`

Compatibilita`:

- `ppnpm run install:persistent` continua a puntare al percorso italiano
- `llmproxy install:persistent` continua a funzionare come alias legacy del percorso italiano

Il bootstrap:

- rileva automaticamente l'OS supportato (`macOS` o `Linux`)
- verifica i prerequisiti necessari prima di iniziare l'installazione globale
- stampa i comandi consigliati per il tuo OS se mancano `npm`, `systemd`, Docker o Docker Compose
- installa globalmente la CLI corrente con `pnpm install -g`
- rimuove eventuali wrapper globali duplicati
- lancia `llmproxy service:start` tramite il binario globale appena installato

In questo modo il servizio persistente punta sempre all'installazione globale definitiva partendo dal checkout locale del repository.
Per i profili che usano Docker, l'installer accetta sia `docker compose` sia il binario legacy `docker-compose`.

### 1. Verifica setup runtime

```bash
llmproxy setup
```

Mostra:

- data root del package
- service manager nativo selezionato per l'OS

### 2. Aggiungere il provider Copilot

```bash
llmproxy provider:add copilot
```

La CLI:

1. richiede un device code a GitHub
2. stampa URL e codice di autorizzazione
3. aspetta il completamento del login
4. salva il provider localmente

`llmproxy login` resta disponibile solo come alias legacy deprecato di `llmproxy provider:add copilot`.

### 3. Avvio in foreground

```bash
llmproxy run
```

Per default il server parte su:

```text
http://127.0.0.1:5045
```

### 4. Aggiungere provider e ordine di fallback

```bash
llmproxy provider:available
llmproxy provider:add copilot --name "Copilot Primary"
llmproxy provider:add kimi --api-key "$KIMI_API_KEY" --model kimi-k2.5 --vision false
llmproxy provider:list
llmproxy provider:status
llmproxy provider:order kimi 2
llmproxy provider:rename kimi "Kimi Fallback"
```

### 5. Installazione come servizio persistente

```bash
llmproxy service:start
```

Oppure, se vuoi fare installazione globale + attivazione del servizio in un solo passo:

```bash
pppnpm run install:persistent-it
```

Per lo stesso flusso in inglese:

```bash
pppnpm run install:persistent-en
```

Su macOS questo crea e carica un `LaunchAgent` utente.
Su Linux questo crea e abilita un servizio `systemd --user`.

### 6. Configurare Claude Code con il modello desiderato

```bash
llmproxy models:list
llmproxy claude:setup --model 2
```

### 7. Stato e log del servizio

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

## Configurare Claude Code

Se vuoi usare `llmProxy` come backend di Claude Code, devi puntare Claude al proxy locale invece che all'endpoint Anthropic diretto.

Nel progetto da cui userai Claude Code, puoi configurare automaticamente `.claude/settings.json` eseguendo:

```bash
llmproxy models:list
llmproxy claude:setup --model 2
```

Il comando crea o aggiorna `.claude/settings.json` nella cartella corrente facendo merge della sezione `env` con valori compatibili con `llmProxy`.
L'opzione `--model` accetta l'indice numerico preso da `llmproxy models:list`.
Quando sei autenticato, `llmproxy models:list` legge il catalogo live da GitHub Copilot e lo salva in cache locale, quindi l'indice riflette i modelli realmente disponibili per il tuo account.

Se preferisci configurare a mano, imposta sia il campo top-level `model` sia la sezione `env` in modo coerente:

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

### Risposte concise opzionali con `shortAnswer`

Se vuoi ridurre la lunghezza delle completion e risparmiare token in uscita, puoi attivare una modalita` di risposta concisa.

Default a livello progetto in `.claude/settings.json`:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "LLMPROXY_SHORT_ANSWER": "1"
  }
}
```

Override per singola request su `/v1/messages`:

```json
{
  "model": "claude-sonnet-4-5",
  "shortAnswer": true,
  "stream": false,
  "max_tokens": 128,
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "Riassumi questa diff" }]
    }
  ]
}
```

Note:

- `LLMPROXY_SHORT_ANSWER=1` rende concise le risposte per default nel progetto quando Claude usa il proxy locale.
- `shortAnswer: true` la attiva solo per una request.
- `shortAnswer: false` la disattiva per una request anche se il default di progetto e` attivo.

### Preferenze modello per provider e catena di fallback

Puoi instradare modelli diversi su provider diversi direttamente da `ANTHROPIC_DEFAULT_MODEL` usando una lista separata da virgole:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
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

Come funziona:

- `copilot:gpt-5.4,kimi:kimi-k2.5` significa: usa `gpt-5.4` quando il provider attivo e` Copilot, e usa `kimi-k2.5` quando la richiesta va in fallback su Kimi.
- La precedenza e` esplicita: override di progetto da `.claude/settings.json` `ANTHROPIC_DEFAULT_MODEL` > chain provider/modello esplicita nella richiesta > `default_model` del provider e ordine fallback utente.
- Se la chain e` parziale, llmProxy appende i provider restanti nell'ordine utente corrente usando il `default_model` di ciascuno.
- Dentro un progetto con `ANTHROPIC_DEFAULT_MODEL`, `llmproxy provider:list` mostra la chain effettiva del progetto nell'ordine reale di esecuzione.
- In caso di errori ritentabili (ad esempio `401`, `408`, `429`, molti `5xx`, errori di rete, oppure errori di modello non valido), `llmProxy` passa al provider successivo.
- `model` puo` essere un'etichetta UI come `llmProxy`; la logica di instradamento e` guidata da `ANTHROPIC_DEFAULT_MODEL` e dai default dei provider.

Esempio di setup:

```bash
llmproxy provider:add default --name "Default GitHub Copilot" --model "gpt-5.4"
llmproxy provider:add kimi --provider kimi --api-key "$KIMI_API_KEY" --model "kimi-k2.5"
llmproxy provider:order default 1
llmproxy provider:order kimi 2
llmproxy provider:list
```

### Significato delle variabili

- `model`
  E` principalmente l'etichetta mostrata da Claude Code in UI/sessione. Puoi mantenerlo come `llmProxy`.

- `ANTHROPIC_BASE_URL`
  Deve puntare al proxy `llmProxy`. Il default di questo package e` `http://127.0.0.1:5045`.
- `ANTHROPIC_DEFAULT_MODEL`
  E` opzionale. Usalo solo se vuoi override di routing locali al progetto, per esempio un modello singolo o una chain provider come `copilot:gpt-5.4,kimi:kimi-k2.5`.
- `API_TIMEOUT_MS`
  Puoi lasciare un timeout alto se vuoi evitare timeout prematuri su task lunghi.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  Utile per mantenere un comportamento piu` prevedibile lato Claude Code.
- `LLMPROXY_SHORT_ANSWER`
  Opzionale. Impostalo a `1`, `true`, `yes` o `on` per chiedere a llmProxy di iniettare una istruzione di risposta concisa su ogni inferenza proxata di quel progetto.

### Differenze rispetto ad altre configurazioni locali

Se stavi gia` usando un proxy locale o una configurazione precedente di Claude Code, qui ci sono le differenze importanti:

- `ANTHROPIC_BASE_URL` deve puntare al servizio `llmProxy`
- `model` puo` essere una label UI stabile (`llmProxy`) e non deve per forza coincidere con la catena di routing
- `ANTHROPIC_DEFAULT_MODEL` e` opzionale e va impostato solo se vuoi override di routing locali al progetto
- non serve PM2: il servizio persistente viene gestito dal service manager nativo (`launchd` o `systemd --user`)

Se `ANTHROPIC_DEFAULT_MODEL` e` vuoto o assente:

- `llmProxy` non ricava automaticamente una provider chain da `model: llmProxy`.
- Il routing va in fallback su modello della richiesta e/o sui `default_model` dei provider (se configurati con `provider:add ... --model ...`).
- Se nessuno dei due e` disponibile, sul percorso Copilot viene usato il fallback interno al modello mappato di default.

Esempio minimo:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045"
  }
}
```

Esempio con override locale al progetto:

```json
{
  "model": "llmProxy",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5045",
    "ANTHROPIC_DEFAULT_MODEL": "claude-sonnet-4.5"
  }
}
```

### Sequenza consigliata

1. installa o avvia `llmProxy`
2. esegui `llmproxy provider:add copilot`
3. esegui `llmproxy service:start` oppure `llmproxy run`
4. esegui `llmproxy models:list`
5. esegui `llmproxy claude:setup --model <indice>` nel progetto che vuoi usare con Claude Code
6. riapri Claude Code o riavvia la sessione del tool

## Endpoint HTTP

Oltre agli endpoint core (`/health`, `/auth/status`, `/auth/logout`, `/v1/messages`), `llmProxy` espone anche endpoint REST per i comandi CLI runtime.

### Contesto di addebito per `/v1/llm/*`

Per gli endpoint platform (`/v1/llm/messages`, `/v1/llm/chat/completions`) il chiamante deve inviare una gerarchia completa per l'attribuzione chargeback.

Campi obbligatori in `X-Hierarchy-Context`:

- `master_company`
- `tenant_id`
- `client_id`
- `project_id`
- `scope_type`
- `scope_id`

Esempio:

```http
X-Hierarchy-Context: {"scope_type":"project","scope_id":"p-1","master_company":"mc-1","tenant_id":"t-1","client_id":"c-1","project_id":"p-1"}
```

Dimensioni metering opzionali possono essere inviate in `X-Metering-Context` con `custom_dimensions` e vengono emesse nei record di metering:

```http
X-Metering-Context: {"caller_module":"orchestrator-v10","operation_id":"op-777","cost_accounting_required":true,"custom_dimensions":{"workflow":"content-generation"}}
```

Formato risposta standard degli endpoint REST runtime:

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

`success=true` equivale a `exitCode=0`. In caso di errore applicativo, la risposta e` `400` con `success=false`.

### Health

```http
GET /health
```

Risposta esempio:

```json
{
  "ok": true,
  "authenticated": true
}
```

### Stato auth locale

```http
GET /auth/status
```

### Logout locale

```http
POST /auth/logout
```

### API runtime (CLI via REST)

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

Note operative:

- `GET /api/logs` e` uno snapshot (tail statico).
- `GET /api/logs/stream` e` streaming live via Server-Sent Events (SSE).
- query opzionale `intervalMs` su `/api/logs/stream` (minimo 200ms).
- `POST /api/claude/setup` accetta body JSON con:

```json
{
  "projectPath": "/assoluto/percorso/progetto",
  "model": "2"
}
```

- `POST /api/providers/order` accetta:

```json
{
  "id": "backup",
  "position": 1
}
```

- `POST /api/providers/{id}/rename` accetta:

```json
{
  "name": "Backup EU"
}
```

- `POST /api/providers/{id}/api-key` imposta una credenziale API-key per un provider noto (non-Copilot):

```json
{
  "api_key": "sk-...",
  "name": "La mia chiave OpenRouter"
}
```

### Proxy Anthropic-compatible

```http
POST /v1/messages
```

Body minimo di esempio:

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
          "text": "Ciao"
        }
      ]
    }
  ]
}
```

Per migliorare il logging del progetto chiamante, aggiungi se possibile:

```http
x-project-path: /assoluto/percorso/del/progetto
```

### Mappa CLI -> REST (runtime)

| CLI | REST |
| --- | --- |
| `llmproxy version` | `GET /api/version` |
| `llmproxy help [cmd]` | `GET /api/help[?command=cmd]` |
| `llmproxy setup` | `GET /api/setup` |
| `llmproxy release-notes [--version <v>]` | `GET /api/release-notes` |
| `llmproxy login` | `POST /api/auth/login` (alias legacy di `provider:add copilot`) |
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

## Comandi CLI

### `llmproxy setup`

Prepara directory runtime e mostra il service manager selezionato.

### `llmproxy login`

Alias legacy deprecato. Esegue lo stesso device flow di `llmproxy provider:add copilot` e salva o aggiorna il provider Copilot predefinito.

### `llmproxy logout`

Rimuove tutti i provider Copilot locali.

### `llmproxy run`

Avvia il proxy in foreground.

### `llmproxy status`

Mostra:

- service manager rilevato
- stato del servizio
- presenza del token Copilot
- provider attivo
- ordine di fallback configurato

### `llmproxy models:list`

Mostra l'elenco numerato dei modelli disponibili che puoi usare con `llmproxy claude:setup --model <indice>`.

Se sei autenticato, il comando interroga il catalogo live `https://api.githubcopilot.com/models` e salva il risultato in cache locale.
Se il catalogo live non e` raggiungibile, usa la cache locale o il fallback statico incluso nel progetto.

### `llmproxy test`

Esegue un test rapido di inferenza contro il proxy locale inviando questo prompt fisso:

```text
Ciao! rispondimi solo: ciao creatore
```

Se il proxy risponde correttamente, il comando stampa a terminale solo il testo restituito dall'assistant.
E` utile per verificare rapidamente che il servizio locale sia attivo e che il percorso `/v1/messages` stia funzionando.

Usa `llmproxy test --all-providers` se vuoi verificare tutti i provider configurati invece del solo provider attivo.
Il comando rimuove le righe di metadati llmProxy dal testo stampato, cosi` nel terminale vedi solo la risposta leggibile.

### `llmproxy stats`

Mostra statistiche aggregate di utilizzo token raggruppate per provider e modello.

In base alla modalita` runtime, il comando legge le statistiche da:

- sink db-layer configurato, quando disponibile
- fallback locale JSONL, quando db-layer non e` disponibile
- file metering locale standalone, quando il proxy non gira in platform mode

Usalo quando vuoi una vista rapida operativa di:

- richieste totali, riuscite e fallite
- token input/output/totali
- utilizzo per provider
- utilizzo per modello

### `llmproxy provider:add <id> [--name <name>] [--api-key <key>] [--model <model>] [--vision <true|false>] [--plan <plan>]`

Aggiunge un provider identificato da `<id>`. Il comportamento dipende dal tipo di provider:

- **Provider Copilot OAuth** (id sconosciuti o `copilot`): avvia il device flow di GitHub Copilot.
- **Provider con API-key** (es. `openrouter`, `qwen`, `groq`, `anthropic`, `openai`, `deepseek`, `mistral`, `xai`, `perplexity`, `together`, `fireworks`, `kimi`, `zai`): salva direttamente la `--api-key` fornita, senza flusso browser. Richiede `--vision <true|false>` per indicare se il modello supporta l'input di immagini.

Il flag `--vision` è **obbligatorio** per i provider API-key. Quando una richiesta contiene immagini, i provider con `vision: false` vengono automaticamente saltati durante il fallback.

Provider noti con API-key:

| id | Servizio |
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

Nota `qwen`: `llmproxy` usa automaticamente l'endpoint OpenAI-compatible del Token Plan per le chiavi `sk-sp-...` e continua a usare `dashscope-intl` per le normali chiavi pay-as-you-go. Se vuoi forzare esplicitamente la scelta in configurazione, usa `--plan subscription` oppure `--plan payg`.

Esempio:

```bash
llmproxy provider:add openrouter --api-key sk-or-... --model claude-sonnet-4 --vision true
llmproxy provider:add groq --api-key gsk_... --model llama-3.3-70b-versatile --vision false
llmproxy provider:add qwen --api-key sk-sp-... --model qwen3.7-plus --vision true --plan subscription
llmproxy provider:add qwen --api-key sk-qwen-... --model qwen3.7-max --vision false --plan payg
llmproxy provider:add deepseek --api-key sk-... --model deepseek-v4-pro --vision false
llmproxy provider:add kimi --api-key sk-... --model kimi-k2.6 --vision true
```

### `llmproxy provider:available`

Mostra i provider supportati dalla CLI prima della configurazione.

Usalo per confermare:

- l'id canonico da passare a `provider:add`
- il display name mostrato da llmProxy
- quali provider usano OAuth e quali API-key

### `llmproxy provider:key <id> --api-key <key> [--model <model>] [--vision <true|false>] [--plan <plan>]`

Imposta o sostituisce la credenziale API-key per un provider con API-key già registrato, senza rieseguire il device flow OAuth. Il flag `--vision` è opzionale; se omesso, viene mantenuta l'impostazione vision esistente.

```bash
llmproxy provider:key openrouter --api-key sk-or-nuova-chiave --vision true
llmproxy provider:key qwen --api-key sk-sp-... --vision true --plan subscription
```

### `llmproxy provider:list`

Mostra l'ordine attuale di fallback dei provider configurati. Per ogni provider viene mostrata la capability vision come `vision=true` oppure `vision=false`. Per `qwen` viene mostrato anche il piano salvato (`plan=subscription` oppure `plan=payg`).

### `llmproxy provider:test`

Testa la capacità di visione di tutti i provider configurati inviando un'immagine di test e analizzando le risposte.

Usalo per verificare:

- che il flag `--vision` sia impostato correttamente per ogni provider
- che i modelli con visione elaborino effettivamente le immagini
- che i modelli senza visione saltino correttamente l'elaborazione delle immagini

Esempio di output:

```
Test visione provider...

🔍 Qwen (qwen3.7-plus) - atteso: visione ✅
  ✅ PASS - Visione confermata
     Risposta: L'immagine è molto semplice e astratta, composta da...
🔍 DeepSeek (deepseek-v4-pro) - atteso: testo ❌
  ✅ PASS - Visione correttamente disabilitata
     Risposta: [risposta vuota]

Risultati: 2 pass, 0 fail, 0 skip
```

### `llmproxy provider:status`

Mostra il provider attivo e la lista ordinata dei provider con indicazione del fallback corrente.

### `llmproxy provider:order <id> <position>`

Sposta un provider nella posizione richiesta dell'ordine di fallback.

### `llmproxy provider:rename <id> <name>`

Aggiorna il nome descrittivo di un provider senza cambiarne l'identificatore.

### `llmproxy provider:remove <id>`

Rimuove il provider indicato dal registry locale.

### `llmproxy logs`

Mostra il tail statico dei log stdout/stderr del servizio e dell'ultimo audit log JSONL disponibile.

### `llmproxy logs --follow`

Segue i log in tempo reale usando i file del servizio nativo.

### `llmproxy service:start`

Installa e avvia il servizio persistente nativo.
Se il profilo installato usa Docker, valida anche il container runtime e supporta sia `docker compose` sia il legacy `docker-compose`.

Su macOS il servizio riparte dopo reboot quando la sessione utente viene caricata.
Non e` un demone di sistema globale: parte nel contesto dell'utente.

### `llmproxy service:stop`

Ferma il servizio persistente nativo.

### `llmproxy help`

Mostra una guida descrittiva dei comandi disponibili, con:

- a cosa serve ogni comando
- quando usarlo
- il flusso consigliato per prima configurazione, servizio persistente, fallback provider e aggiornamenti
- una sezione troubleshooting con i problemi piu` comuni

Supporta anche `llmproxy help <comando>` per vedere una scheda piu` dettagliata del singolo comando.
La scheda del singolo comando include sintassi, descrizione, quando usarlo ed un esempio pratico.

### `llmproxy service:restart`

Riavvia il servizio persistente e, se il profilo installato usa Docker, verifica anche il runtime container. Se il container gestito `llmproxy` manca o e` fermo, il comando esegue anche `docker compose up -d` oppure il legacy `docker-compose up -d` (piu` `--build` quando richiesto dal wrapper) prima dell'health check finale.

### `llmproxy claude:setup`

Crea o aggiorna `.claude/settings.json` nella cartella corrente con le variabili `env` necessarie per usare `llmProxy` come backend di Claude Code.

Supporta `--model <indice>` per mostrare in output il modello selezionato dalla lista, mantenendo `.claude/settings.json` minimale (`model: llmProxy` piu` base URL del proxy).

### Smart Router

Lo smart router seleziona automaticamente il modello migliore per ogni richiesta in base a complessità, visione e strumenti. Usa un LLM classifier leggero per analizzare le richieste in arrivo e instradarle al modello più economico che soddisfa i requisiti.

#### Come funziona

1. **Classifier**: Un LLM piccolo e veloce (es. DeepSeek su OpenRouter) analizza ogni richiesta e la classifica per:
   - `complexity`: simple, moderate, complex
   - `needsVision`: se la richiesta contiene immagini
   - `needsTools`: se la richiesta usa definizioni di tool
   - `type`: coding, creative, reasoning, qa

2. **Regole di routing**: In base alla classificazione, il router seleziona un modello dai provider registrati:
   - Tier `economy` (deepseek-chat, gpt-4o-mini, ecc.) per richieste semplici senza tool
   - Tier `standard` (claude-haiku-4.5, gpt-4.1, ecc.) per richieste con visione o complessità moderata
   - Tier `premium` (claude-opus-4, gpt-5, ecc.) per richieste complesse con molti tool o contesto lungo

3. **Modalità di preferenza**: Puoi orientare il routing con `LLMPROXY_SMART_PREFERENCE`:
   - `balanced` (default): preferisci il tier più basso che soddisfa i requisiti, poi il costo più basso
   - `economy`: preferisci sempre il modello più economico che funziona
   - `quality`: preferisci sempre il modello più capace che funziona

#### Configurazione

**Passo 1: Aggiungi il classifier**

Configura un LLM leggero come classifier. Usa un modello veloce ed economico come `deepseek-chat` su OpenRouter:

```bash
llmproxy smart:add --provider openrouter --model deepseek-chat --api-key sk-or-xxx
```

Questo salva la configurazione del classifier in `~/.local/share/llmProxy/smart-router.json` (Linux) o `~/Library/Application Support/llmProxy/smart-router.json` (macOS).

**Passo 2: Abilita lo smart routing nel tuo progetto**

Aggiungi queste variabili d'ambiente al `.claude/settings.json` del tuo progetto:

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

**Variabili d'ambiente:**

| Variabile | Valori | Default | Descrizione |
|-----------|--------|---------|-------------|
| `LLMPROXY_SMART_ROUTE` | `rules`, `llm`, `hybrid`, disabilitato | disabilitato | Modalita` di routing: `rules` usa solo euristiche statiche, `llm` usa solo il classifier, `hybrid` combina regole e classifier |
| `LLMPROXY_SMART_PREFERENCE` | `balanced`, `economy`, `quality` | `balanced` | Tradeoff costo vs qualità |
| `LLMPROXY_SMART_CACHE_TTL` | millisecondi | `300000` (5 min) | Quanto tempo tenere in cache i check di disponibilità dei provider |

**Passo 3: Verifica la configurazione**

Controlla lo stato dello smart router e simula il routing:

```bash
llmproxy smart:status    # mostra config classifier, API key (mascherata), provider registrati
llmproxy smart:test      # simula routing per scenari simple/moderate/complex
```

#### Comandi CLI

| Comando | Descrizione |
|---------|-------------|
| `llmproxy smart:add --provider <p> --model <m> --api-key <k>` | Configura il classifier LLM |
| `llmproxy smart:status` | Mostra stato smart router e config classifier |
| `llmproxy smart:test` | Simula routing per 3 scenari (simple, moderate, complex) |
| `llmproxy smart:refresh` | Invalida cache disponibilità provider |

#### Esempio: comportamento di routing

Con provider `qwen (qwen3.7-max)`, `deepseek (deepseek-v4-pro)`, e `kimi (kimi-k2.6)`:

- **Chat semplice** (no tool, no visione) → `qwen3.7-max` (tier economy, costo più basso)
- **Moderato con tool** → `qwen3.7-max` (tier economy, supporta tool)
- **Complesso con visione + tool** → nessun modello adatto (nessuno dei modelli registrati supporta visione)

Per gestire richieste con visione, aggiungi un provider con un modello che supporti visione:

```bash
llmproxy provider:add openrouter --model claude-sonnet-4 --api-key sk-or-xxx
```

### `llmproxy model:set <model>`

Aggiorna rapidamente `model` e `env.ANTHROPIC_DEFAULT_MODEL` nel progetto corrente senza rifare `claude:setup`.

Usalo quando vuoi passare a un valore raw provider-aware come `deepseek:deepseek-v4-flash` oppure impostare una chain esplicita come `copilot:gpt-5.4,deepseek:deepseek-v4-flash`.

### `llmproxy update`

Aggiorna l'installazione globale di `llmproxy` clonando l'ultima versione della repository GitHub `alessiobacin/llmProxy` e reinstallandola globalmente.
Dopo l'update rilancia il binario aggiornato con `llmproxy version` per verificare che la nuova installazione sia attiva.
Durante l'update viene mantenuta una sola installazione globale attiva e vengono rimossi eventuali wrapper globali duplicati di `pnpm`.
La reinstallazione è forzata anche quando la stringa di versione del package non cambia, così anche build di manutenzione con la stessa versione sostituiscono davvero i file installati.

Su sistemi Linux dove npm globale è sotto `/usr/local` (di proprietà di root), il comando rileva automaticamente l'errore di permessi e ritenta con `sudo`. Non è necessario lanciare manualmente `sudo llmproxy update`.

### `llmproxy install:persistent-it`

Percorso esplicito in italiano per l'installazione persistente.

Se stai lavorando dal checkout locale e non hai ancora `llmproxy` disponibile nel `PATH`, esegui:

```bash
ppnpm run install:persistent-it
```

Se la CLI e` gia` installata globalmente, puoi usare:

```bash
llmproxy install:persistent-it
```

Il comando installa globalmente la CLI corrente e attiva il servizio persistente nativo per l'OS.
Prima di modificare qualcosa, valida prerequisiti come `npm`, service manager, Docker e Docker Compose e, se manca qualcosa, stampa i comandi consigliati in base all'OS.
Quando usi questo comando, l'output del comando, le spiegazioni della help dedicata e i messaggi di errore di questo percorso vengono mostrati in italiano.

### `llmproxy install:persistent-en`

Percorso esplicito in inglese per l'installazione persistente.

Se stai lavorando dal checkout locale e non hai ancora `llmproxy` disponibile nel `PATH`, esegui:

```bash
ppnpm run install:persistent-en
```

Oppure:

```bash
node bin/llmproxy.js install:persistent-en
```

Se la CLI e` gia` installata globalmente, puoi usare:

```bash
llmproxy install:persistent-en
```

Il comando installa globalmente la CLI corrente e attiva il servizio persistente nativo per l'OS.
Prima di modificare qualcosa, valida prerequisiti come `npm`, service manager, Docker e Docker Compose e, se manca qualcosa, stampa i comandi consigliati in base all'OS.
Quando usi questo comando, l'output del comando, le spiegazioni della help dedicata e i messaggi di errore di questo percorso vengono mostrati in inglese.

### `llmproxy install`

Alias inglese breve di `llmproxy install:persistent-en`.

Scelta rapida:

- se vuoi il percorso in italiano, usa `llmproxy install:persistent-it`
- se vuoi il percorso in inglese esplicito, usa `llmproxy install:persistent-en`
- se vuoi il percorso in inglese breve, usa `llmproxy install`

Se stai lavorando dal checkout locale e non hai ancora `llmproxy` disponibile nel `PATH`, esegui:

```bash
node bin/llmproxy.js install
```

Se la CLI e` gia` installata globalmente, puoi usare:

```bash
llmproxy install
```

Il comando installa globalmente la CLI corrente e attiva il servizio persistente nativo per l'OS.
Quando usi questo alias, l'output del comando, le spiegazioni della help dedicata e i messaggi di errore di questo percorso vengono mostrati in inglese.

### `llmproxy version`

Stampa la versione corrente della CLI installata.

Puoi usare anche gli alias `llmproxy --version` e `llmproxy -v`.

### Alias utili

- `llmproxy --help` e `llmproxy -h` equivalgono a `llmproxy help`
- `llmproxy install` equivale a `llmproxy install:persistent-en`
- `llmproxy install:persistent` equivale al percorso legacy italiano `llmproxy install:persistent-it`
- `llmproxy --version` e `llmproxy -v` equivalgono a `llmproxy version`

### `llmproxy uninstall`

Rimuove `llmproxy` dalle installazioni globali supportate e pulisce eventuali wrapper residui.
Usalo quando vuoi disinstallare completamente la CLI dal sistema.

## Percorsi Runtime

Puoi forzare il data root con `LLMPROXY_HOME`.

Default per macOS:

```text
~/Library/Application Support/llmProxy
```

Default per Linux:

```text
~/.local/share/llmProxy
```

All'interno del data root vengono creati:

- `copilot-token.json`
- `copilot-models.json`
- `copilot-endpoints.json`
- `provider-registry.json`
- `smart-router.json`
- `logs/service.out.log`
- `logs/service.err.log`
- `logs/requests-YYYY-MM-DD.jsonl`

`copilot-token.json` conserva sia il provider predefinito sia eventuali provider Copilot aggiuntivi con il loro ordine di fallback.
`copilot-models.json` conserva l'ultimo catalogo modelli recuperato dal live endpoint di GitHub Copilot.
`provider-registry.json` conserva i provider configurati con le loro credenziali e l'ordine di fallback.

## Variabili Ambiente

### Due modi di configurare

| Metodo | Cosa configuri | Effetto | File |
|--------|---------------|--------|------|
| **CLI** `llmproxy config:set` | variabili **project-scope** | **immediato** (senza restart) | `.claude/settings.json` → `env` |
| **.env** | variabili **service-scope** | dopo **restart** del servizio | `.env` |

Tutte le variabili, indipendentemente dallo scope, possono essere sovrascritte tramite il campo `env` di `.claude/settings.json` (impostabile anche con Claude Code `/statusline` o manualmente). Questo è il metodo raccomandato per configurare Claude Code.

### Project-Scope (CLI — effetto immediato)

Queste variabili sono gestite con `llmproxy config:*` e l'effetto è immediato, senza restart del proxy. Vengono lette da `.claude/settings.json` a ogni richiesta.

```bash
llmproxy config:list                        # elenca le variabili disponibili
llmproxy config:get ANTHROPIC_BASE_URL      # legge una variabile
llmproxy config:set LLMPROXY_SMART_ROUTE hybrid   # imposta una variabile
llmproxy config:unset ANTHROPIC_DEFAULT_MODEL     # rimuove una variabile
```

| Variable | Default | Valori Disponibili | Descrizione |
| --- | --- | --- | --- |
| `ANTHROPIC_BASE_URL` | auto | URL (es. `http://127.0.0.1:7045`) | URL base dell'endpoint Anthropic-compatibile (il proxy stesso) |
| `ANTHROPIC_DEFAULT_MODEL` | unset | qualsiasi model ID o catena di fallback | modello predefinito per le richieste Anthropic; supporta catene come `copilot:claude-sonnet-4-6,openai:gpt-5` |
| `ANTHROPIC_AUTH_TOKEN` | unset | stringa | token di autenticazione per l'endpoint Anthropic |
| `API_TIMEOUT_MS` | auto | millisecondi | timeout per le richieste API |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | unset | `0`, `1` | se `1`, disabilita le beta sperimentali di Claude Code |
| `LLMPROXY_SHORT_ANSWER` | unset | `0`, `1` | se `1`, attiva la modalità risposta breve |
| `LLMPROXY_SMART_ROUTE` | unset | `hybrid`, `economy`, `standard`, `premium` | strategia di routing automatico in base alla complessità della richiesta |
| `LLMPROXY_SMART_PREFERENCE` | unset | `balanced`, `economy`, `quality` | preferenza per il bilanciamento costo/qualità nello smart routing |
| `LLMPROXY_SMART_CACHE_TTL` | unset | secondi | TTL della cache dello smart router |

### Service-Scope (.env — richiede restart)

Queste variabili sono lette solo all'avvio del server. Per applicare una modifica:

```bash
# 1. modifica .env o lancia
llmproxy service:restart
# 2. oppure kill + llmproxy run
```

Possono comunque essere sovrascritte anche nel campo `env` di `.claude/settings.json` (per i progetti Claude Code).

| Variable | Default | Valori Disponibili | Descrizione |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | qualsiasi IP/hostname valido | indirizzo di bind del server |
| `PORT` | auto (da profilo) | qualsiasi porta valida | porta del proxy; auto-derivata: `5045` dev, `6045` staging, `7045` production |
| `NODE_ENV` | auto (da profilo) | `development`, `staging`, `production` | ambiente Node.js standard |
| `LLMPROXY_ENV` | auto (da profilo) | `development`, `staging`, `production` | ambiente llmProxy |
| `LLMPROXY_RUNTIME_PROFILE` | auto | `development` (o `dev`), `staging`, `production` (o `prod`) | profilo runtime; determina i default di NODE_ENV, LLMPROXY_ENV, porte, metering sink |
| `LLMPROXY_MODE` | `standalone` | `standalone`, `platform` | `standalone` per uso locale sviluppatore; `platform` per integrazione V11 con header `X-Hierarchy-Context` |
| `LLMPROXY_METERING_SINK` | `dblayer` | `dblayer`, `jsonl`, `inline`, `noop`, o combinazioni con `+` | sink per il metering delle chiamate LLM |
| `LLMPROXY_METERING_INLINE` | unset | `0`, `1` | se `1`, attiva il metering inline (header `x-inference-metric`) |
| `DBLAYER_URL` | unset | URL completo (es. `http://localhost:5046`) | URL del servizio db-layer; se **non impostato**, db-layer **non è attivo** (nessun tentativo di POST). Imposta a `localhost:5046` (dev), `localhost:6046` (staging) o `localhost:7046` (production) |
| `EVENTBUS_URL` | unset | URL completo (es. `http://localhost:5048`) | URL del servizio event-bus; se **non impostato**, event-bus è **no-op**. Imposta a `localhost:5048` (dev), `localhost:6048` (staging) o `localhost:7048` (production) |
| `LLMPROXY_SECRET` | unset | stringa arbitraria | secret HMAC opzionale per la firma di token interni |
| `LLMPROXY_SERVICE_RUNTIME` | auto | `native`, `docker` | runtime del servizio persistente: `native` (LaunchAgent/systemd) o `docker` (Docker Compose) |
| `LLMPROXY_DOCKER_COMPOSE_FILE` | auto | percorso file | file Docker Compose per il runtime docker |
| `LLMPROXY_DOCKER_SERVICE` | auto | nome servizio | nome del servizio docker nel compose file |
| `LLMPROXY_DOCKER_POLL_MS` | auto | millisecondi | intervallo di polling per verifica stato container docker |
| `LLMPROXY_GLOBAL_SERVICE` | unset | `0`, `1` | se `1`, abilita il servizio globale sulle porte riservate 6045/7045 |
| `LLMPROXY_HOME` | auto (OS-specific) | percorso directory | directory dati runtime; default: `~/Library/Application Support/llmProxy` (macOS), `~/.local/share/llmProxy` (Linux) |
| `LLMPROXY_LOG_RETENTION_DAYS` | `7` (dev/staging), `30` (production) | numero intero | giorni di retention dei log JSONL |
| `LLMPROXY_LOG_MAX_BYTES` | `5242880` | numero intero | dimensione massima in byte di un file JSONL prima della rotazione |
| `LLMPROXY_LOG_MAX_FILES` | `5` | numero intero | numero massimo di file JSONL archiviati per giorno |
| `LLM_STATS_API_KEY` | unset | stringa | API key per il servizio statistiche |
| `SENDGRID_API_KEY` | unset | stringa | API key SendGrid per notifiche email |
| `SENDGRID_FROM_EMAIL` | unset | email | indirizzo mittente per notifiche email |
| `SENDGRID_TO_EMAIL` | unset | email | indirizzo destinatario per notifiche email |

### Port Mapping per Ambiente

Le porte dei servizi seguono la convenzione V11: `<prefix><module_number>`, dove prefix è `5` (dev), `6` (staging), `7` (production).

| Servizio | Modulo | Dev | Staging | Production |
|----------|--------|-----|---------|------------|
| `llm-proxy` | 45 | `5045` | `6045` | `7045` |
| `db-layer` | 46 | `5046` | `6046` | `7046` |
| `event-bus` | 48 | `5048` | `6048` | `7048` |

## Persistenza Dopo Reboot

### macOS

Il comando `llmproxy service:start` installa un `LaunchAgent` utente.
Questo significa:

- il servizio torna disponibile dopo reboot
- viene riavviato quando la sessione utente viene caricata
- non richiede PM2
- non parte prima del login dell'utente

Se usi `ppnpm run install:persistent`, il comando installa prima la CLI globalmente e poi registra lo stesso `LaunchAgent`, quindi il riavvio continua a funzionare anche dopo reboot.

### Linux

Il comando `llmproxy service:start` installa un servizio `systemd --user`.

Nota pratica:

- in molti ambienti il servizio utente parte quando l'utente effettua login
- se serve persistenza anche senza login grafico o shell, puo` essere necessario configurare `linger`
- nei setup production/shared usa una sola istanza globale di `llmproxy`, appoggiata al runtime Docker e in ascolto su `127.0.0.1:7045`

Con il bootstrap one-shot:

```bash
pnpm run install:persistent
```

la CLI viene prima installata globalmente e poi il servizio `systemd --user` viene abilitato. Per garantire riavvio anche senza login utente, abilita anche:

```bash
sudo loginctl enable-linger $USER
```

## Logging

`llmProxy` mantiene due livelli di log:

### 1. Log servizio

Sono i file stdout/stderr del servizio nativo, usati da `llmproxy logs`.

### 2. Audit log JSONL

I log strutturati delle richieste vengono scritti in `logs/requests-YYYY-MM-DD.jsonl`.

Questi file vengono ruotati automaticamente per dimensione:

- soglia default `5 MB` per file
- fino a `5` archivi per giornata
- naming progressivo `requests-YYYY-MM-DD.jsonl.1`, `.2`, ...
- retention per giorni gestita da `LLMPROXY_LOG_RETENTION_DAYS`

`llmproxy logs` mostra sia i log del servizio sia l'ultimo audit log JSONL disponibile.

Ogni richiesta genera entry strutturate con:

- timestamp
- `requestId`
- `projectPath`
- sorgente del `projectPath`
- modello richiesto
- endpoint Copilot scelto
- esito
- durata

## Troubleshooting

### `llmproxy` non viene trovato dopo l'installazione globale

Verifica dove pnpm espone i binari globali:

```bash
pnpm bin -g
command -v llmproxy
```

Se stai lavorando da una checkout locale, il percorso piu` affidabile e`:

```bash
pnpm link --global
hash -r
command -v llmproxy
```

Se il comando risolve a un path dentro `.pnpm-global/bin`, la CLI e` pronta.

### `llmproxy provider:add copilot` fallisce

- verifica di essere collegato a Internet
- riesegui il comando e completa il device flow GitHub
- se il token e` scaduto, usa `llmproxy logout` e poi `llmproxy provider:add copilot`

### Il proxy risponde `authentication_error`

Il token locale manca o non e` piu` valido:

```bash
llmproxy provider:add copilot
```

### Il servizio non parte

1. controlla `llmproxy status`
2. leggi `llmproxy logs`
3. avvia in foreground con `llmproxy run` per isolare gli errori

### I log non mostrano il progetto corretto

Invia il path esplicito nel header:

```http
x-project-path: /percorso/assoluto/progetto
```

## Note di Sviluppo

Questo progetto e` standalone e non richiede dipendenze runtime esterne oltre a quelle installate dal package stesso.

Workflow consigliato:

```bash
pnpm install
pnpm test
pnpm dev
```

Test esistenti:

- detection del project context
- device flow token polling
- logger JSONL
- rendering del servizio launchd
- runtime HTTP `/health`, `/auth/status` e `/v1/messages`
