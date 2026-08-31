# Confronto llmproxy / OmniRoute

Data della verifica: 2026-08-31.

## Sintesi esecutiva

OmniRoute è più maturo come gateway multi-provider generalista: il repository pubblicizza un endpoint OpenAI-compatible, un catalogo molto ampio e un routing `auto/*` che costruisce il pool dinamicamente dalle connessioni attive. La sua parte più interessante non è il numero dichiarato di provider, ma la separazione tra catalogo, connessione, quota, salute, capacità del modello e strategia di routing.

llmproxy è più piccolo e più controllabile: oggi ha 20 provider API-key/OAuth supportati, un registry scoped per gerarchia, fallback deterministico, traduzione Anthropic/OpenAI, metering, proxy rotation e un modello virtuale `llmproxy` già esposto da `/v1/models`.

Verdetto: per l'obiettivo attuale conviene continuare llmproxy e importare selettivamente idee e metadati da OmniRoute. Passare interamente a OmniRoute conviene solo se la priorità principale diventa usare subito centinaia di provider e molte integrazioni già pronte, accettando una superficie molto più grande, più dipendenze e più integrazioni reverse-engineered o soggette a condizioni d'uso variabili.

## Differenze architetturali

| Area | OmniRoute | llmproxy | Conseguenza |
|---|---|---|---|
| Catalogo | Registry modulare con entry per provider, alias, endpoint, formato, modelli, capacità, limiti e comportamento live-catalog | Registry più ristretto con adapter hard-coded in `lib/copilot-proxy.js` e registry scoped | llmproxy deve separare metadata e trasporto prima di ampliare il catalogo |
| Connessioni | Più account/connessioni per provider; ogni account può diventare candidato separato | Provider/token entry ordinati; supporta istanze e proxy rotation, ma il candidato principale resta provider-level | il routing quota-aware richiede un'identità di connessione esplicita |
| Auto routing | Virtual combo creato per richiesta, con varianti `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, `auto/offline`, `auto/smart` | `llmproxy` virtuale delega al fallback esistente; il reordering globale supporta `price`, `power`, `speed` | portare le varianti e mantenere il fallback attuale come compatibilità |
| Selezione | Score pesato su quota, health, costo, latenza, task fit, stabilità, tier, contesto, sessione, densità e qualità | Ordine configurato; reordering opzionale per prezzo CloudPrice, coding score e probe latency | importare prima filtri hard e segnali affidabili, poi lo score |
| Free | Catalogo a livello modello con regime (`keyless`, recurring, one-time), `poolKey`, ToS e quota; filtri strict opzionali | `free_model` boolean a livello provider, costo 0 nel reordering, senza quota free generalizzata | serve un modello dati per modello/connessione, non un semplice booleano |
| Resilienza | Circuit breaker, lockout per modello, cooldown per connessione, quota reset e fallback differenziati | fallback su errori HTTP/rete e proxy demotion; probe e reordering periodico | classificare 401/402/404/429/5xx per candidato e non solo per provider |

Il registry OmniRoute è volutamente una sorgente unica da cui vengono generati alias, modelli e provider legacy; è un pattern da riprendere. Il suo stesso repository mostra però che una entry di catalogo può richiedere un executor, un formato, header, endpoint e regole di modello distinti: importare solo il nome del provider non lo rende supportato.

Fonti primarie: [README OmniRoute](https://github.com/diegosouzapw/OmniRoute), [provider registry](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/config/providers/shared.ts), [registry aggregato](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/config/providers/index.ts).

## Cosa prendere come esempio

### 1. Registry separato dal trasporto

Introdurre in llmproxy un manifest per provider/modello con almeno:

- id canonico e alias;
- protocollo (`openai-chat`, `anthropic-messages`, `responses`, altro);
- endpoint e metodo di autenticazione;
- modello, capacità vision/tool/reasoning e contesto;
- autorità del catalogo live (`liveCatalogAuthoritative`);
- URL della documentazione e stato di integrazione.

Il manifest deve distinguere `discovered`, `catalogued`, `adapter-ready` e `enabled`. In questo modo si possono importare molti provider senza promettere che siano già utilizzabili.

### 2. Candidate pool virtuale

Il modello `llmproxy` dovrebbe creare per ogni richiesta un pool da:

1. provider/connessioni configurati e non disabilitati;
2. modello richiesto o modello di default della connessione;
3. capacità compatibili con la richiesta;
4. candidati non bloccati da breaker, cooldown, lockout o quota;
5. eventuali provider keyless esplicitamente verificati.

Il pool non deve essere persistito come combo. Persistire solo telemetria, stato quota e preferenze dell'utente riduce il rischio di cataloghi obsoleti.

### 3. Varianti semantiche di Auto

Il mapping consigliato per llmproxy è:

| Modello | Semantica proposta |
|---|---|
| `llmproxy` | bilanciato e compatibile con il routing attuale |
| `llmproxy/free` | solo candidati con accesso gratuito verificato; nessun fallback paid |
| `llmproxy/cheap` | costo minimo tra candidati eleggibili |
| `llmproxy/fast` | latenza/health prima del costo |
| `llmproxy/coding` | coding score, reasoning e stabilità |
| `llmproxy/offline` | massimo headroom di quota/rate limit |

Le varianti devono essere alias del router, non modelli upstream. La richiesta deve continuare a essere compatibile con `/v1/chat/completions`.

La documentazione OmniRoute descrive questo approccio come virtual combo creato per richiesta e mostra anche il principio del filtro per categoria/tier. Fonte: [Auto-Combo Engine](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/docs/routing/AUTO-COMBO.md).

### 4. Filtri hard prima del punteggio

Prima di calcolare qualsiasi score:

- escludere credenziali scadute o mancanti;
- escludere modelli incompatibili con vision/tool/reasoning;
- escludere breaker OPEN, cooldown e model lockout;
- escludere quota free esaurita;
- in modalità `free`, escludere ogni connessione con costo non verificabile.

Solo dopo si possono confrontare costo, latenza, qualità e task-fit. Un punteggio non può trasformare un candidato non eleggibile in un candidato utilizzabile.

### 5. Quota e pool condivisi

Il campo più importante da importare da OmniRoute è il concetto di `poolKey`: modelli diversi possono consumare la stessa quota. Il catalogo deve quindi avere una relazione del tipo:

```text
provider + model + connection -> free regime -> quota pool -> reset state
```

La quota va memorizzata per connessione/pool, con TTL, `remaining`, `resetAt`, stato `SAFE|EXHAUSTED|UNKNOWN` e invalidazione immediata quando il provider restituisce quota exhausted/402/429. La modalità strict deve trattare `UNKNOWN` come non gratuito; la modalità normale può tentare il candidato e poi fare fallback.

OmniRoute implementa già il principio con catalogo free tipizzato, quota cache, verifica per connessione e una distinzione tra routing subscription-first e strict zero-cost. Fonti: [free model catalog](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/config/freeModelCatalog.ts), [catalogo dati](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/config/freeModelCatalog.data.ts), [strict zero-cost filter](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/services/autoCombo/strictZeroCostFilter.ts).

### 6. Score spiegabile e osservabile

La prima versione dello score llmproxy non dovrebbe copiare ciecamente tutti i 15 fattori OmniRoute. È sufficiente partire da:

```text
health 35% + quota 25% + costo 20% + latenza 10% + task-fit 10%
```

Ogni risposta dovrebbe poter esporre, almeno nei log/debug, provider, modello, tentativi, motivo di esclusione e fattori principali. Un endpoint read-only tipo `/v1/auto/candidates` sarebbe utile per capire perché `Auto` ha scelto un candidato.

La formula completa OmniRoute è documentata nel relativo modulo di scoring e include anche stabilità, tier, contesto, sessione, densità e qualità osservata. Fonte: [scoring.ts](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/services/autoCombo/scoring.ts).

## Importare l'elenco provider OmniRoute?

Sì, ma non come copia cieca e non direttamente dentro `SUPPORTED_PROVIDERS`.

La soluzione corretta è un catalogo a più livelli:

```text
OmniRoute/provider discovery
        ↓
