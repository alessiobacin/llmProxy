# Review — commit `196de50` (OpenAI-compatible streaming SSE su /v1/chat/completions, T1+T2)

- **Reviewer:** reviewer-01
- **Branch:** `task/openai-compat-streaming` (worktree `.worktrees/openai-compat-streaming`)
- **Commit revisionato:** `196de50` — 5 file, +979/−10 (src TS +186, ts-build rigenerato, app.js +40, 2 file test nuovi +16 test)
- **Base:** `796e874` (main @ 0.3.121)
- **Metodo:** diff `796e874..196de50`, lettura completa di `src/gateway/transport/openai-format.ts`, bridge `createOpenAICaptureResponse` e path streaming del gateway (`handleStreaming`/`relayAnthropicStreamWithFooter` in copilot-proxy.js), esecuzione suite completa, probe indipendenti e2e (mid-stream failure, usage-absence, model echo).

---

## Verdetto

# ✅ APPROVED

Zero issue bloccanti. Contratto T1/T2 implementato e verificato (anche con probe indipendenti); i 16 test nuovi osservano il percorso reale (unit sul traduttore + e2e HTTP su bridge+gateway), nessun test cancellato o indebolito; build coerente; suite verde. 3 note non bloccanti (N1 pre-esistente degna di ticket di follow-up, N2/N3 minime).

---

## Asse 1 — Standard repo

| Check | Esito | Evidenza |
|---|---|---|
| Zero `@ts-ignore` / `@ts-expect-error` / `any` | ✅ | Grep su `src/gateway/transport/openai-format.ts`: zero occorrenze. Tipi dichiarati localmente (OpenAI/Anthropic shape), nessun `any`. |
| TDD red→green | ✅ | Report coder dichiara 3 fail T2 + 9 fail T1 prima dei fix; i 16 test esistono ora, sono stringenti e osservano il percorso reale (verificati uno a uno). La red-phase pre-code non è riconsctruttibile post-hoc, ma i gap documentati (501 guard, error envelope) corrispondono a codice realmente cambiato nel diff. |
| Nessun test cancellato/indebolito | ✅ | Baseline 777 → 793 = **+16** (7 compat + 9 stream); nessuna cancellazione; le asserzioni e2e Anthropic esistenti restano verdi. |
| Coerenza `src/*.ts ↔ lib/ts-build/*.js` | ✅ | `npm run build:ts` rieseguita: OK; `git diff -- lib/` **vuoto** → il `lib/ts-build/gateway/transport/openai-format.js` committato è il prodotto esatto del sorgente TS. |
| Suite completa | ✅ | `npm test` rieseguita: **793 test, 791 pass, 0 fail, 2 skip** (identico a dichiarazione coder; skip systemd pre-esistenti). |

---

## Asse 2 — Contratto spec

### T2 — Contratto non-streaming ✅ APPROVED

- **Error shape OpenAI**: `anthropicErrorToOpenAI` (openai-format.ts) mappa l'envelope Anthropic `{type:"error",error:{...}}` → `{error:{message,type,code}}` con `code:"invalid_api_key"` per `authentication_error`, `invalid_request_error` per invalid_request; payload senza `error` ritorna invariato (defensivo). Applicato in `createOpenAICaptureResponse.json()` per `_status>=400`. Test e2e (openai-compat.test.js "returns OpenAI-style error shape") asserisce `body.error` presente, `body.type === undefined` (nessun leak Anthropic), message non vuoto. Verificato anche in streaming (test 401 stream).
- **tools/tool_choice request mapping**: unit contract su `openAIRequestToAnthropic` — `tools[].function.{name,description,parameters}` → `{name,input_schema}`, `tool_choice:"auto"` → `{type:"auto"}` (mappa anche "required"→`{type:"any"}` e `{type:"function",function:{name}}`→`{type:"tool",name}` nel sorgente). ✓
- **tool_calls round-trip e2e**: finish_reason `tool_calls`, usage coerente. ✓ (streaming: `content_block_start tool_use` → delta `tool_calls` con id/name, `input_json_delta` → arguments — test dedicato.)
- **modello qualificato `provider:model`**: e2e che prima legge `GET /v1/models` (asserisce `openai:gpt-4o-mini` nel catalogo) poi usa quell'id in chat → 200. ✓
- **role system → system field**: unit contract (system estratto da messages, non rimane in messages) + e2e. ✓

