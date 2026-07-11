---
name: handoff-bugs-2026-07-09
description: Handoff di bug trovati e fix da applicare — auditing completo del 2026-07-09
metadata:
  type: reference
---

## Stato Verifica — Tutti gli Item

### 1. `provider:update` (vision, free, name) ✅ GIA' FUNZIONANTE
- CLI `lib/cli.js:5438-5481`, API `lib/app.js:642-652`, token-store `src/gateway/providers/token-store.ts:291-335`
- Niente da fixare.

### 2. PROVIDER_CREDIT_INLINE quando credit info è null ✅ GIA' FUNZIONANTE
- `buildInferenceFooter:1196` già gestisce `creditInfo?.label ? ... : "n/a"` — mostra "n/a" se null
- `formatProviderList:1382` già gestisce `provider.credit_info?.label || "n/a"`
- Il problema è SOLO che la chiamata a `buildInferenceFooter` non passa correttamente l'override (vedi bug #3)

### 3. ☠️ BUG #1: `effectiveInlineMetering` forzato da `creditInline`
**File**: `lib/project-context.js` riga 212
```javascript
const effectiveInlineMetering = inlineMetering || creditInline;  // BUG!
```
**Effetto**: Quando `LLMPROXY_METERING_INLINE=0` e `LLMPROXY_PROVIDER_CREDIT_INLINE=1`, il metering inline viene attivato comunque.
**Fix**: Separare i due flag. `effectiveInlineMetering` deve essere solo `inlineMetering`. Poi `buildInferenceFooter` verificherà i flag separatamente.
**Righe impattate**: tutte le `return` in `resolveClaudeProjectSettings` che usano `effectiveInlineMetering`. Vanno lasciate così ma la riga 212 diventa solo `inlineMetering`.

### 4. ☠️ BUG #2: `buildInferenceFooter` chiamata con argomenti posizionali
**File**: `lib/copilot-proxy.js`
- `relayAnthropicStreamWithFooter` riga 1387-1392:
```javascript
const footer = buildInferenceFooter(
    buildUsageStats(...),     // → diventa opts = {requestInputTokens, requestOutputTokens, ...} NON {usageStats, ...}
    options.smartRouteInfo,   // → ignorato
    options.inlineMetering,   // → ignorato  
    options.creditInfo,       // → ignorato
);
```
- `handleStreaming` riga 1755-1759: stesso identico pattern

**Effetto**: I parametri `inlineMetering`, `inlineCredit` passati dall'handler vengono persi. La funzione ricade su `process.env` che potrebbe non avere i valori giusti.

**Fix**: Cambiare in:
```javascript
const footer = buildInferenceFooter({
    usageStats: buildUsageStats(...),
    smartRouteInfo: options.smartRouteInfo || null,
    inlineMetering: options.inlineMetering,
    creditInfo: options.creditInfo || null,
    inferenceProviderId: options.providerId,
    inferenceModelName: options.modelUsed,
});
```
Applicare a entrambi i siti (riga 1387 e 1755).

### 5. Same-provider failover (es. opencode-alessio → opencode-bacin) ✅ GIA' FUNZIONANTE
- Loop riga 1963 itera correttamente tutti i provider
- `break` riga 2147/2230 esce al provider successivo
- Se due provider stesso tipo hanno stessi `default_model`, falliranno entrambi — è corretto

### 6. Provider benchmark (`LLMPROXY_PROVIDER_BENCHMARK_MINUTES`) 🟡 PARZIALE
**File**: `lib/provider-benchmark.js` — struttura già completa (read/write store, probe, runAll, start con interval)
**File**: `lib/app.js:1266-1279` — benchmark avviato se `benchmarkMinutes > 0`

**Problema**: `probeFn: null` a `lib/app.js:1272` — il probe non fa mai inferenza reale, segna `ok: false`
**Fix**: Creare una funzione probe che fa una vera chiamata di inferenza (es. richiesta `GET` o `POST` a un endpoint tipo health per ogni provider). Oppure, se si vuole misurare latenza reale, fare una vera chiamata API al provider. Sostituire `probeFn: null` con la funzione reale.

### 7. Formato METERING_INLINE 🟡 DA CAMBIARE
**File**: `lib/copilot-proxy.js` funzione `buildInferenceFooter` riga 1146-1218

**Richiesto** (formato compatto per modello):
```
[llmproxy] provider/modello (in: X/d, out Y/d - in: Z/w, out Z/w) - provider2/modello2 (in: X/d, out Y/d - in: Z/w, out Z/w)
```

**Attuale**: mostra request tokens + modelli separati per today/week

**Fix**: Riscrivere le funzioni `formatCompactModels` e `formatWeekDelta` per produrre il formato a modello unico. Combinare today e week per ciascun modello in una singola entry.

### 8. LLMPROXY_METERING_INLINE=0 ancora visibile
**Causa**: BUG #1 + BUG #2 combinati. Fixando entrambi, questo viene risolto.

### 9. Price-performance routing ✅ GIA' FUNZIONANTE
- `copilot-proxy.js:251-253`: `resolvePricePerformanceRoutingEnabled` funziona
- `copilot-proxy.js:319-357`: `rankProvidersByPricePerformance` classifica per costo+tiebreaker
- `copilot-proxy.js:256-262`: tiebreaker supporta "power" e "speed"
- Usato a `copilot-proxy.js:1934-1940` — completo

## Ordine di Priorità per i Fix

1. **BUG #1** (project-context.js:212) — la causa principale del metering inline sempre attivo
2. **BUG #2** (copilot-proxy.js:1387, 1755) — streaming non riceve override inline/credit
3. **Formato METERING_INLINE** (copilot-proxy.js:1146-1218) — richiesta utente di formato più breve
4. **Provider benchmark probe reale** (app.js:1272, provider-benchmark.js) — serve probeFn con inferenza vera
