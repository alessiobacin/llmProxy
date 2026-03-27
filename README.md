# llmProxy

`llmProxy` e` un package standalone che espone un proxy GitHub Copilot Anthropic-compatible su `/v1/messages` e una CLI globale per login, avvio, status, log, servizio persistente e fallback tra piu` account GitHub Copilot.
## Quick Start

### 1. Verifica setup runtime

```bash
llmproxy setup
```

Mostra:

- data root del package
- service manager nativo selezionato per l'OS

### 2. Login a GitHub Copilot

```bash
llmproxy login
```

La CLI:

1. richiede un device code a GitHub
2. stampa URL e codice di autorizzazione
3. aspetta il completamento del login
4. salva il token localmente

### 3. Avvio in foreground

```bash
llmproxy run
```

Per default il server parte su:

```text
http://127.0.0.1:3015
```

### 4. Aggiungere un provider Copilot di fallback

```bash
llmproxy provider:add backup --name "Backup Copilot"
llmproxy provider:list
llmproxy provider:status
llmproxy provider:order backup 1
llmproxy provider:rename backup "Backup EU"
```

### 5. Installazione come servizio persistente

```bash
llmproxy service:start
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

Se preferisci configurare a mano, usa una sezione `env` simile a questa:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "proxy-local",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
    "ANTHROPIC_DEFAULT_MODEL": "claude-opus-4.5",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  }
}
```

### Significato delle variabili

- `ANTHROPIC_AUTH_TOKEN`
  Con `llmProxy` puo` essere un valore fittizio non vuoto, per esempio `proxy-local`.
- `ANTHROPIC_BASE_URL`
  Deve puntare al proxy `llmProxy`. Il default di questo package e` `http://127.0.0.1:3015`.
- `ANTHROPIC_DEFAULT_MODEL`
  Deve essere un modello supportato da GitHub Copilot. Puoi ricavarlo da `llmproxy models:list`.
- `API_TIMEOUT_MS`
  Puoi lasciare un timeout alto se vuoi evitare timeout prematuri su task lunghi.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  Utile per mantenere un comportamento piu` prevedibile lato Claude Code.

### Differenze rispetto ad altre configurazioni locali

Se stavi gia` usando un proxy locale o una configurazione precedente di Claude Code, qui ci sono le differenze importanti:

- `ANTHROPIC_BASE_URL` deve puntare al servizio `llmProxy`
- `ANTHROPIC_DEFAULT_MODEL` deve essere un modello GitHub Copilot valido
- non serve PM2: il servizio persistente viene gestito dal service manager nativo (`launchd` o `systemd --user`)

