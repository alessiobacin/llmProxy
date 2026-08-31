# OmniRoute vs llmProxy

## Perimetro e metodo

Questo confronto usa esclusivamente il codice dei due repository:

- OmniRoute: repository ufficiale [`diegosouzapw/OmniRoute`](https://github.com/diegosouzapw/OmniRoute), analizzato al commit [`b7a0c541394e89c32e30d3d9f1408c2388a89afe`](https://github.com/diegosouzapw/OmniRoute/tree/b7a0c541394e89c32e30d3d9f1408c2388a89afe), del 31 agosto 2026.
- llmProxy: working tree locale in questo repository, con i file sorgente attualmente presenti.

I numeri di OmniRoute riportati sotto sono quelli dichiarati dal README del commit analizzato oppure quelli ricavabili direttamente dai cataloghi sorgente. La working tree di llmProxy contiene modifiche già presenti prima di questa ricerca; non sono state modificate dal confronto.

## Sintesi esecutiva

OmniRoute è un gateway molto più ampio e ambizioso: ha un catalogo centralizzato di provider e modelli, numerose categorie di autenticazione, più protocolli, dashboard e telemetria, connessioni per-account e un motore `auto/*` che sceglie tra candidati provider-modello usando disponibilità, quota, salute, costo, latenza, compatibilità e qualità.

llmProxy è più piccolo e più focalizzato. Il suo punto di forza è una pipeline comprensibile per usare provider configurati dall’utente, con fallback/rotazione, registry gerarchico per scope e compatibilità Anthropic/OpenAI. Il suo routing dinamico attuale ordina provider configurati; non è ancora un catalogo semantico di modelli gratuiti né un motore di selezione provider-modello con prova live della quota.

La raccomandazione franca è:

> Continua con llmProxy se il prodotto deve restare un proxy locale/di team, semplice da operare, basato su provider noti e integrabile con Claude Code, VS Code e client OpenAI. Valuta OmniRoute se la priorità assoluta è avere subito centinaia di provider, cataloghi multimodali e routing automatico dei free tier.

Non conviene sostituire llmProxy soltanto perché OmniRoute dichiara un numero maggiore di provider. Quel numero porta con sé una superficie di manutenzione molto più grande: ogni provider richiede autenticazione, formato, discovery, errori, quota e comportamento di fallback coerenti. Conviene invece importare da OmniRoute alcuni concetti, soprattutto quelli del catalogo free e del routing, mantenendo l’esecutore e il modello operativo già funzionanti di llmProxy.

## 1. Architettura

| Area | OmniRoute | llmProxy |
|---|---|---|
| Forma del prodotto | Applicazione gateway con server API, interfaccia e molte route operative. | Servizio Node/Express con CLI e proxy multi-provider. |
| Registry | Registry modulare con una directory/modulo per provider e una funzione centrale che costruisce il catalogo. [`providerRegistry.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/providerRegistry.ts), [`providers/index.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/providers/index.ts) | Registry TypeScript con 21 tipi di provider supportati, più configurazioni di trasporto/API key nel proxy legacy. [`src/gateway/providers/provider-registry.ts`](../src/gateway/providers/provider-registry.ts), [`lib/copilot-proxy.js`](../lib/copilot-proxy.js) |
| Stato | Connessioni, account, cataloghi, metriche, cooldown e lockout sono parte del modello operativo. | Token store e configurazione provider alimentano la selezione; il proxy conserva retry/rotazione e l’ordine dei provider. [`src/gateway/services/llm-transport.ts`](../src/gateway/services/llm-transport.ts) |
| Routing | Combo persistenti e combo virtuali `auto/*` materializzate on demand. | Selezione esplicita oppure routing virtuale `llmproxy`; fallback tra candidati e riordinamento periodico. [`lib/app.js`](../lib/app.js), [`lib/provider-reordering.js`](../lib/provider-reordering.js) |
| Protocolli | OpenAI Chat Completions, embeddings, immagini, audio/OCR, compatibilità Claude/Gemini/Responses, MCP e A2A secondo il codice e la documentazione del repository. | Endpoint Anthropic e OpenAI compatibile, con `/v1/models`; la copertura è centrata su chat/completions e messaggi. [`lib/app.js`](../lib/app.js), [`README.md`](../README.md) |

### Differenza architetturale decisiva

OmniRoute tratta il provider come una combinazione di provider, account/connessione, modello, capacità, quota e policy. llmProxy tratta prevalentemente il provider come una configurazione di trasporto associata a credenziali e a un modello predefinito. Questa è la ragione principale per cui OmniRoute può fare routing free molto più preciso: ha più dimensioni su cui decidere.

Il codice di llmProxy ha comunque una buona separazione recente: [`llm-transport.ts`](../src/gateway/services/llm-transport.ts) crea un seam tipizzato sopra l’esecutore legacy, mentre [`provider-registry.ts`](../src/gateway/providers/provider-registry.ts) definisce scope `master`, `agency`, `client`, `project` e `user`. È una base adatta ad aggiungere un catalogo e un selettore più evoluti senza riscrivere subito l’intero proxy.

## 2. Catalogo provider e modelli

### OmniRoute

Il README del commit analizzato dichiara un catalogo molto esteso: 351 provider registrati nelle collezioni canonicali, di cui 154 con `hasFree: true`; per il catalogo chat dichiara 268 provider, 2.566 coppie provider-modello e 1.312 model ID raw. Il catalogo free separato dichiara 455 righe per modello, 40 pool ricorrenti e 56 provider free-forever ricorrenti/keyless. La struttura è coerente con il codice: esistono moduli provider, cataloghi statici per categoria e un catalogo budget free distinto dal registry generale.

Fonti: [`README.md`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/README.md), [`providers/index.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/providers/index.ts), [`catalog.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/lib/providers/catalog.ts).

Il catalogo statico distingue almeno provider senza API key, OAuth, cookie/web session, locali, ricerca, audio, upstream proxy, cloud agent e API key. Il catalogo free non si limita al booleano “gratis”: ogni riga può contenere provider, modello, nome visualizzato, budget, tipo di regime, `poolKey`, termini d’uso, addestramento sui prompt e garanzia di hard stop. [`freeModelCatalog.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/freeModelCatalog.ts), [`freeModels.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/shared/utils/freeModels.ts)

Una cautela: nello stesso README sono presenti numeri diversi in sezioni diverse, per esempio 445/39 in una descrizione e 455/40 nella sezione del catalogo free. Questo segnala che anche OmniRoute deve mantenere sincronizzata la documentazione con i cataloghi generati. Nel report ho privilegiato i numeri della sezione dettagliata e, soprattutto, la semantica espressa dal codice.

### llmProxy

llmProxy possiede un registry di 21 tipi di provider, tra cui OpenRouter, Z.ai, Kimi, Qwen, OpenCode, OpenAI, Anthropic, DeepSeek, Groq, Mistral, xAI, Perplexity, Together, Fireworks, NVIDIA, Vercel AI Gateway e Meta. Le configurazioni in [`lib/copilot-proxy.js`](../lib/copilot-proxy.js) definiscono endpoint, protocollo, eventuale modello di default e predicati di compatibilità.

La differenza è che questo non equivale a un catalogo di 21 provider “completo”. Il contenuto esposto da [`GET /v1/models`](../lib/app.js) viene costruito dai provider/credential configurati nel token store: include il modello virtuale `llmproxy` e modelli qualificati `provider:model` per i provider disponibili. Non esiste, nel codice analizzato, un catalogo statico globale comparabile a quello OmniRoute con tutti i modelli, regime free, pool, termini e quota per modello.

In pratica:

- OmniRoute ha un catalogo di possibilità e poi decide quali connessioni/modelli sono utilizzabili.
- llmProxy espone soprattutto ciò che l’utente ha configurato e sa raggiungere.

Questa scelta rende llmProxy più prevedibile e leggero, ma impedisce al momento di offrire discovery e routing free generalizzato senza aggiungere una nuova sorgente dati.

## 3. Routing dei provider gratuiti

### Come lo fa OmniRoute

Il routing `auto/*` di OmniRoute è un pipeline a più fasi:

1. interpreta alias e modalità come `auto`, `auto/best-free`, `auto/best-coding`, `auto/cheap`, `auto/vision` e varianti di tier;
2. costruisce on demand una combo virtuale a partire dalle connessioni e dal catalogo disponibili;
3. filtra modelli incompatibili con tool calling, contesto, modalità, policy di esposizione e tipo di richiesta;
4. per il free applica filtri specifici, inclusi provider con accesso free, catalogo budget e controllo “strict zero cost”;
5. valuta i candidati con fattori pesati: quota, salute, costo inverso, latenza, task fit, stabilità, tier, specificità, affinità di contesto/cache/sessione, densità della connessione e qualità;
6. ordina il candidato scelto e conserva una coda di fallback.

Fonti: [`autoRouting.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/sse/handlers/autoRouting.ts), [`builtinCatalog.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/builtinCatalog.ts), [`virtualFactory.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/virtualFactory.ts), [`scoring.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/combo/scoring.ts), [`resolveAutoStrategy.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/combo/resolveAutoStrategy.ts).

La parte più importante per evitare sorprese economiche è `strict zero cost`. Non considera sufficiente che un provider sia marcato free: cerca una voce nel catalogo, richiede un regime compatibile, verifica lo stato live della connessione e una quota residua sopra soglia. Se la quota è sconosciuta, il filtro può escludere il candidato: è un comportamento fail-closed. La quota è letta attraverso un adapter con cache breve, limite di concorrenza e invalidazione in caso di 402/403/quota.

Fonti: [`strictZeroCostFilter.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/strictZeroCostFilter.ts), [`freeAccessQuota.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/freeAccessQuota.ts), [`paidModelFilter.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/paidModelFilter.ts).

### Come lo fa oggi llmProxy

llmProxy possiede già tre elementi utili:

- il modello virtuale `llmproxy`, risolto dal gateway come routing dinamico;
- fallback tra candidati provider e rotazione proxy;
- riordinamento opzionale secondo prezzo, potenza e velocità, con provider/modello free valutati a prezzo zero.

Fonti: [`lib/app.js`](../lib/app.js), [`src/gateway/services/llm-transport.ts`](../src/gateway/services/llm-transport.ts), [`lib/provider-reordering.js`](../lib/provider-reordering.js).

Il limite è semantico: `free_model` è una proprietà della configurazione dell’istanza/token e il flag CLI `--free-model` consente di dichiarare un modello gratuito, ma non esiste una policy centrale per tipo di regime, pool condiviso, termini, hard stop o quota residua. Il riordinamento è provider-oriented e usa probe/metriche relativamente semplici; non è un filtro free fail-closed a livello di coppia provider-modello.

Quindi un eventuale `auto` di llmProxy oggi significa “scegli secondo l’ordine/ranking dei provider configurati”, non “scegli il miglior modello gratuito utilizzabile in questo momento”. Sono due concetti diversi.

## 4. Robustezza e feature

### Dove OmniRoute è avanti

- Catalogo e discovery molto più ampi, con categorie di autenticazione diverse.
- Modellazione per connessione/account, quindi migliore isolamento di quota, cooldown, lockout e capacità.
- Strategie multiple oltre all’auto composito: fill-first, least-used, P2C, random, cost-optimized, reset-aware, quota-share e altre.
- Routing consapevole di tool calling, contesto, visione, cache, sessione e task.
- Retry e classificazione degli errori con gestione di `Retry-After`, cooldown, account non disponibili e modello non supportato.
- Telemetria di latenza/errori/quota, circuit breaker e stato operativo utilizzati direttamente nello scoring.
- Superficie API e operativa più larga: chat, media, modelli, MCP/A2A e dashboard secondo i moduli presenti nel repository.

Fonti: [`auth.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/sse/services/auth.ts), [`cooldownAwareRetry.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/sse/services/cooldownAwareRetry.ts), [`sameAccountTransportRetry.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/sse/services/sameAccountTransportRetry.ts), [`applyStrategyOrdering.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/combo/applyStrategyOrdering.ts).

### Dove llmProxy è più semplice o già adeguato

- Il percorso di esecuzione è più corto e leggibile, con meno componenti operativi.
- Il registry per scope è adatto a separare configurazioni master/agency/client/project/user.
- Il modello `provider:model` è esplicito e utile per debug e pinning; `llmproxy` è un endpoint unico comodo per client compatibili.
- Il proxy include rotazione di proxy, retry di rete transitori e traduzione tra protocolli supportati.
- `/v1/models` è già una buona base per client che chiedono discovery dinamica dei modelli configurati.
- L’installazione e la gestione tramite CLI sono più facili da spiegare quando il numero di provider è volutamente limitato.

Fonti: [`src/gateway/providers/provider-registry.ts`](../src/gateway/providers/provider-registry.ts), [`lib/copilot-proxy.js`](../lib/copilot-proxy.js), [`lib/app.js`](../lib/app.js), [`README.md`](../README.md).

### Rischi di OmniRoute da non importare alla cieca

La vastità del catalogo non garantisce che ogni provider sia sempre disponibile, autorizzato o economicamente gratuito per ogni utente. Lo stesso codice OmniRoute deve distinguere regimi free, quota live, termini e provider ritirati: è la prova che “provider free” non può essere un’etichetta statica sufficiente.

Inoltre, importare direttamente l’elenco dei provider senza importare gli adapter e le relative policy produrrebbe modelli visibili ma non utilizzabili. Sarebbe un peggioramento dell’esperienza: il client mostrerebbe molte scelte che falliscono a runtime.

## 5. Cosa conviene importare in llmProxy

### Da importare subito come concetti

1. **Catalogo free normalizzato.** Aggiungere una sorgente versionata con `provider`, `modelId`, `freeType`, `poolKey`, budget, termini e `hardStopGuaranteed`. Il catalogo deve distinguere “prezzo zero noto”, “free con quota”, “keyless”, “trial/one-time” e “discontinuato”.
2. **Predicato unico di gratuità.** Tutti i comandi, `/v1/models` e il router devono usare la stessa funzione, invece di dedurre il free da un singolo flag.
3. **Routing free esplicito.** Aggiungere una modalità come `auto/best-free` oppure un equivalente CLI/configurabile, separata dal normale `auto`, per evitare che un utente interpreti erroneamente un ranking generale come garanzia di costo zero.
4. **Candidati a livello provider-modello.** Il candidato non deve essere solo `provider`; deve contenere provider, modello, credenziale/istanza, salute, latenza, costo e quota.
5. **Fail-closed quando la sicurezza economica è richiesta.** Se la quota live è sconosciuta, escludere il candidato dalla modalità strict-free, mantenendolo eventualmente disponibile nel routing generale.
6. **Metriche operative minime.** Conservare latenza, error rate, ultimo errore, cooldown e quota residua per candidato, con una spiegazione della scelta restituita nei log.

### Da non importare subito

- L’intero catalogo OmniRoute come lista piatta.
- Tutti i provider senza un adapter llmProxy verificato.
- Un motore di scoring a 15 fattori prima di avere dati affidabili e test sui casi reali.
- Regole free specifiche di un provider senza un’interfaccia per quota/auth/error e senza test di regressione.

### Ordine pragmatico di implementazione

1. Catalogo free + test del predicato e del comando di listing.
2. `auto/best-free` con filtro deterministico e fallback già esistente.
3. Telemetria per candidato e scoring iniziale basato su quota, salute, latenza e costo.
4. Adapter quota per i provider più importanti, con cache breve e fail-closed.
5. Importazione selettiva di metadati/provider OmniRoute solo quando endpoint, auth, modello e test sono presenti.
6. Strategie più avanzate (session affinity, cache affinity, reset windows e quota-share) solo se il caso d’uso le richiede.

## Decisione finale

Per il progetto descritto finora, la scelta migliore è **continuare a sviluppare llmProxy**, ma prendere OmniRoute come riferimento per il catalogo e per il free routing. llmProxy ha già la parte difficile dell’integrazione che ti serve — endpoint compatibili, provider espliciti, modello virtuale `llmproxy`, fallback e configurazione per client — e può crescere senza assorbire subito tutta la complessità di OmniRoute.

Passerei a OmniRoute solo se questi requisiti sono prioritari e non negoziabili:

- catalogo enorme già pronto;
- molte integrazioni OAuth/cookie/keyless oltre alle API key;
- routing gratuito basato su quota e stato live;
- dashboard, telemetria e gestione avanzata di account/connessioni;
- supporto esteso a media, MCP/A2A e protocolli oltre alla chat.

In breve: **OmniRoute è il prodotto più completo; llmProxy è la base più adatta da mantenere se vuoi controllo, semplicità e continuità con il lavoro già fatto.** La strada con il miglior rapporto rischio/beneficio è un’implementazione selettiva dei concetti OmniRoute, non una copia del suo catalogo né una migrazione motivata dal solo conteggio dei provider.

## Fonti primarie consultate

- OmniRoute, commit analizzato: [`b7a0c541`](https://github.com/diegosouzapw/OmniRoute/tree/b7a0c541394e89c32e30d3d9f1408c2388a89afe)
- OmniRoute: [`README.md`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/README.md), [`providerRegistry.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/providerRegistry.ts), [`providers/index.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/providers/index.ts), [`freeModelCatalog.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/config/freeModelCatalog.ts), [`freeModels.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/shared/utils/freeModels.ts), [`autoRouting.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/sse/handlers/autoRouting.ts), [`virtualFactory.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/virtualFactory.ts), [`scoring.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/combo/scoring.ts), [`strictZeroCostFilter.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/strictZeroCostFilter.ts), [`freeAccessQuota.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/autoCombo/freeAccessQuota.ts), [`resolveAutoStrategy.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/open-sse/services/combo/resolveAutoStrategy.ts), [`auth.ts`](https://github.com/diegosouzapw/OmniRoute/blob/b7a0c541394e89c32e30d3d9f1408c2388a89afe/src/sse/services/auth.ts)
- llmProxy locale: [`lib/app.js`](../lib/app.js), [`lib/copilot-proxy.js`](../lib/copilot-proxy.js), [`lib/provider-reordering.js`](../lib/provider-reordering.js), [`src/gateway/services/llm-transport.ts`](../src/gateway/services/llm-transport.ts), [`src/gateway/providers/provider-registry.ts`](../src/gateway/providers/provider-registry.ts), [`README.md`](../README.md)