### T1 — Streaming SSE ✅ APPROVED

- **Chunk OpenAI corretti** (unit, tutti osservati dal traduttore reale):
  - `message_start` → primo `chat.completion.chunk` con `delta:{role:"assistant",content:""}`, id `chatcmpl-*`, created numerico, model richiesto. ✓
  - `text_delta` → `delta:{content}` (join ricostruisce il testo; e2e "Ciao dal provider" esatto). ✓
  - `thinking_delta` → `delta:{reasoning_content}` (estensione per client reasoning-style; i client OpenAI puri lo ignorano). ✓
  - `tool_use` blocks → `tool_calls` delta con `index/type/id/function.name` e arguments da `input_json_delta`. ✓
  - `message_delta` → `finish_reason` mapping `end_turn|stop→stop`, `max_tokens→length`, `tool_use→tool_calls` (unit ×2). ✓
  - `message_stop` → `data: [DONE]`. ✓
  - `stream_options.include_usage` → chunk finale `choices:[]` + `usage{prompt,completion,total}`; e2e con usage deterministico 7+3=10 come ultimo payload prima di [DONE]. ✓
- **Buffering write parziali**: unit test spezza un evento SSE a metà (`event.slice(0, mid)` + `event.slice(mid)`) → primo write 0 chunk, secondo produce il delta completo. Il buffer interno (`state.buffer`, ricerca `\n\n`) gestisce correttamente eventi spezzati; anche i casi `event:` line-only e JSON malformato sono skip-sicuri (`continue`). ✓
- **Content-Type text/event-stream**: il gateway setta `Content-Type/Cache-Control/Connection` via `res.setHeader` (copilot-proxy.js:2662-2666) → il bridge ora inoltra `setHeader` al realRes in tempo reale → e2e asserisce `content-type` match `/text\/event-stream/`. ✓
- **Bridge on-the-fly**: `createOpenAICaptureResponse` crea il translator al primo `write()`, traduce ogni write Anthropic→OpenAI, e `end()` flusha il buffer parziale residuo (`anthropicSseWriteToOpenAiChunks(translator, "\n\n")`) prima di `realRes.end()`. Corretto: senza il flush di chiusura, un evento spezzato alla fine andrebbe perso. ✓
- **Guard 501 rimosso** sia in `handleOpenAIChat` sia in `write()` del shim. ✓

### Punti deboli richiesti — verificati con probe

**(a) Flusso simulato e buffering** ✅ — L'upstream falso e2e (`makeUpstreamStream`) emette write separati per ogni evento SSE (multiple `read()`); copertura del buffering spezzato garantita dal unit test dedicato (mid-split). Il flusso reale del gateway (`handleStreaming` produce tanti piccoli `res.write` per evento) corrisponde al pattern testato.

**(b) Errori a metà stream / prima dell'SSE** — *pre-stream* ✅: 401 del provider prima di aprire SSE → nessun header SSE settato (il `setHeader("text/event-stream")` avviene solo nel ramo ok), `json()` del shim → `realRes.status(401).json(anthropicErrorToOpenAI(payload))` → body errore OpenAI pulito, test e2e verde. *Mid-stream* ⚠️→**N1**: se l'upstream fallisce DOPO l'apertura SSE, `handleStreaming` (reader loop, copilot-proxy.js:1693) lancia e l'errore **propaga uncaught** fino a `handleOpenAIChat` (il catch in `handleMessages` fa `throw error` re-throw, app.js:1189-1193) → **unhandledRejection a livello processo** con Express 4.22.2 (che non cattura async handler). **Verificato che è PRE-ESISTENTE**: il medesimo probe su `/v1/messages` (surface Anthropic) produce lo stesso uncaught error dallo stesso path (`proxyAnthropicRequest` → `handleMessages`), senza passare dal bridge OpenAI. Quindi NON è una regressione introdotta da `196de50`, ma è una landmine di affidabilità (Node ≥15: unhandledRejection di default crash-a il processo) ora raggiungibile anche dalla nuova superficie OpenAI. Su [DONE]: in mid-stream failure `[DONE]` non viene emesso e la connessione viene troncata — coerente col fatto che non c'è una risposta "pulita" da inviare, ma il crash-risk del processo è il vero problema. → Raccomando un **ticket di follow-up** (guard try/catch attorno ad `await handleStreaming/relayAnthropicStreamWithFooter` con chiusura SSE + log, o catch in `handleOpenAIChat`/`handleMessages` con check `res.headersSent`): out of scope per questo commit, non blocca.

