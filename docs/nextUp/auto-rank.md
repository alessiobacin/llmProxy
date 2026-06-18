# Auto-Rank Dinamico + CLI `configura`

Documento di riepilogo per implementazione futura. Per i dettagli tecnici completi (algoritmo, schema, edge case) fare riferimento a:

- `~/.claude/plans/vorrei-creare-un-sistema-ticklish-treasure.md` — piano dettagliato
- `~/.claude/plans/HANDOFF-auto-rank.md` — handoff di sessione con pattern di codice esistenti da riusare
- `~/.claude/plans/riprendi-dal-handoff-in-luminous-eclipse.md` — piano operativo consolidato

---

## Idea

llmProxy oggi gestisce l'ordine di fallback dei provider manualmente (`provider:order`). L'utente vuole che il proxy si **auto-riordini ogni ora** in base a una classifica LLM scaricata da **llm-stats** (endpoint reale `api.zeroeval.com`), scegliendo fino a **10 coppie (provider, modello)** con **max 2 slot per provider** tramite una strategia configurabile.

In parallelo, l'utente vuole un comando CLI unificato (`llmproxy configura`) per gestire le env di auto-rank + sendgrid + llm-stats senza editare `.env` a mano.

---

## Funzionalità

### 1. Auto-rank dinamico

- **Strategia di default `coding_value`**: sort `top_scores.code` DESC → top-N → sort composito pesato `coding(0.6) + context(0.2) + speed(0.2)` → scegli provider più economico → cap 10 slot + cap 2/provider.
- **5 strategie v1**: `most_powerful`, `powerful_under_cost`, `cheapest_in_tier`, `balanced`, `coding_value` (default).
- **Scheduler**: `setInterval` con `unref()` dentro `createApp`, gira solo se servizio persistente attivo (launchd/systemd). Prima run al boot.
- **Grace period**: al primo tick riordina solo; cap 10 enforcement dal secondo tick.
- **Tie-break**: provider con `(inputPerM + outputPerM)` minore per lo stesso modello.
- **Cache fallback**: TTL configurabile (default 7d). Se llm-stats giù e cache stale → no-op + log warn.
- **Provider auto-rimosso**: `provider:add` lo ripristina, ricandidato al prossimo tick.
- **Gemini**: scartato dal matching automatico v1 (llm-stats lo mette sotto `google`); utente aggiunge manualmente con `provider:add opencode --model gemini-3.1-pro-preview`.

### 2. Email alerts SendGrid (3 casi)

- Modello vincitore non offerto da nessun provider configurato → scartato + alert.
- Modello offerto da un solo provider e quel provider non è configurato → scartato + alert.
- Provider più economico non fra i configurati (ma fra SUPPORTED_PROVIDERS) → modello assegnato comunque, ma alert con comando `provider:add <cheap-id> --model <m> --api-key ...` e risparmio %.

Dedup via `last-alerts.json` per coppia `(model, suggestedProviderId)`.

### 3. CLI `configura` (configurazione unificata)

- `llmproxy configura` — mostra tutte le chiavi + source (env/file/default), secret mascherati.
- `llmproxy configura --set KEY=VAL` — scrive in `.env` (preserva commenti, ordine, scrittura atomica).
- `llmproxy configura --unset KEY` — rimuove da `.env`.
- `llmproxy configura --reset` — ripristina defaults (con conferma interattiva y/N).
- `llmproxy configura <sezione>` — `auto-rank`, `sendgrid`, `llm-stats`.
- `llmproxy configura --show-secrets` — mostra secret in chiaro.
- `llmproxy configura --global --set KEY=VAL` — replica in `.env.example`.

Mappa nomi CLI (kebab-case) → env var (UPPER_SNAKE) autoreferenziale (es. `--set top-n=20` → `LLMPROXY_AUTO_RANK_TOP_N`).

Validazione: pesi compositi sommano a 1.0; tipi corretti (number/boolean/secret/string).

Dopo `--set` log warning "riavvia con `llmproxy service:restart`".

---

## Endpoint HTTP

- `GET  /api/auto-rank/status`
- `POST /api/auto-rank/run-once`
- `PUT  /api/auto-rank/config`

---

## Comandi CLI

- `llmproxy auto-rank:config [--enabled true|false] [--top-n N] [--strategy <name>] [--coding-weight X] [--context-weight X] [--speed-weight X] [--max-input-cost X] [--max-output-cost X] [--interval-ms N] [--cache-ttl-days N] [--max-slots N] [--max-per-provider N] [--reset]`
- `llmproxy auto-rank:status`
- `llmproxy auto-rank:run-once`
- `llmproxy auto-rank:clear-cache`
- `llmproxy configura [auto-rank|sendgrid|llm-stats] [--set KEY=VAL] [--unset KEY] [--reset] [--show-secrets] [--global]`

