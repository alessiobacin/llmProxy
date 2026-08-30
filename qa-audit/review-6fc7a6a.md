# Review — commit `6fc7a6a` (fix residui QA R1–R3)

- **Reviewer:** reviewer-01
- **Branch:** `task/fix-residui-qa` (worktree `.worktrees/fix-residui-qa`)
- **Commit revisionato:** `6fc7a6a` "fix(qa): close R1-R3 QA residui" — 6 file, +297/−1
- **Base:** `03bcbb2` (merge task/qa-full-audit, version 0.3.120)
- **Metodo:** diff `03bcbb2..6fc7a6a`, build `tsc` rieseguita, suite completa rieseguita, esecuzione isolata dei nuovi test, probe indipendente del path "provider exhausted", lettura dei path di emissione metering in `lib/copilot-proxy.js`/`lib/metering.js`/`lib/ts-build/gateway/metering/attribution.js`.

---

## Verdetto

# ⚠️ CHANGES_REQUESTED

Una issue di accuratezza contratto (R3 — doc/assertion) + note minori. Il comportamento **implementativo** è corretto e i 6 test metering **verificano davvero** l'emissione (non sono tautologici); ma il nome/commento del test "exhausted" e la riga README.md:627 dichiarano `PROVIDER_FALLBACK_EXHAUSTED` per un caso in cui NON viene emesso — il test passa solo perché le sue asserzioni sono più deboli della sua dichiarazione. Da correggere con un secondo commit (piccolo) e re-review.

---

## Asse 1 — Standard repo