**(c) usage SOLO con include_usage** ✅ — Codice: `if (state.includeUsage && usage)` (openai-format.ts). Probe indipendente: senza `stream_options.include_usage`, con usage presente nell'upstream → **nessun** chunk usage nello stream; `[DONE]` ultimo. Copertura test: include_usage=true coperto da unit+e2e; l'assenza non è asserita esplicitamente da un test (vedi N3) ma il gate è codice e probe-verificato.

**(d) [DONE]** ✅ — Sempre emesso nei successi (unit ×4 + e2e ×2: ultima riga `data: [DONE]`); nei fallimenti pre-stream non c'è `[DONE]` (body JSON errore, test asserisce `body.error` senza envelope SSE). Mid-stream: no [DONE] (vedi N1).

**(e) Nessuna regressione sui client Anthropic** ✅ — `createOpenAICaptureResponse` è usata **solo** da `handleOpenAIChat` (grep: definizione app.js:1223, unico uso app.js:1214; rotte: `/v1/chat/completions` e `/v1/llm/chat/completions` — entrambe OpenAI). `/v1/messages` e `/v1/llm/messages` non passano dal bridge e non sono toccate dal diff (app.js cambia solo il blocco OpenAI). La suite esistente (app.test.js con Anthropic SSE, 793 totali) è verde.

**(f) Model echo nel chunk** ✅ — Il translator usa `model` dal body OpenAI richiesto: probe conferma `model` in tutti i chunk = `openai:gpt-4o-mini` (l'id qualificato richiesto), conforme alla convenzione OpenAI (il client riceve ciò che ha chiesto). Nota di coerenza interna (N2): nel non-streaming il `model` della risposta è quello **upstream** (`anthropic.model`, es. `gpt-4o-mini` senza prefisso) mentre in streaming è quello richiesto — entrambi plausibili, ma sarebbe più uniforme allineare (follow-up minore, non nel contratto della spec).

---

## Note (non bloccanti)

- **N1 (follow-up consigliato, pre-esistente):** mid-stream upstream failure → unhandledRejection (process-crash risk con Node ≥15 + Express 4), raggiungibile su `/v1/messages` (pre-esistente) e ora anche su `/v1/chat/completions` (nuovo). Path: copilot-proxy.js:1693 `handleStreaming` reader → app.js:1189-1193 re-throw → Express 4 non cattura. Fix consigliato: try/catch attorno alle await streaming nel gateway con chiusura SSE pulita (`res.end()` + log) — ticket dedicato.
- **N2:** incoerenza minore `model` tra streaming (richiesto, qualificato) e non-streaming (upstream, bare) — uniformare in futuro.
- **N3:** l'assenza di usage senza `include_usage` non è asserita da un test dedicato (gate verificato da probe/codice); un `assert.ok(!chunks.some(c => c.usage))` nell'e2e senza include_usage chiuderebbe il cerchio. Opzionale.

## Deliverable

- Questo file: `qa-audit/review-196de50.md` (nel worktree, NON committato).
- Sezione report: "## Round 2 — reviewer (reviewer-01)" appesa con `report_append` (slug `openai-compat-streaming`).
- Verdetto: **APPROVED** — procedere a fase 2 (docs-sync T4 + version bump 0.3.122); N1 al planner per un ticket di follow-up.