Enhancement `llmproxy provider:list` con colonne `input $X.XX/M` / `output $X.XX/M` (lette da cache llm-stats, `n/a` se vuota) + footer slot/alert counter.

---

## Strutture dati

### `auto-rank-config.json`
```json
{
  "enabled": false,
  "topN": 20,
  "maxInputPerM": null,
  "maxOutputPerM": null,
  "codingWeight": 0.6,
  "contextWeight": 0.2,
  "speedWeight": 0.2,
  "intervalMs": 3600000,
  "cacheTtlMs": 604800000,
  "maxSlots": 10,
  "maxPerProvider": 2,
  "isFirstTick": true
}
```
I 3 pesi devono sommare a 1.0 (validato al setConfig).

### `llm-stats-cache.json`
```json
{
  "schemaVersion": 1,
  "fetchedAt": "2026-06-17T07:00:00.000Z",
  "source": "https://api.zeroeval.com/stats/v1/models",
  "models": [
    {
      "model": "claude-opus-4-7",
      "displayName": "Claude Opus 4.7",
      "coding": 0.93,
      "general": 0.95,
      "contextWindow": 200000,
      "vision": true,
      "tools": true,
      "tier": "premium",
      "familyKey": "claude-opus",
      "organization": "anthropic",
      "providers": [
        { "name": "anthropic", "inputPerM": 5.0, "outputPerM": 25.0, "throughputTps": 42.0, "latencyS": 0.5, "status": "active" }
      ]
    }
  ]
}
```

### `auto-rank-last-alerts.json`
Dedup alerts SendGrid: `{ alerts: [{ model, suggestedProviderId, sentAt }] }`.

---

## File da creare

### Foundation (configura)
- `lib/env-config.js` — load/set/unset .env preservando commenti, scrittura atomica
- `lib/config-schema.js` — schema dichiarativo chiavi
- `lib/config-validator.js` — validazione tipi + pesi

### Auto-rank
- `lib/llm-stats-source.js` — fetch a 2 fasi (catalog paginato + top-N detail parallelo), retry, timeout
- `lib/auto-rank-engine.js` — 5 strategie + `enforceSlotCap` (puro)
- `lib/auto-rank-store.js` — config JSON (mirror di `smart-router-store.js`)
- `lib/auto-rank-cache.js` — snapshot normalizzato (mirror di `smart-router-cache.js`)
- `lib/auto-rank-runner.js` — orchestratore `runOnce` con mutex, grace period, cheaper-provider log
- `lib/sendgrid-notifier.js` — digest email con dedup, cap 10/invio
- `lib/version-family.js` — `extractFamilyKey` (solo metadato diagnostico, no dedup)

### Test
- `tests/env-config.test.js`
- `tests/config-validator.test.js`
- `tests/llm-stats-source.test.js`
- `tests/auto-rank-engine.test.js`
- `tests/auto-rank-store.test.js`
- `tests/auto-rank-cache.test.js`
- `tests/auto-rank-runner.test.js`
- `tests/sendgrid-alerts.test.js`
- `tests/version-family.test.js`

## File da modificare
- `lib/paths.js` — 3 nuovi path: `llmStatsCacheFile`, `autoRankConfigFile`, `lastAlertsFile`
- `lib/app.js` — wiring runner + 3 endpoint HTTP + scheduler `setInterval.unref()`
- `lib/cli.js` — comando `configura` (3 sezioni) + 4 comandi `auto-rank:*` + enhancement `provider:list`
- `.env.example` — chiavi `LLMPROXY_AUTO_RANK_*` + `LLM_STATS_BASE_URL` (le altre già presenti)

---

## Env vars

| Nome | Default | Note |
|---|---|---|
| `LLM_STATS_API_KEY` | (none) | già presente |
| `LLM_STATS_BASE_URL` | `https://api.zeroeval.com` | **nuovo** |
| `LLMPROXY_AUTO_RANK_ENABLED` | `false` | **nuovo** |
| `LLMPROXY_AUTO_RANK_TOP_N` | `20` | **nuovo** |
| `LLMPROXY_AUTO_RANK_INTERVAL_MS` | `3600000` | **nuovo** |
| `LLMPROXY_AUTO_RANK_CODING_WEIGHT` | `0.6` | **nuovo** |
| `LLMPROXY_AUTO_RANK_CONTEXT_WEIGHT` | `0.2` | **nuovo** |
| `LLMPROXY_AUTO_RANK_SPEED_WEIGHT` | `0.2` | **nuovo** |
| `LLMPROXY_AUTO_RANK_CACHE_TTL_DAYS` | `7` | **nuovo** |
| `LLMPROXY_AUTO_RANK_MAX_SLOTS` | `10` | **nuovo** |
| `LLMPROXY_AUTO_RANK_MAX_PER_PROVIDER` | `2` | **nuovo** |
| `LLMPROXY_AUTO_RANK_MAX_INPUT_PER_M` | (none) | **nuovo**, opzionale |
| `LLMPROXY_AUTO_RANK_MAX_OUTPUT_PER_M` | (none) | **nuovo**, opzionale |
| `SENDGRID_API_KEY` | (none) | già presente, ora letto |
| `SENDGRID_FROM_EMAIL` | (none) | già presente, ora letto |
| `SENDGRID_TO_EMAIL` | (none) | già presente, ora letto |

