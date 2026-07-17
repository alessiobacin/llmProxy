# Proxy Registry & Rotation — Design

## Goal
Aggiungere alla CLI `llmproxy` un sistema di proxy registrati con rotazione automatica in failover sequenziale, simile al sistema provider esistente.

## Storage
Nuovo file `proxy-registry.json` in `dataRoot` (accanto a `copilot-token.json`).

```json
{
  "version": 1,
  "proxies": [
    {
      "id": "dc.decodo.com",
      "url": "http://user:pass@dc.decodo.com:10001",
      "host": "dc.decodo.com",
      "created_at": 1700000000000,
      "updated_at": 1700000000000
    }
  ],
  "order": ["dc.decodo.com"]
}
```

L'ID è auto-generato dal dominio estratto dalla URL.

## Modulo: `lib/proxy-store.js`

Pattern identico a `token-store.js`: `createProxyStore({ filePath })` → API:

| Metodo | Descrizione |
|---|---|
| `addProxy(url)` | Aggiunge/aggiorna proxy, genera ID dal nome host |
| `removeProxy(id)` | Rimuove per ID |
| `listProxies()` | Restituisce array ordinato |
| `setProxyOrder(ids)` | Imposta ordine completo |
| `getProxy(id)` | Restituisce un proxy per ID |
| `getAllProxyUrls()` | Restituisce array di URL in ordine |

## Comandi CLI

| Comando | Descrizione |
|---|---|
| `proxy:add <url>` | Aggiunge proxy |
| `proxy:list` | Elenca proxy |
| `proxy:remove <id>` | Rimuove proxy |
| `proxy:reorder` | Riordina proxy |
| `proxy:test` | Testa tutti i proxy |

Alias brevi: `px:a`, `px:l`, `px:rm`, `px:ro`, `px:t`.

## Rotazione — `--proxy` senza valore

Quando un provider viene aggiunto con `--proxy` (flag nudo, senza URL), il sistema non salva un proxy_url specifico sul provider. Al momento della richiesta:

1. Legge la lista dei proxy registrati in ordine
2. Prova il primo — se la connessione fallisce, passa al successivo
3. Continua fino a successo o esaurimento lista
4. Fallimento totale → errore "nessun proxy disponibile"

La rotazione è **per-request**: non c'è un contatore persistente. Ogni richiesta parte dal primo proxy in lista.

## `provider:test --all-proxies`

Estensione del comando `provider:test` esistente: testa ogni provider configurato attraverso ciascun proxy registrato, mostrando successo/fallimento per ogni combinazione.

## Compatibilità

- `--proxy <url>` (con valore) = comportamento esistente: proxy specifico salvato sul provider
- `--proxy` (senza valore) = nuova rotazione
- `--proxy-key` non serve per la rotazione (le credenziali sono già nella URL del proxy registrato)
- Assenza di `--proxy` = nessun proxy (come oggi)
