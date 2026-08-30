# Review — commit `368885c` (remediation T3.1–T3.4)

- **Reviewer:** reviewer-01
- **Branch:** `task/qa-full-audit` (worktree `.worktrees/qa-full-audit`)
- **Commit revisionato:** `368885c` "fix(qa): remediate full-audit findings (T3.1-T3.4)" — 7 file, +208/−22
- **Base:** `3e756f3` (matrice T1)
- **Metodo:** diff `3e756f3..368885c`, build `tsc -p tsconfig.json` rieseguita, suite completa rieseguita (`npm test`), verifica dei commit citati nel report (ae90e88, 48e326f, be91ec9, e2e86cc, ad9e202, f29a5c3), grep superfici doc.

---

## Verdetto

# ✅ APPROVED

Nessuna issue bloccante. Tutti e 4 i ticket T3.1–T3.4 soddisfano il contratto QA; le modifiche ai test sono correzioni di attese stale legittime (nessun test cancellato o indebolito); la coerenza `src/ ↔ lib/ts-build` è verificata sperimentalmente (build rieseguita → diff zero); suite verde confermata da esecuzione autonoma.

**Evidenza suite rieseguita (reviewer, non solo coder):** `npm test` = **769 test, 767 pass, 0 fail, 2 skip** — identico a quanto dichiarato dal coder. Duration ~7.5s.

---

## Asse 1 — Standard repo

| Check | Esito | Evidenza |
|---|---|---|
| Zero `@ts-ignore` / `@ts-expect-error` nuovi | ✅ | Nessuno nei file toccati. |
| Zero `any` nuovi | ✅ | `src/gateway/services/llm-transport.ts:5,7` hanno `any` ma **pre-esistenti** (shim `require` con `eslint-disable no-explicit-any`), NON introdotti dal commit (diff 368885c non li tocca). Nessun nuovo `any`. |
| Strict TS / build pulita | ✅ | `npm run build:ts` rieseguito: compila senza errori (tsc strict). |
| Coerenza `src/ ↔ lib/ts-build` | ✅ | Dopo `build:ts` il `diff --stat` della cartella `lib/ts-build` è **vuoto** → il file committato `lib/ts-build/gateway/services/llm-transport.js` è esattamente il prodotto di `src/gateway/services/llm-transport.ts` (nessun drift, nessun edit manuale). |
| TDD / test prima del codice | ✅ | Commit contiene test nuovi per ogni fix (T3.1: attese aggiornate in app/cli/copilot-proxy test; T3.2: 3 test nuovi; T3.3: 2 test CLI + 1 test REST nuovi; T3.4: 2 test nuovi help+upsert). Nessun test **rimosso**: il totale è 769 vs 762 baseline (+7). |
| Nessun test indebolito per nascondere failure | ✅ | Analisi puntuale in Asse 2: ogni modifica di attesa è giustificata da un commit di riferimento specifico o da una correzione di mock. I 2 SKIP sono pre-esistenti (systemd, non toccati). |
| `lib/copilot-proxy.js`, `lib/cli.js`, README come fonti JS/direct | ✅ | Coerente: nessuna attesa di corrispondenza TS; cli.js/README corretti in place, nessun sorgente TS da sincronizzare. |

---

## Asse 2 — Contratto QA, ticket per ticket

### T3.1 — Fix 10 FAIL baseline ✅ APPROVED

Tutti i 10 FAIL della baseline sono corretti; nessuna modifica di test è un indebolimento. Verifica puntuale:

1. **app.test.js:1511 `trims oldest messages` (4→3, 3→2)** — legittima. Commit citati verificati: `ae90e88` introduce il system prompt TASK_STATUS (2 occorrenze nel patch), `48e326f` lo rimuove (3 occorrenze). Il trim conta i messaggi non-system; l'aspettativa 4/3 era rimasta dell'era TASK_STATUS. La modifica riallinea alla realtà post-`48e326f`. Le asserzioni semantiche residue (`/assistant reply/`, `/latest user/`, `doesNotMatch /oldest user/`) confermano che il comportamento *trim* è ancora verificato, non eluso.
2. **subtest `meta` (fallback API-key provider)** — legittima e tecnicamente corretta. Verificato in `lib/copilot-proxy.js`: `meta` ha `protocol: "meta-responses"` (riga 118) con `responsesUrl: "https://api.meta.ai/v1/responses"` (riga 119) e `translateResponsesApiResponseToAnthropic` (riga 825) attende lo shape `output[].content[].output_text`. Il mock precedente (OpenAI-shape) era sbagliato per il protocollo Responses → stringa vuota. Nuovo mock restituisce la shape Responses corretta; l'asserzione URL ora ammette `responsesUrl` (aggiunta alternativa, non sostituzione che elude: `chatCompletionsUrl`/`messagesUrl` restano accettati). Il test continua ad asserire testo di risposta, conteggio chiamate e modello atteso.
3–4. **UI labels ×2 (`llmProxy`/`llm-proxy`)** — **fix di regressione reale, non modifica di test**. Confermata la causa: `be91ec9` (verificato via `git show`) ha introdotto esattamente `defaultModel: requestedModel && requestedModel.trim() ? requestedModel.trim() : (first.default_model || null)` nel ramo token-store di `resolveProviderSelection`. La fix in `src/gateway/services/llm-transport.ts` (defaultModel → `null` quando nessun modello richiesto) è il fix corretto:
   - Il top-level `defaultModel` alimenta `modelOverride` in `lib/app.js:1074` (`projectSettings.configuredModel || effectiveRequestedModelInput || providerSelection.defaultModel`) che inietta `canonicalBody.model`. Con `first.default_model` veniva forzato il default del **primo** provider su **tutti** i fallback (kimi provava `gpt-5.4` prima del proprio `kimi-k2.5`). Con `null`, `modelOverride` non scatta e ogni provider usa il proprio default tramite `buildProviderModelCandidates` (`fallbackDefaultModel = provider.default_model`, copilot-proxy.js:961).
   - **Path registry-backed non rotto:** `providerRegistry`/provider esplicito (righe 39–116 dell'output compilato) mantengono `defaultModel` dal `default_model` del provider esatto — il fix tocca SOLO il ramo fallback token-store senza requestedModel.
   - **Caso "modello esplicito provato sul primo provider" preservato:** con requestedModel presente, `defaultModel` resta il modello richiesto (riga 168). Il test **"messages endpoint tries a provider default model before moving to the next provider"** (app.test.js:2217, ancora presente e verde nella suite: parte dei 767) copre esattamente il path: prima chiamata `gpt-5.4` (modello esplicito), fallback 400 → seconda chiamata `kimi-k2.5` (default del provider). La fix non tocca questo ramo (requestedModel non vuoto) → il contratto "tries a provider default model before moving to the next provider" resta soddisfatto e testato. ✅
5–6. **short-answer ×2** — legittima: le due asserzioni rimosse verificavano il testo TASK_STATUS `/At the start of every assistant reply/`, rimosso da `48e326f`. La parte short-answer resta verificata (`/Respond as briefly as possible/` in un test; `doesNotMatch` nell'altro). Non è un indebolimento: si rimuove l'asserzione su testo che non esiste più, non si alleggerisce l'asserzione sul comportamento sotto test.
7. **cli.test.js:2382 nvidia endpoints** — legittima. `provider:add` ora esegue enrichment benchmark cloudprice fire-and-forget (`fetchCodingScore`); il test attende deterministicamente (deadline 2s, poll 10ms) le 3 URL e le asserisce **tutte e 3** (provider + 2 benchmark), invece di ignorare le nuove chiamate. L'attesa temporizzata è deterministica (semplicemente aspetta che il fire-and-forget completi), non un *sleep* per mascherare flake: asserisce richieste **aggiuntive reali**, non ne sopprime.
8. **cli.test.js:2434 max_tokens 256→1024** — legittima. `e2e86cc` ("allow reasoning models enough probe tokens") confermato nel log del branch; il test era rimasto a 256. Atteso ora 1024, coerenza con l'intento dichiarato del commit.
9. **copilot-proxy.test.js:196 legacy max_tokens 16** — legittima. `ad9e202` ("use max_completion_tokens for entire openai provider") confermato; il test ora asserisce `max_tokens undefined` + `max_completion_tokens: 16`, che è il nuovo contratto OpenAI. Il test resta stringente (asserisce l'assenza del campo legacy **e** la presenza del nuovo).

**Conclusione T3.1:** 6 attese stale giustificate da commit citati (verificati), 1 mock corretto per protocollo reale, 1 regressione vera (`be91ec9`) fixata nel punto giusto, 0 test cancellati, 0 indebolimenti. Suite verde confermata.

### T3.2 — stats:reset --hard (rimozione promessa) ✅ APPROVED

- `lib/cli.js` COMMAND_HELP `stats:reset` (righe 545–549): usage, description, example aggiornati — **nessuna** menzione di `--hard`, smart-router, auto-rank. Descrizione profilo: solo "Azzera tutte le statistiche di utilizzo (metering records)".
- Riga guida overview (riga 728): `llmproxy stats:reset` senza `[--hard]` né "resetta anche cache e auto-rank".
- Implementazione (riga 6277): il handler tronca solo metering; **nessun** codice `--hard` residuo (grep su lib/cli.js: solo alias `sa:r` e voci help sopra; il flag, se passato, viene ignorato silenziosamente dal parser — backward compat, come dichiarato).
- Superfici doc controllate con grep ricorsivo (`smart router` / `auto-rank` / `--hard` in README, README-IT, cli.js, bin, docs): i soli residui sono
  - `README.md:1188` — menzione **storica/fattuale** ("after the smart router removal") a proposito di `LLMPROXY_PRICE_PERFORMANCE_ROUTING` ancora disponibile: non è una promessa di reset, è contesto storico. OK.
  - `docs/nextUp/auto-rank.md` — documento di **design futuro** esplicitamente "per implementazione futura": non dichiara che `stats:reset --hard` resetti nulla di attuale. Fuori contratto T3.2 (il contratto era: promesse in help/overview — rimosse). OK.
  - `README-IT.md:1014` elenca `smart-router.json` tra i file del data root: nessun codice scrive più `smart-router.json` (grep su lib/src/bin = 0 hit). È **drift documentale residuo** → dominio docs-sync (fase 2 / T5), non bloccante per T3.2. Notificato a docs-sync.
- Test nuovi: help singola voce e overview non menzionano smart-router/auto-rank (`doesNotMatch` regex con optional `.?`); stats:reset funziona senza flag e tronca davvero metering (delta file letto). 3 test, tutti stringenti.

### T3.3 — provider:remove id inesistente ✅ APPROVED

- **CLI** (`lib/cli.js`, riga ~6052): prima di `clearProvider`, `const existing = providerStore.getProvider(providerId); if (!existing) { stderr.write(\`Provider non trovato: ${providerId}\n\`); return 1; }`. Contratto rispettato: exit 1 + stderr `Provider non trovato: <id>`.
- **REST** (`lib/app.js:734`): `DELETE /api/providers/:id` → `executeCliCommand(["provider:remove", providerId])` → `jsonFromCliResult` (app.js:49): `exitCode !== 0` → **status 400**, `success:false`, `data.error = stderr` ("Provider non trovato: <id>"). Contratto rispettato. Test REST nuovo (app.test.js:3599−3604) asserisce 400 + `success:false` + match `data.error`.
- **Success path intatto:** `clearProvider` + exit 0 + "Provider rimosso: <id>" invariati; test esistente in `runtime CLI commands` (providerRemoveResponse 200 success:true) ancora verde, più test CLI nuovo `provider:remove deletes an existing provider` (exit 0, entry rimossa dal file ricaricato). Nessun effetto collaterale su altri comandi provider.

### T3.4 — proxy:add id=dominio / upsert stesso-host ✅ APPROVED

- **Coerenza con `lib/proxy-store.js`:** `addProxy` (riga 68): `hostname = extractHostname(url)` è l'**id**; se esiste già un proxy con stesso id → **upsert** (`existing.url = normalizedUrl; existing.name = name || existing.name; existing.updated_at`) — nessun warning, nessuna seconda entry. La documentazione ora dichiara esattamente questo comportamento ("id = dominio/hostname", "--name è solo etichetta, NON è l'id", "Riaggiungere lo stesso dominio sovrascrive l'URL esistente (upsert voluto)"). Coerente al 100% con l'implementazione.
- **Coerenza con test store:** `tests/proxy-store.test.js` "addProxy with duplicate hostname updates the existing proxy" già copriva l'upsert come voluto: la documentazione ora riflette il comportamento già testato (nessuna modifica di comportamento, solo doc — scelta dichiarata dal coder e coerente col verdetto del verifier al pass 24).
- **Help `proxy:add`** (cli.js COMMAND_HELP): descrizione aggiornata con dominio/--name/upsert. Il test `proxy:add help documents that the id is the URL hostname...` asserisce `/dominio/i`, `/--name/i`, `/sovrascriv/i` — presente e verde.
- **README §6 Proxy Registry:** 3 punti aggiunti (id=dominio, --name etichetta, upsert stesso-host) + esempi `proxy:remove`/`proxy:reorder` corretti per usare il dominio (es. `proxy.esempio.com` invece dello storico `proxy-a.com` incoerente con l'id reale generato dall'URL). Esempi coerenti con la semantica reale.
- Test CLI upsert nuovo (`proxy:add with the same hostname upserts...`): seconda add con URL diverso stesso host → exit 0, `proxy:list` mostra UNA entry con la nuova URL (9999) e NON la vecchia (10001), nome aggiornato. Verifica esattamente il contratto documentato.

---

## Note minori (non bloccanti, per planner/docs-sync)

1. **README-IT.md:1014** — `smart-router.json` elencato tra i file del data root ma nessun codice lo crea più (dopo `f29a5c3`). Drift documentale → T5/docs-sync.
2. **README.md:1188** — menzione "after the smart router removal": storica e fattuale, nessuna azione richiesta (solo segnalazione).
3. **`any` pre-esistenti** in `src/gateway/services/llm-transport.ts:5,7` (shim require con eslint-disable): non introdotti da questo commit; eventuale pulizia (`import type` o `unknown` + cast stretto) fuori scope remediation, opzionale.
4. **Commit non pushato** e **version bump non eseguito**: come da istruzioni (compito planner al finalize). Ricordare bump 0.3.119 → 0.3.120 prima del push (regola CLAUDE.md).

---

## Deliverable

- Questo file: `qa-audit/review-368885c.md` (nel worktree, NON committato — attende il finalize planner).
- Sezione report: vedi "## Round 4 — reviewer (reviewer-01)" appesa con `report_append` (slug `qa-full-audit`).
- Verdetto finale: **APPROVED** — il coder può procedere; nessun re-work richiesto.