---

## Mapping llm-stats → SUPPORTED_PROVIDERS (v1)

llm-stats elenca vendor diretti + gateway. **v1 considera SOLO i vendor diretti** come match per assegnare un modello a un provider configurato. I gateway (deepinfra, novita, openrouter, fireworks, together, groq, perplexity) finiscono negli alerts "suggerisci di aggiungere provider X" se l'utente NON li ha già configurati.

| llm-stats `provider_id` | llmProxy `providerId` |
|---|---|
| `anthropic` | `anthropic` |
| `openai` | `openai` |
| `deepseek` | `deepseek` |
| `xai` | `xai` |
| `mistral` | `mistral` |
| `qwen`, `alibaba`, `alibaba_cloud` | `qwen` |
| `moonshotai`, `kimi`, `moonshot` | `kimi` |
| `zhipu`, `zai`, `zhipuai` | `zai` |
| `google`, `gemini`, `google_gemini` | (nessuno, scartato) |
| `meta`, `meta_llama` | (nessuno, scartato) |
| gateway (deepinfra, novita, openrouter, …) | match diretto SE configurati |

---

## Edge case risolti

1. **Family key**: suffisso parte della chiave, nessun dedup. `version-family.js` solo diagnostico.
2. **Migrazione >10 provider**: grace period (1° tick riordina, 2° tick enforce cap 10).
3. **Email freq**: dedup via `last-alerts.json` su `(model, suggestedProviderId)`.
4. **Scope alerts**: tutti i 10 vincitori.
5. **Template email**: unico con campi `current_provider/suggested_provider/current_price/suggested_price/savings_pct/recommendation`.
6. **Slot per provider**: max 2 (vedi decisione §8 handoff).
7. **Provider auto-rimosso**: solo disattivando auto-rank (no `--pin` in v1).
8. **Cache vuota**: colonne `n/a` in `provider:list`.
9. **clearProvider fail**: 1 retry 200ms + log.
10. **Schema version**: `schemaVersion: 1`, scarta se mancante/diverso.
11. **Concorrenza**: mutex in-memory nel runner.
12. **Configura mascheramento**: secret `***` di default, `--show-secrets` per rivelare.
13. **Configura restart warning**: dopo `--set`, log "riavvia con `llmproxy service:restart`".
14. **Configura --reset**: conferma interattiva readline y/N.

---

## Verifica end-to-end

1. `npm test` — tutti i test (esistenti + 9 nuovi) passano.
2. `llmproxy configura` → tabella completa con source; secret mascherati.
3. `llmproxy configura --set auto-rank.top-n=20 --set auto-rank.coding-weight=0.7` → errore (pesi != 1.0).
4. `llmproxy auto-rank:status` → `enabled: false`, cache vuota.
5. `llmproxy auto-rank:config --enabled true`.
6. `llmproxy auto-rank:run-once` → fetch reale, 10 slot, alerts cheaper-provider.
7. `llmproxy provider:list` → colonne `input/output` popolate + footer slot counter.
8. **Cap 10**: 15 provider configurati, run-once, 10 restano (1° tick NON rimuove → 2° tick sì).
9. **Cap 2/provider**: 1 solo provider, top-5 modelli tutti suoi → solo 2 slot.
10. **Cache fallback**: `LLM_STATS_API_KEY=invalid`, run-once → cache fresh riusata, altrimenti no-op.
11. **HTTP**: `curl localhost:5045/api/auto-rank/status` → JSON.
12. **Persistent**: `llmproxy service:restart`, attendere 60s, `auto-rank tick` nei log.
13. **Email**: provider cheap non configurato → ricevuta email con comando `provider:add ...`.

---

## Out of scope v1
- Multi-tenancy del config auto-rank.
- Provider con scelta multi-modello.
- Override `--pin` per rifiutare un provider dal ranking.
- Notifiche Slack/Discord in aggiunta a email.
- Storico variazioni di prezzo / cost-trend.
- `configura` per TUTTE le env di llmProxy (solo auto-rank + sendgrid + llm-stats in v1).