| Check | Esito | Evidenza |
|---|---|---|
| Zero `@ts-ignore` / `any` | ✅ | Il commit tocca solo `lib/cli.js`, `lib/app.js` (JS), test e README. Nessun sorgente TS modificato, nessun `any`/`@ts-ignore` introdotto. |
| TDD red→green | ✅ (con nota) | T1/T2: comportamento cambiato con test aggiornati (cambio 400→404 sull'asserzione REST esistente + 1 test nuovo CLI). R3: contratto già implementato → 6 test pin (verde immediato, dichiarato e verificabile — i test osservano il path reale, vedi sotto). |
| Nessun test cancellato/indebolito | ✅ (1 eccezione di accuratezza, vedi issue 1) | app.test.js: solo update 400→404 (aggiornamento contratto, non indebolimento); cli.test.js: +1; metering-contract.test.js: +6. Nessuna cancellazione. L'eccezione: il test *exhausted* dichiara `PROVIDER_FALLBACK_EXHAUSTED` ma asserisce meno — non nasconde una failure, ma è un'asserzione inaccurata. |
| Build / coerenza `src ↔ lib/ts-build` | ✅ | `npm run build:ts` rieseguito: compilazione OK, `git diff --stat -- lib/` **vuoto** → nessun drift (il commit non tocca sorgenti TS; atteso e verificato). |
| Suite completa | ✅ | `npm test` rieseguito dal reviewer: **776 test, 774 pass, 0 fail, 2 skip** (identico a dichiarazione coder; skip systemd pre-esistenti). |

---

## Asse 2 — Contratto spec, ticket per ticket

### T1 — R1: stats:reset rifiuta flag sconosciuti ✅ APPROVED

- `lib/cli.js` (blocco `stats:reset`): `Object.keys(parsed.flags)` non vuoto → stderr `Flag non supportato per stats:reset: --<flag>. Il comando non accetta flag; uso: llmproxy stats:reset` + **exit 1**, PRIMA del truncate. `--hard` → exit 1, `metering.jsonl` intatto.
- `stats:reset` senza flag: invariato (tronca, exit 0) — test esistente verde.
- Help: COMMAND_HELP e riga guida NON ri-introducono `--hard` (nessuna modifica in questo commit; puliti da QA T3.2) — grep confermato: zero occorrenze `--hard` nell'help.
- Edge verificato: `llmproxy --help` short-circuita nel parser (cli.js:296) → `help` comando; `stats:reset --help` NON short-circuita (tokens[0]=="stats:reset") → va nel nuovo guard → exit 1 "Flag non supportato: --help". Prima della fix, `stats:reset --help` **truncava silenziosamente il metering** (flag ignorato). Il nuovo comportamento è più corretto (nessun truncate accidentale), coerente con "il comando non accetta flag". Nota UX minore, non bloccante.
- Test nuovo (`stats:reset rejects unknown flags like --hard...`): eseguito in isolamento → PASS (1 test, 0 fail). Asserisce exit 1, stderr con `--hard`, stdout senza "Statistiche azzerate", **file intatto**.

### T2 — R2: DELETE /api/providers/:id → 404 ✅ APPROVED

- `lib/app.js` (handler DELETE): se `exitCode !== 0` E stderr matcha `/Provider non trovato/i` → **404** con payload identico nella forma a `jsonFromCliResult` (app.js:49): `success:false, exitCode, command, data:{output, error}, timestamp`. Altri errori CLI → 400 via `jsonFromCliResult` (invariato). Successo → 200 (test esistente `providerRemoveResponse.status === 200`, `success:true`).
- Allineamento con `DELETE /v1/llm/providers/:id` (già 404) dichiarato e verificato nel codice (app.js:940).
- Test: asserzione REST aggiornata 400→404, mantiene `success:false` e `data.error` `/Provider non trovato/`. Suite verde.
- Nota nit (non bloccante): il ramo 404 usa `result.stdout || ""` mentre `jsonFromCliResult` usa `cliResult.stdout` grezzo. Non osservabile in pratica (`provider:remove` scrive sempre stdout su successo o stderr su errore), ma per coerenza si potrebbe uniformare il fallback vuoto anche in `jsonFromCliResult`.

### T3 — R3: contratto metering richieste fallite ⚠️ ISSUE 1 (accuratezza doc/asserzione), resto APPROVED

**I 6 test NON sono tautologici.** Verificato il percorso completo:
- `createApp({ meteringSink })` → `sinkRefs.meteringSink` (app.js:214, 294) → passato a `executeGatewayRequest` (app.js:1170) → `proxyAnthropicRequest` → `emitRequestMetering` → `emitMetering(meteringSink, record)` (copilot-proxy.js:1926) → `sink.record()` (attribution.js:109-114) → il noop sink cattura in `records`; `inspect()` restituisce i record **osservati dal path reale**, non replicati.
- I test iniettano il sink in `createApp` e quindi fanno passare la richiesta attraverso il **gateway reale** (copilot-proxy), con `fetchFn` mocked solo per il provider. Nei test di gate pre-proxy, `fetchFn` **lancio un'eccezione** se chiamata → dimostra che nessun provider viene tentato.
- Corrispondenza codice↔asserzioni verificata:
  - (a) 401 provider → `AUTH_REQUIRED` (copilot-proxy.js:2354: `errorCode: response.status === 401 ? "AUTH_REQUIRED" : \`HTTP_${response.status}\``) → test 1 esatto (1 record, success:false, provider openai, AUTH_REQUIRED, model_used).
  - (b) network error → `NETWORK_ERROR` (copilot-proxy.js:2255-2260) → test 2 esatto (502, 1 record, NETWORK_ERROR, success:false).
  - (c) gate 401 pre-proxy → middleware app.js:273-290 respinge PRIMA del handler (nessun record; fetchFn mai chiamata) → test 4 esatto.
  - (d) gate 503 prod (LLMPROXY_API_KEY vuota + runtime profile production) → app.js:283 `SERVICE_MISCONFIGURED` → test 5 esatto. `runtimeProfile` deriva da `resolveRuntimeProfile({ env: runtimeEnv })` (app.js:199) → `options.env` funziona (verificato: app.js:179 `const runtimeEnv = options.env || process.env`).
  - (f) nessun provider configurato → copilot-proxy.js:1942 (list::empty → 401 prima di ogni attempt, nessun record) → test 6 esatto.
  - (e) "tutti i provider falliti" → **vedi ISSUE 1**.

**ISSUE 1 (bloccante per il contratto R3, contenuta):**
`tests/metering-contract.test.js` — test "all providers exhausted is metered once with success:false PROVIDER_FALLBACK_EXHAUSTED" + commento ("One record for the exhausted fallback (per-provider failure 503 is folded into the final record...)") e `README.md:627` ("quando tutti i provider/modelli/tentativi falliscono viene emesso un record finale `success: false` con `error_code: PROVIDER_FALLBACK_EXHAUSTED`") dichiarano che il caso "tutti i provider falliti" emette `PROVIDER_FALLBACK_EXHAUSTED`. **Non è così nel caso testato.**

Probe indipendente del reviewer (stessa configurazione del test, 1 provider openai, 503):
```
status: 503
n records: 1
error_codes: [ 'HTTP_503' ]
success flags: [ false ]
```
Il path in-loop (copilot-proxy.js:2360-2362) emette il record dell'ultimo tentativo (`HTTP_503`) e fa `return` — il record finale `PROVIDER_FALLBACK_EXHAUSTED` (copilot-proxy.js:2798-2807) NON viene raggiunto quando l'ultimo tentativo fallisce con status. `PROVIDER_FALLBACK_EXHAUSTED` scatta solo quando il loop termina SENZA un return terminale (es. candidati vuoti / skip vision / fine loop senza attempt terminale). Il test passa solo perché asserisce `records.length >= 1` + `some(success === false)` — più debole del nome/commento, e il commento "folded into the final record" è inaccurato (non c'è folding: esiste 1 solo record, `HTTP_503`).

La spec T3 richiede "record finale success:false (PROVIDER_FALLBACK_EXHAUSTED o equivalente)" — il record `HTTP_503` success:false È accettabile come equivalente, quindi l'implementazione va bene; è la **documentazione e l'asserzione** ad essere incoerenti col comportamento reale (asse di review esplicito: "la documentazione README è coerente col comportamento?").

**Fix proposto (minimo):**
1. `README.md:627` — riformulare: dopo il fallimento di tutti i tentativi, il record terminale porta l'`error_code` dell'ultimo tentativo fallito (`AUTH_REQUIRED` / `HTTP_<status>` / `NETWORK_ERROR`); `PROVIDER_FALLBACK_EXHAUSTED` è emesso quando il loop di fallback termina senza un tentativo provider riuscito ad agganciare un errore HTTP (es. nessun candidato modello valido). Oppure, se si vuole preservare il claim, correggere il path per emettere davvero `PROVIDER_FALLBACK_EXHAUSTED` anche nell'exhausted-by-status (decisione di implementazione, non necessaria per la spec).
2. `tests/metering-contract.test.js` — allineare nome/commento e asserzioni: o asserire `error_code` `HTTP_503` (o `AUTH_REQUIRED`) come record terminale in questo scenario (più forte dell'attuale `>=1`), o ridefinire il test per il path che produce davvero `PROVIDER_FALLBACK_EXHAUSTED`. Il commento "folded into the final record" va corretto.

**Note minori (non bloccanti):**
- N1: `stats:reset --help` → exit 1 "Flag non supportato: --help" (prima: truncate accidentale). Comportamento corretto, UX da documentare se desiderata (non nel contratto).
- N2: uniformare `result.stdout || ""` in `jsonFromCliResult` (vedi T2 nota nit).
- N3: `docs/nextUp/auto-rank.md` resta l'unica superficie che menziona auto-rank (design futuro) — nessuna modifica richiesta qui, coerente con QA T3.2.

---

## Riepilogo per il coder

- **CHANGES_REQUESTED** per ISSUE 1 (README.md:627 + tests/metering-contract.test.js test exhausted: dichiarazione `PROVIDER_FALLBACK_EXHAUSTED` vs comportamento reale `HTTP_503` nel caso con status provider).
- T1 ✅, T2 ✅, resto di T3 ✅ (i 5 test pre-proxy/provider-error ed emissione reale sono corretti e NON tautologici).
- Dopo il fix, re-review sul secondo commit (dovrebbe essere piccolissimo: wording README + asserzione/commento test).

## Deliverable

- Questo file: `qa-audit/review-6fc7a6a.md` (nel worktree, NON committato).
- Sezione report: "## Round 2 — reviewer (reviewer-01)" appesa con `report_append` (slug `fix-residui-qa`).
- Verdetto: **CHANGES_REQUESTED** (1 issue puntuale + note).
---

## Re-review — commit `fa9edca` (fix ISSUE 1 R3 + nit)

- **Commit revisionato:** `fa9edca` "fix(qa): align R3 metering contract docs/tests with real emission paths" (3 file, +67/−11)
- **Base:** `6fc7a6a` (APPROVED su T1/T2, CHANGES_REQUESTED su ISSUE 1 R3)

# ✅ APPROVED

ISSUE 1 risolta completamente. Verdetto finale per l'intero branch `task/fix-residui-qa` (`03bcbb2 → 6fc7a6a → fa9edca`): **APPROVED**.

### Verifica ISSUE 1 (R3)

1. **README.md** — contratto riscritto in 2 bullet: (a) il record terminale di un fallback esaurito porta l'`error_code` dell'**ultimo tentativo** (`AUTH_REQUIRED`/`HTTP_<status>`/`NETWORK_ERROR`); (b) `PROVIDER_FALLBACK_EXHAUSTED` compare solo quando il loop termina **senza alcun tentativo** (es. richiesta immagini, nessun provider vision-capable). **Accurato** rispetto al comportamento reale verificato con probe indipendente.
2. **tests/metering-contract.test.js**:
   - Test *"all providers exhausted carries the last provider's HTTP error code"* — ora asserisce il comportamento reale: `records.length === 1`, `success === false`, `error_code === "HTTP_503"`, `provider === "openai"`. Forte e preciso (non più `>=1`/`some`). Verde in isolamento e nella suite.
   - **Nuovo test** *"all providers skipped (no attempt) is metered with PROVIDER_FALLBACK_EXHAUSTED"* — esercita DAVVERO il path loop-senza-tentativi: provider unico `vision: false` + richiesta con blocco immagine → il loop salta con `continue` (copilot-proxy.js:2098-2105, `skippedReason: "no_vision_support"`), `fetchFn` lancia se chiamata (mai chiamata), response 502 con `"Tutti i provider configurati hanno fallito."` (copilot-proxy.js:2795-2797), record unico `success:false` + `PROVIDER_FALLBACK_EXHAUSTED` + `provider: null`. **Verificato indipendentemente dal reviewer con probe dedicato:** status 502, error type api_error, message "Tutti i provider configurati hanno fallito.", 1 record, error_codes `['PROVIDER_FALLBACK_EXHAUSTED']`, providers `[null]`, fetch called `false`. Non tautologico: osserva l'emissione reale del gateway via sink iniettato.
   - Header del file aggiornato ai 4 punti del contratto (provider-error / loop-senza-tentativo / pre-proxy / no-provider).
3. **lib/app.js** — payload DELETE 404 uniformato a `jsonFromCliResult` (rimossi i `|| ""` su `output`/`error`). Nota nit chiusa.

### Verifica build e suite (rieseguita dal reviewer)

- `npm run build:ts` → pulita; `git diff -- lib/` **vuoto** → nessun drift `src ↔ lib/ts-build`.
- `npm test` → **777 test, 775 pass, 0 fail, 2 skip** (identico a dichiarazione coder, seconda run piena). Una run precedente ha flakkeato su `tests/provider-reordering.test.js:108` (probe speed reale `< 5ms` sotto carico) — **pre-esistente e non toccato dai commit** (`git diff 6fc7a6a^..fa9edca -- tests/provider-reordering.test.js` vuoto); verde 3/3 in isolamento e nella run full successiva. Non correlato a questo change set; nota ai già noti limiti timing-based, non bloccante.
- **T1/T2 invariati** da `6fc7a6a` (git diff su `lib/cli.js`/`tests/cli.test.js`/`tests/app.test.js` tra i due commit: vuoto). Guard flag `stats:reset` intatto (cli.js:6280), help senza `--hard`.

### Nota residua (non bloccante, informativa)
La regola `error_code === "HTTP_503"` nel test exhausted è legata al probe reale via `fetchFn` mocked: se in futuro il gateway cambiasse il mapping error_code del fallback terminale, il test richiederà aggiornamento — accettabile perché ora asserisce il comportamento VERO (niente più dichiarazioni fantasma).

**Esito finale:** nessun CHANGES_REQUESTED residuo. Il coder può procedere; cycle completo per R1–R3 chiuso. Revisione finale operata su: `qa-audit/review-6fc7a6a.md` (aggiornata), sezione report appesa con `report_append` (slug `fix-residui-qa`).