Esempio minimo:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3015",
    "ANTHROPIC_DEFAULT_MODEL": "claude-sonnet-4.5"
  }
}
```

### Sequenza consigliata

1. installa o avvia `llmProxy`
2. esegui `llmproxy login`
3. esegui `llmproxy service:start` oppure `llmproxy run`
4. esegui `llmproxy models:list`
5. esegui `llmproxy claude:setup --model <indice>` nel progetto che vuoi usare con Claude Code
6. riapri Claude Code o riavvia la sessione del tool

## Endpoint HTTP

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

### Proxy Anthropic-compatible

```http
POST /v1/messages
```

Body minimo di esempio:

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

## Comandi CLI

### `llmproxy setup`

Prepara directory runtime e mostra il service manager selezionato.

### `llmproxy login`

Esegue il device flow GitHub Copilot e salva o aggiorna il provider predefinito `default`.

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

### `llmproxy provider:add <id> [--name <name>]`

Esegue un nuovo login GitHub Copilot e salva un provider aggiuntivo identificato da `id`.

### `llmproxy provider:list`

Mostra l'ordine attuale di fallback dei provider Copilot configurati.

### `llmproxy provider:status`

Mostra il provider attivo e la lista ordinata dei provider Copilot con indicazione del fallback corrente.

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

Riavvia il servizio persistente nativo.

### `llmproxy claude:setup`

Crea o aggiorna `.claude/settings.json` nella cartella corrente con le variabili `env` necessarie per usare `llmProxy` come backend di Claude Code.

Supporta `--model <indice>` per impostare `ANTHROPIC_DEFAULT_MODEL` dal catalogo modelli disponibile.

### `llmproxy update`

Aggiorna l'installazione globale di `llmproxy` clonando l'ultima versione della repository GitHub `alessiobacin/llmProxy` e reinstallandola globalmente.
Dopo l'update rilancia il binario aggiornato con `llmproxy version` per verificare che la nuova installazione sia attiva.
Durante l'update viene mantenuta una sola installazione globale attiva e vengono rimossi eventuali wrapper globali duplicati di `pnpm`.

### `llmproxy version`

Stampa la versione corrente della CLI installata.

Puoi usare anche gli alias `llmproxy --version` e `llmproxy -v`.

### Alias utili

- `llmproxy --help` e `llmproxy -h` equivalgono a `llmproxy help`
- `llmproxy --version` e `llmproxy -v` equivalgono a `llmproxy version`

### `llmproxy uninstall`

Rimuove `llmproxy` dalle installazioni globali supportate e pulisce eventuali wrapper residui.
Usalo quando vuoi disinstallare completamente la CLI dal sistema.

### `llmproxy status`

Mostra:

- service manager rilevato
- stato del servizio
- presenza del token Copilot
- provider attivo
- ordine di fallback configurato

### `llmproxy provider:add <id> [--name <name>]`

Esegue un nuovo login GitHub Copilot e salva un provider aggiuntivo identificato da `id`.

### `llmproxy provider:list`

Mostra l'ordine attuale di fallback dei provider Copilot configurati.

### `llmproxy provider:status`

Mostra il provider attivo e la lista ordinata dei provider Copilot con indicazione del fallback corrente.

### `llmproxy provider:order <id> <position>`


### `llmproxy provider:remove <id>`

Rimuove il provider indicato dal registry locale.

### `llmproxy logs`

Mostra il tail statico dei log stdout/stderr del servizio.

### `llmproxy logs --follow`

Segue i log in tempo reale usando i file del servizio nativo.

### `llmproxy service:start`

Installa e avvia il servizio persistente nativo.

Su macOS il servizio riparte dopo reboot quando la sessione utente viene caricata.
Non e` un demone di sistema globale: parte nel contesto dell'utente.

### `llmproxy service:stop`

Ferma il servizio persistente nativo.

### `llmproxy service:restart`

Riavvia il servizio persistente nativo.

### `llmproxy claude:setup`

Crea o aggiorna `.claude/settings.json` nella cartella corrente con le variabili `env` necessarie per usare `llmProxy` come backend di Claude Code.

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
- `logs/service.out.log`
- `logs/service.err.log`
- `logs/requests-YYYY-MM-DD.jsonl`

`copilot-token.json` conserva sia il provider predefinito sia eventuali provider Copilot aggiuntivi con il loro ordine di fallback.
`copilot-models.json` conserva l'ultimo catalogo modelli recuperato dal live endpoint di GitHub Copilot.

## Variabili Ambiente

Vedi anche [.env.example](.env.example).

| Variabile | Default | Uso |
| --- | --- | --- |
| `PORT` | `3015` | porta del proxy |
| `HOST` | `127.0.0.1` | host bind del server |
| `LLMPROXY_HOME` | auto | cartella dati runtime |
| `LLMPROXY_LOG_RETENTION_DAYS` | `7` | retention dei log JSONL |
| `LLMPROXY_LOG_MAX_BYTES` | `5242880` | dimensione massima di un file JSONL prima della rotazione |
| `LLMPROXY_LOG_MAX_FILES` | `5` | numero massimo di file JSONL archiviati per giornata |

## Persistenza Dopo Reboot

### macOS

Il comando `llmproxy service:start` installa un `LaunchAgent` utente.
Questo significa:

- il servizio torna disponibile dopo reboot
- viene riavviato quando la sessione utente viene caricata
- non richiede PM2
- non parte prima del login dell'utente

### Linux

Il comando `llmproxy service:start` installa un servizio `systemd --user`.

Nota pratica:

- in molti ambienti il servizio utente parte quando l'utente effettua login
- se serve persistenza anche senza login grafico o shell, puo` essere necessario configurare `linger`

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

### `llmproxy login` fallisce

- verifica di essere collegato a Internet
- riesegui il comando e completa il device flow GitHub
- se il token e` scaduto, usa `llmproxy logout` e poi `llmproxy login`

### Il proxy risponde `authentication_error`

Il token locale manca o non e` piu` valido:

```bash
llmproxy login
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