llmproxy catalog manifest
        ↓
adapter OpenAI-compatible generico oppure adapter dedicato
        ↓
provider configurabile e routable
```

Regola pratica:

- provider con endpoint OpenAI-compatible documentato: candidabile per un adapter generico, con endpoint allowlist e test reale;
- provider con formato Anthropic/Responses o header speciali: adapter dedicato;
- provider OAuth, web-cookie, browser, CLI locale o protocollo reverse-engineered: non importare automaticamente;
- provider catalogato ma non verificato: visibile come discovery, non selezionabile da Auto;
- provider con ToS/quota incerti: richiede opt-in esplicito e non entra in `llmproxy/free` strict.

Questo evita il problema più pericoloso: mostrare in `/v1/models` modelli che llmproxy non sa realmente invocare, oppure promettere “free” quando il provider può fare overage a pagamento.

Per la prima tranche ha senso estendere gli adapter già presenti in llmproxy e aggiungere solo provider che condividono il formato OpenAI Chat Completions: DeepSeek, Groq, Mistral, Together, Fireworks, NVIDIA, Vercel AI Gateway e aggregatori già vicini al trasporto esistente. Gli altri vanno valutati uno per uno.

## Adattamento della logica free

La differenza tra l'attuale llmproxy e OmniRoute è sostanziale:

- llmproxy considera gratuito un provider quando `free_model === true`;
- il reordering usa costo 0, coding score e speed probe;
- non c'è una quota free uniforme per modello/connessione;
- un provider può essere provato e poi il fallback continua secondo ordine;
- un errore di un modello non ha ancora sempre lo stesso isolamento fine-grained di un modello dentro un gateway multi-model.

La roadmap consigliata è:

1. **Catalogo typed**: aggiungere `freeType`, `poolKey`, `tos`, `hardStopGuaranteed`, `monthlyAllowance`, `resetPolicy` a livello modello.
2. **Connessione esplicita**: usare un id stabile per ogni account/proxy rotation entry.
3. **Quota adapters**: iniziare da provider per cui esiste un endpoint ufficiale di usage/balance; nessuna supposizione quando il dato manca.
4. **Stato quota**: cache breve, reset-aware, invalidazione su 402/429/quota errors.
5. **`llmproxy/free`**: filtro strict, fail-closed su quota sconosciuta e nessun fallback paid.
6. **`llmproxy` normale**: score tra candidati eleggibili, con preferenza free/costo ma fallback resiliente.
7. **Error isolation**: 404 modella solo quel modello, 401 demote della credenziale, 402/429 quota/cooldown, 5xx retry/fallback.
8. **Trasparenza**: endpoint candidati e decision metadata nei log.

L'attuale `LLMPROXY_REORDERING=price-speed-power` può rimanere come modalità legacy e amministrativa. Non deve essere confusa con il nuovo Auto request-level: il primo cambia l'ordine persistente dei provider, il secondo decide per ogni richiesta usando stato live.

## OmniRoute o llmproxy?

### Conviene OmniRoute se

- vuoi subito un gateway generalista con centinaia di integrazioni;
- la priorità è il numero di provider/modelli e le varianti Auto già disponibili;
- accetti di adottare il suo modello operativo, database, dashboard e ciclo di aggiornamento;
- sei disposto a verificare provider con API, OAuth, web e protocolli diversi.

### Conviene continuare llmproxy se

- la priorità è il provider custom OpenAI-compatible stabile per VS Code, Continue, OpenCode, Zed e altri client;
- vuoi controllo su credenziali, gerarchia, metering e fallback;
- vuoi una superficie piccola e auditabile;
- ti basta integrare progressivamente provider realmente utili invece di esporre un catalogo enorme;
- vuoi mantenere compatibilità con il flusso Anthropic/Claude già esistente.

### Raccomandazione franca

Per questo progetto: **continua llmproxy**.

Non perché OmniRoute sia peggiore: sul routing multi-provider e sul free catalog è avanti. Ma la parte che ti serve davvero — un endpoint locale/produttivo neutro, usabile come provider custom da qualunque client OpenAI-compatible, con routing controllato da te — è già il cuore di llmproxy. Passare a OmniRoute per inseguire il catalogo significherebbe sostituire il nucleo del progetto invece di migliorarlo.

La strategia migliore è trattare OmniRoute come riferimento architetturale e, se utile, come sorgente di discovery da cui importare solo provider verificati. Il primo obiettivo concreto dovrebbe essere portare in llmproxy `poolKey + quota state + llmproxy/free + score spiegabile`; non copiare 350 adapter.
