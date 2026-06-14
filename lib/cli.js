const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createPaths, ensureRuntimeDirs } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createCopilotModelCatalogStore, resolveAvailableCopilotModels } = require("./copilot-models");
const { startDeviceFlow, pollForToken } = require("./copilot-auth");
const { createServiceManager } = require("./service-manager");
const { startServer } = require("./app");
const { getAvailableModels, mapModel, DEFAULT_COPILOT_MODEL } = require("./openai-translate");
const { probeApiKeyProviderModel, normalizeQwenEndpointVariant } = require("./copilot-proxy");
const { loadRuntimeEnv, normalizeRuntimeProfile, resolveProxyHostPort } = require("./runtime-env");
const { createJsonlMeteringSink } = require("./metering");
const { createSmartRouterStore } = require("./smart-router-store");
const { analyzeRequest, routeRequest } = require("./smart-router");

const AVAILABLE_PROVIDER_SPECS = [
  { id: "copilot", auth: "oauth", displayName: "GitHub Copilot", aliases: [] },
  { id: "openrouter", auth: "api_key", displayName: "OpenRouter", aliases: [] },
  { id: "zai", auth: "api_key", displayName: "Z.AI", aliases: ["z.ai"] },
  { id: "kimi", auth: "api_key", displayName: "Kimi (Moonshot)", aliases: [] },
  { id: "qwen", auth: "api_key", displayName: "Qwen (DashScope)", aliases: [] },
  { id: "openai", auth: "api_key", displayName: "OpenAI", aliases: [] },
  { id: "anthropic", auth: "api_key", displayName: "Anthropic", aliases: [] },
  { id: "deepseek", auth: "api_key", displayName: "DeepSeek", aliases: [] },
  { id: "groq", auth: "api_key", displayName: "Groq", aliases: [] },
  { id: "mistral", auth: "api_key", displayName: "Mistral", aliases: [] },
  { id: "xai", auth: "api_key", displayName: "xAI", aliases: [] },
  { id: "perplexity", auth: "api_key", displayName: "Perplexity", aliases: [] },
  { id: "together", auth: "api_key", displayName: "Together", aliases: [] },
  { id: "fireworks", auth: "api_key", displayName: "Fireworks", aliases: [] },
];

const KNOWN_PROVIDERS = AVAILABLE_PROVIDER_SPECS.reduce((acc, provider) => {
  const entry = { auth: provider.auth, displayName: provider.displayName };
  acc[provider.id] = entry;
  for (const alias of provider.aliases) acc[alias] = entry;
  return acc;
}, {});

const INSTALL_LOCALE_FILE = "install-locale.txt";

const RELEASE_NOTES = {
  "0.2.58": {
    it: [
      "Update: il changelog viene letto dal binario appena installato, non dal processo precedente che ha avviato l'aggiornamento.",
      "Risolto il caso in cui l'update completava la 0.2.57 ma mostrava ancora il fallback 'Note di rilascio non disponibili'.",
    ],
    en: [
      "Update: release notes are now read from the freshly installed binary instead of the previous process that started the upgrade.",
      "Fixed the case where updating to 0.2.57 completed successfully but still showed the 'Release notes are not available' fallback.",
    ],
  },
  "0.2.57": {
    it: [
      "CLI globale: profilo runtime esplicito in production per usare la porta 7045 anche quando l'installazione globale punta al checkout locale.",
      "Servizio persistente: bootstrap coerente con l'ambiente (Docker per production/staging, server nativo per development locale).",
      "Update output: aggiunte note di rilascio per evitare il fallback 'Note di rilascio non disponibili'.",
    ],
    en: [
      "Global CLI: explicit production runtime profile so the global command uses port 7045 even when the global install points to the local checkout.",
      "Persistent service: environment-aware bootstrap (Docker for production/staging, native server for local development).",
      "Update output: added release notes to avoid the 'Release notes are not available' fallback.",
    ],
  },
  "0.2.55": {
    it: [
      "Update: changelog localizzato in base alla lingua di installazione persistente (install:persistent-it / install:persistent-en).",
      "Lingua installazione persistita nel runtime per output coerente dei successivi update.",
      "Fallback esplicito: se una versione non ha note, viene stampato comunque il blocco changelog con messaggio dedicato.",
    ],
    en: [
      "Update: localized changelog based on persistent install language (install:persistent-it / install:persistent-en).",
      "Install language is persisted in runtime storage for consistent output across subsequent updates.",
      "Explicit fallback: if a version has no notes, update still prints a changelog block with a dedicated message.",
    ],
  },
  "0.2.54": {
    it: [
      "Rete provider: retry automatico su errori transienti di socket chiuso (es. 'The socket connection was closed unexpectedly').",
      "Maggiore resilienza: ridotti i falsi 502 su disconnessioni brevi upstream.",
    ],
    en: [
      "Provider network: automatic retry on transient socket-close errors (e.g. 'The socket connection was closed unexpectedly').",
      "Higher resilience: fewer false 502s on short upstream disconnects.",
    ],
  },
  "0.2.53": {
    it: [
      "Update output: stampa il changelog della versione installata.",
      "Self-update: se rileva il container Docker persistente in esecuzione, esegue rebuild+recreate (docker compose up -d --build llmproxy).",
      "Event Bus (modulo 48): pubblicazione evento llmproxy.call.completed per ogni richiesta LLM.",
    ],
    en: [
      "Update output: prints the changelog for the installed version.",
      "Self-update: if a persistent Docker container is running, it performs rebuild+recreate (docker compose up -d --build llmproxy).",
      "Event Bus (module 48): publish llmproxy.call.completed on every LLM request.",
    ],
  },
  "0.2.52": {
    it: [
      "Event Bus (modulo 48): pubblicazione evento llmproxy.call.completed per ogni richiesta LLM.",
      "Nuovo sink Event Bus configurabile con EVENTBUS_URL (5048 dev, 6048 staging, 7048 prod).",
    ],
    en: [
      "Event Bus (module 48): publish llmproxy.call.completed on every LLM request.",
      "New Event Bus sink configurable with EVENTBUS_URL (5048 dev, 6048 staging, 7048 prod).",
    ],
  },
};

function normalizeLocale(value) {
  return String(value || "").trim().toLowerCase() === "en" ? "en" : "it";
}

function getInstallLocaleFilePath(paths) {
  return path.join(paths.dataRoot, INSTALL_LOCALE_FILE);
}

function persistInstallLocale(paths, locale) {
  try {
    fs.writeFileSync(getInstallLocaleFilePath(paths), `${normalizeLocale(locale)}\n`, "utf8");
  } catch {
    // best effort
  }
}

function readPersistedInstallLocale(paths) {
  try {
    const raw = fs.readFileSync(getInstallLocaleFilePath(paths), "utf8").trim();
    return normalizeLocale(raw);
  } catch {
    return "it";
  }
}

function resolveOutputLocale({ env, paths }) {
  const envLocale = String(env?.LLMPROXY_LOCALE || "").trim().toLowerCase();
  if (envLocale === "it" || envLocale === "en") return envLocale;
  return readPersistedInstallLocale(paths);
}

function normalizeKnownProviderId(rawProviderId) {
  const normalized = String(rawProviderId || "").trim().toLowerCase();
  if (normalized === "z.ai") return "zai";
  return normalized;
}

function getKnownProvider(rawProviderId) {
  const id = normalizeKnownProviderId(rawProviderId);
  if (KNOWN_PROVIDERS[id]) {
    return { id, ...KNOWN_PROVIDERS[id] };
  }
  // Backward compatibility: arbitrary ids are treated as Copilot aliases.
  return { id, auth: "oauth", displayName: id || "GitHub Copilot" };
}

function listAvailableProviders() {
  return AVAILABLE_PROVIDER_SPECS.map((provider) => ({ ...provider, aliases: provider.aliases.slice() }));
}

function formatAvailableProviders(providers = listAvailableProviders()) {
  return providers
    .map((provider, index) => {
      const aliasSuffix = provider.aliases.length > 0 ? ` aliases=${provider.aliases.join(", ")}` : "";
      return `${index + 1}. ${provider.id} (${provider.displayName}) auth=${provider.auth}${aliasSuffix}`;
    })
    .join("\n");
}

function formatKnownProvidersInline(providers = listAvailableProviders()) {
  return providers
    .map((provider) => (provider.aliases.length > 0 ? `${provider.aliases[0]} (${provider.id})` : provider.id))
    .join(", ");
}

function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv.slice(2) : [];
  const args = [];
  const flags = {};

  if (tokens.length > 0 && (tokens[0] === "--help" || tokens[0] === "-h")) {
    return {
      command: "help",
      subcommand: tokens[1] || "",
      args: tokens.slice(1),
      flags: {},
      follow: false,
    };
  }

  if (tokens.length > 0 && (tokens[0] === "--version" || tokens[0] === "-v")) {
    return {
      command: "version",
      subcommand: "",
      args: [],
      flags: {},
      follow: false,
    };
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const nextToken = tokens[index + 1];
    if (nextToken && !nextToken.startsWith("--")) {
      flags[rawKey] = nextToken;
      index += 1;
      continue;
    }

    flags[rawKey] = true;
  }

  return {
    command: args[0] || "help",
    subcommand: args[1] || "",
    args: args.slice(1),
    flags,
    follow: Boolean(flags.follow),
  };
}

const COMMAND_HELP = {
  "help": {
    usage: "llmproxy help [comando]",
    description: "Mostra la guida generale oppure la scheda dettagliata di un comando specifico.",
    when: "Usalo quando vuoi capire rapidamente quale comando scegliere o ricordarti sintassi e flusso consigliato.",
    example: "llmproxy help claude:setup",
  },
  "setup": {
    usage: "llmproxy setup",
    description: "Verifica il runtime locale, mostra il data root e il service manager selezionato.",
    when: "Usalo subito dopo l'installazione o quando vuoi capire dove llmproxy salva dati e log.",
    example: "llmproxy setup",
  },
  "version": {
    usage: "llmproxy version",
    description: "Stampa la versione corrente della CLI installata.",
    when: "Usalo per verificare che l'update sia andato a buon fine o per debug rapido della versione attiva.",
    example: "llmproxy --version",
  },
  "release-notes": {
    usage: "llmproxy release-notes [--version <version>] [--locale <it|en>]",
    description: "Stampa il changelog di una versione specifica usando commit message, note embedded o fallback locale.",
    when: "Usalo per controllare cosa introduce una release oppure per verificare l'output che verra' mostrato dopo un update.",
    example: "llmproxy release-notes --version 0.2.61",
  },
  "update": {
    usage: "llmproxy update",
    description: "Scarica e installa l'ultima versione dalla repository GitHub e verifica il binario aggiornato.",
    when: "Usalo quando vuoi aggiornare la CLI mantenendo una sola installazione globale attiva.",
    example: "llmproxy update",
  },
  "install": {
    usage: "llmproxy install",
    description: "Alias inglese di install:persistent-en: installa globalmente la CLI corrente e registra il servizio persistente nativo dell'OS.",
    when: "Usalo quando vuoi un comando piu' corto e leggibile per il bootstrap persistente in inglese dal binario CLI.",
    example: "llmproxy install",
    englishDescription: "English alias for install:persistent-en: installs the current CLI globally and registers the native persistent service for the OS.",
    englishWhen: "Use it when you want a shorter, English-first command for the persistent bootstrap flow from the CLI.",
    englishExample: "llmproxy install",
    locale: "en",
  },
  "install:persistent": {
    usage: "llmproxy install:persistent",
    description: "Installa globalmente la CLI corrente e registra il servizio persistente nativo dell'OS.",
    when: "Usalo come bootstrap one-shot dal checkout locale quando vuoi avere llmproxy disponibile anche dopo reboot.",
    example: "npm run install:persistent",
    locale: "it",
  },
  "install:persistent-it": {
    usage: "llmproxy install:persistent-it",
    description: "Installa globalmente la CLI corrente e registra il servizio persistente nativo dell'OS.",
    when: "Usalo come percorso esplicito in italiano quando vuoi output, help ed errori in italiano.",
    example: "npm run install:persistent-it",
    locale: "it",
  },
  "install:persistent-en": {
    usage: "llmproxy install:persistent-en",
    description: "Installs the current CLI globally and registers the native persistent service for the OS.",
    when: "Use it when you want the explicit English install path with English output, help, and errors.",
    example: "npm run install:persistent-en",
    englishDescription: "Installs the current CLI globally and registers the native persistent service for the OS.",
    englishWhen: "Use it when you want the explicit English install path with English output, help, and errors.",
    englishExample: "npm run install:persistent-en",
    locale: "en",
  },
  "uninstall": {
    usage: "llmproxy uninstall",
    description: "Rimuove llmproxy dalle installazioni globali supportate e pulisce wrapper residui.",
    when: "Usalo quando vuoi disinstallare completamente la CLI dal sistema.",
    example: "llmproxy uninstall",
  },
  "login": {
    usage: "llmproxy login",
    description: "Autentica GitHub Copilot via device flow e salva il provider predefinito.",
    when: "Usalo alla prima configurazione o quando il token Copilot non e' piu' valido.",
    example: "llmproxy login",
  },
  "logout": {
    usage: "llmproxy logout",
    description: "Rimuove i token Copilot locali.",
    when: "Usalo per forzare un nuovo login o per pulire completamente le credenziali locali.",
    example: "llmproxy logout",
  },
  "provider:add": {
    usage: "llmproxy provider:add <id> --api-key <key> --model <model> --vision <true|false> [--name <name>] [--plan <plan>]",
    description: "Aggiunge un provider noto: Copilot via device flow, gli altri provider tramite API key e modello predefinito. --vision e' obbligatorio per i provider API key.",
    when: "Usalo quando vuoi configurare un provider di fallback aggiuntivo, per esempio openrouter o kimi, oltre al provider principale.",
    example: "llmproxy provider:add qwen --api-key sk-sp-... --model qwen3.7-plus --vision true --plan subscription",
  },
  "provider:key": {
    usage: "llmproxy provider:key <id> --api-key <key> [--model <model>] [--vision <true|false>] [--plan <plan>]",
    description: "Aggiorna o imposta la API key di un provider gia' configurato con autenticazione api_key. --vision e' opzionale (mantiene il valore esistente se omesso).",
    when: "Usalo quando devi ruotare una chiave esistente senza ricreare da zero il provider.",
    example: "llmproxy provider:key qwen --api-key sk-sp-... --vision true --plan subscription",
  },
  "provider:available": {
    usage: "llmproxy provider:available",
    description: "Elenca i provider supportati dalla CLI, con id canonico, alias e tipo di autenticazione.",
    when: "Usalo quando vuoi sapere quali provider puoi configurare prima di eseguire provider:add.",
    example: "llmproxy provider:available",
  },
  "provider:list": {
    usage: "llmproxy provider:list",
    description: "Elenca i provider configurati nell'ordine di fallback corrente.",
    when: "Usalo per controllare rapidamente quali provider sono salvati e in che ordine verranno provati.",
    example: "llmproxy provider:list",
  },
  "provider:test": {
    usage: "llmproxy provider:test",
    description: "Testa la capacita' di visione di tutti i provider configurati.",
    when: "Usalo dopo aver configurato i provider per verificare che il flag --vision sia corretto e che i modelli supportino effettivamente la visione delle immagini.",
    example: "llmproxy provider:test",
  },
  "provider:status": {
    usage: "llmproxy provider:status",
    description: "Mostra il provider attivo e lo stato sintetico di tutti i provider configurati.",
    when: "Usalo quando vuoi capire quale provider sta servendo le richieste e se i fallback sono completi o mancanti di modello/chiave.",
    example: "llmproxy provider:status",
  },
  "provider:order": {
    usage: "llmproxy provider:order <id> <position>",
    description: "Sposta un provider nella posizione di fallback desiderata.",
    when: "Usalo quando vuoi dare priorita' a un provider diverso senza doverlo rimuovere e ricreare.",
    example: "llmproxy provider:order kimi 1",
  },
  "provider:rename": {
    usage: "llmproxy provider:rename <id> <name>",
    description: "Rinomina un provider configurato per distinguerlo meglio negli elenchi e nello stato.",
    when: "Usalo quando hai piu' provider simili e vuoi etichette piu' chiare per capire il fallback a colpo d'occhio.",
    example: "llmproxy provider:rename backup Backup Copilot",
  },
  "provider:remove": {
    usage: "llmproxy provider:remove <id>",
    description: "Rimuove un provider configurato dal fallback locale.",
    when: "Usalo quando un provider non serve piu' oppure vuoi eliminare una configurazione non valida.",
    example: "llmproxy provider:remove openrouter",
  },
  "run": {
    usage: "llmproxy run",
    description: "Avvia il proxy in foreground.",
    when: "Usalo per debug locale, test rapidi o quando non vuoi installare il servizio persistente.",
    example: "llmproxy run",
  },
  "status": {
    usage: "llmproxy status [--docker]",
    description: "Mostra stato del servizio, autenticazione e ordine dei provider. Con --docker mostra anche lo stato dei container Docker.",
    when: "Usalo quando il proxy non risponde o vuoi verificare quale provider sia attivo. Aggiungi --docker per vedere i container in esecuzione.",
    example: "llmproxy status --docker",
  },
  "stats": {
    usage: "llmproxy stats",
    description: "Mostra statistiche aggregate di utilizzo con breakdown per provider e modello e relativo consumo token.",
    when: "Usalo quando vuoi capire quali provider e modelli stanno assorbendo piu' traffico e token.",
    example: "llmproxy stats",
  },
  "logs": {
    usage: "llmproxy logs [--follow]",
    description: "Mostra i log recenti del servizio e dell'ultimo audit log JSONL.",
    when: "Usalo per diagnosticare errori; aggiungi --follow per seguire il flusso in tempo reale.",
    example: "llmproxy logs --follow",
  },
  "service:start": {
    usage: "llmproxy service:start",
    description: "Installa e avvia il servizio utente persistente.",
    when: "Usalo quando vuoi che il proxy resti disponibile dopo il reboot senza avviarlo a mano.",
    example: "llmproxy service:start",
  },
  "service:stop": {
    usage: "llmproxy service:stop",
    description: "Ferma il servizio persistente.",
    when: "Usalo prima di manutenzione, riconfigurazioni o disinstallazione.",
    example: "llmproxy service:stop",
  },
  "service:restart": {
    usage: "llmproxy service:restart",
    description: "Riavvia il servizio persistente.",
    when: "Usalo dopo update o modifiche alla configurazione runtime.",
    example: "llmproxy service:restart",
  },
  "models:list": {
    usage: "llmproxy models:list",
    description: "Elenca i modelli disponibili in forma numerata.",
    when: "Usalo prima di llmproxy claude:setup per scegliere l'indice corretto del modello.",
    example: "llmproxy models:list",
  },
  "model:set": {
    usage: "llmproxy model:set <model>",
    description: "Aggiorna il modello Claude del progetto scrivendo il valore grezzo in .claude/settings.json.",
    when: "Usalo quando vuoi cambiare rapidamente routing o provider senza rifare claude:setup, ad esempio passando a deepseek:deepseek-v4-flash.",
    example: "llmproxy model:set deepseek:deepseek-v4-flash",
  },
  "test": {
    usage: "llmproxy test",
    description: "Esegue un test rapido di inferenza contro il proxy locale con un prompt fisso.",
    when: "Usalo per verificare rapidamente che llmProxy stia rispondendo correttamente a una richiesta /v1/messages.",
    example: "llmproxy test",
  },
  "claude:setup": {
    usage: "llmproxy claude:setup [--model <indice>]",
    description: "Scrive .claude/settings.json per usare llmproxy come backend locale di Claude Code.",
    when: "Usalo nel progetto che vuoi collegare a llmproxy, dopo login e dopo aver scelto il modello con models:list.",
    example: "llmproxy claude:setup --model 2",
  },
  "smart:add": {
    usage: "llmproxy smart:add --provider <p> --model <m> --api-key <k>",
    description: "Aggiunge il classifier LLM dello smart router (provider api_key come openrouter o deepseek).",
    when: "Usalo una volta per attivare il routing intelligente delle richieste in base a complessità/vision/tools.",
    example: "llmproxy smart:add --provider openrouter --model deepseek-chat --api-key sk-or-xxx",
  },
  "smart:status": {
    usage: "llmproxy smart:status",
    description: "Mostra lo stato dello smart router: enabled, classifier configurato (API key mascherata), provider registrati.",
    when: "Usalo per verificare rapidamente se il routing intelligente è attivo e con quale classifier.",
    example: "llmproxy smart:status",
  },
  "smart:test": {
    usage: "llmproxy smart:test",
    description: "Simula il routing su 3 scenari (simple, moderate, complex) usando i provider configurati.",
    when: "Usalo dopo smart:add per vedere quale modello verrebbe scelto per ciascun tipo di richiesta.",
    example: "llmproxy smart:test",
  },
  "smart:refresh": {
    usage: "llmproxy smart:refresh",
    description: "Invalida la cache availability dei provider, forzando il reload al prossimo request.",
    when: "Usalo dopo aver aggiunto/rimosso provider per aggiornare subito lo stato del router.",
    example: "llmproxy smart:refresh",
  },
};

function printCommandHelp(command, stdout = process.stdout) {
  const entry = COMMAND_HELP[command];
  if (!entry) {
    stdout.write(`Comando non documentato: ${command}\n`);
    stdout.write("Usa `llmproxy help` per l'elenco completo.\n");
    return 1;
  }

  const isEnglishInstallCommand = entry.locale === "en";
  const descriptionLabel = isEnglishInstallCommand ? "Description" : "Descrizione";
  const whenLabel = isEnglishInstallCommand ? "When to use" : "Quando usarlo";
  const exampleLabel = isEnglishInstallCommand ? "Example" : "Esempio";
  const description = isEnglishInstallCommand ? (entry.englishDescription || entry.description) : entry.description;
  const when = isEnglishInstallCommand ? (entry.englishWhen || entry.when) : entry.when;
  const example = isEnglishInstallCommand ? (entry.englishExample || entry.example) : entry.example;

  stdout.write(`${entry.usage}\n\n`);
  stdout.write(`${descriptionLabel}: ${description}\n`);
  stdout.write(`${whenLabel}: ${when}\n`);
  if (example) stdout.write(`${exampleLabel}: ${example}\n`);
  return 0;
}

function printHelp(stdout = process.stdout) {
  const knownProvidersInline = formatKnownProvidersInline();
  stdout.write(`llmProxy CLI

Comandi principali:
  llmproxy help                            mostra questa guida con cosa fa ogni comando, quando usarlo e come invocarlo
  llmproxy setup                           verifica il runtime locale, il data root e il service manager selezionato
  llmproxy version                         mostra la versione corrente della CLI installata
  llmproxy install:persistent-it           installa globalmente la CLI corrente e attiva il servizio persistente nativo dell'OS
  llmproxy install:persistent-en           installs the current CLI globally and enables the native persistent service for the OS
  llmproxy install                         English alias for install:persistent-en; installs the current CLI globally and enables the native persistent service for the OS
  llmproxy install:persistent              alias legacy di install:persistent-it
  llmproxy update                          scarica e installa l'ultima versione dalla repo e verifica il binario aggiornato
  llmproxy uninstall                       rimuove l'installazione globale di llmproxy e pulisce eventuali wrapper duplicati

Autenticazione:
  llmproxy login                           autentica GitHub Copilot via device flow; usalo la prima volta o quando il token scade
  llmproxy logout                          rimuove i token locali; usalo per resettare l'accesso corrente

Esecuzione proxy:
  llmproxy run                             avvia il proxy in foreground; usalo per test locali o debug rapido
  llmproxy status                          mostra stato del servizio, autenticazione e ordine dei provider
  llmproxy stats                           mostra statistiche aggregate di utilizzo per provider e modello
  llmproxy logs [--follow]                 legge i log recenti; usa --follow per seguire il flusso in tempo reale

Servizio persistente:
  llmproxy service:start                   installa e avvia il servizio utente persistente; usalo per avere il proxy attivo dopo il reboot
  llmproxy service:stop                    ferma il servizio persistente
  llmproxy service:restart                 riavvia il servizio persistente dopo modifiche o update

Provider:
  llmproxy provider:add <id> [--name <name>] [--api-key <key>] aggiunge un provider noto (Copilot via login; gli altri via API key)
  llmproxy provider:key <id> --api-key <key> aggiorna/imposta la API key per provider API-key (openrouter, kimi, qwen, z.ai, ...)
  llmproxy provider:available              elenca i provider supportati dalla CLI
  llmproxy provider:list                   elenca i provider configurati nell'ordine di fallback
  llmproxy provider:test                   testa la capacita' di visione di tutti i provider configurati
  llmproxy provider:status                 mostra quale provider e' attivo in questo momento
  llmproxy provider:order <id> <position>  cambia la priorita' di fallback di un provider
  llmproxy provider:rename <id> <name>     rinomina un provider per distinguerlo meglio
  llmproxy provider:remove <id>            rimuove un provider configurato

Provider noti:
  ${knownProvidersInline}

Modelli e Claude Code:
  llmproxy models:list                     mostra i modelli disponibili in forma numerata; usalo prima di configurare Claude
  llmproxy model:set <model>               aggiorna il modello del progetto con un valore grezzo (es. deepseek:deepseek-v4-flash)
  llmproxy test                            esegue un test rapido di inferenza contro il proxy locale
  llmproxy claude:setup [--model <indice>] scrive .claude/settings.json per usare llmproxy come backend locale

Smart Router:
  llmproxy smart:add --provider <p> --model <m> --api-key <k>  aggiunge il classifier LLM per il routing intelligente
  llmproxy smart:status                  mostra stato dello smart router e classifier configurato
  llmproxy smart:test                    simula il routing su scenari simple/moderate/complex
  llmproxy smart:refresh                 invalida la cache availability dei provider

Quando usare cosa:
  1. Prima installazione persistente: install:persistent-it oppure install:persistent-en -> login -> models:list -> claude:setup
  2. Uso come servizio: service:start -> status -> logs
  3. Multi-account: provider:add -> provider:list -> provider:order
  4. Aggiornamento CLI: update
  5. Rimozione completa: uninstall

Problemi comuni:
  - llmproxy non risponde: usa llmproxy status e poi llmproxy logs --follow
  - Claude Code non vede il proxy: rilancia llmproxy claude:setup nel progetto corretto
  - un modello fallisce: controlla llmproxy models:list e scegli un indice valido
  - il token Copilot non funziona: esegui llmproxy logout e poi llmproxy login
`);
}

function readPackageVersion(packageRoot) {
  const packageFile = path.join(packageRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  return String(pkg.version || "0.0.0");
}

function readEmbeddedReleaseNotes(packageRoot, version) {
  try {
    const packageFile = path.join(packageRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    const notes = pkg?.llmproxyReleaseNotes?.[String(version || "").trim()];
    return Array.isArray(notes) ? notes.filter((note) => String(note || "").trim()) : [];
  } catch {
    return [];
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runCommand(commandRunner, command, args = []) {
  try {
    return commandRunner(command, args, { encoding: "utf8" });
  } catch (error) {
    return { status: 1, stdout: "", stderr: "", error };
  }
}

function commandIsAvailable(commandRunner, command, args = ["--version"]) {
  const result = runCommand(commandRunner, command, args);
  return result && result.status === 0;
}

function canWritePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return false;
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveUpdatePrerequisites(options = {}) {
  const commandRunner = options.commandRunner || spawnSync;
  const env = options.env || process.env;
  const paths = options.paths || createPaths({ dataRoot: options.dataRoot, packageRoot: options.packageRoot, env });
  const packageRoot = paths.packageRoot;
  const runtimeEntry = resolveServiceEntryFile({ env, packageRoot, targetPlatform: options.targetPlatform || process.platform });
  const requiresDockerRuntime = path.basename(runtimeEntry) === "docker-launchd-entry.js";
  const dockerComposeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(packageRoot, "docker-compose.production.yml")).trim();
  const missing = [];

  const addMissing = (key, messageIt, messageEn) => {
    if (missing.some((item) => item.key === key)) return;
    missing.push({ key, messageIt, messageEn });
  };

  if (!commandIsAvailable(commandRunner, "gh")) {
    addMissing("gh", "GitHub CLI (`gh`) non trovato nel PATH.", "GitHub CLI (`gh`) is not available in PATH.");
  }
  if (!commandIsAvailable(commandRunner, "git")) {
    addMissing("git", "Git (`git`) non trovato nel PATH.", "Git (`git`) is not available in PATH.");
  }
  // pnpm is optional: we fall back to npm pack if pnpm is not available
  // if (!commandIsAvailable(commandRunner, "pnpm")) {
  //   addMissing("pnpm", "pnpm non trovato nel PATH.", "pnpm is not available in PATH.");
  // }
  const npmAvailable = commandIsAvailable(commandRunner, "npm");
  if (!npmAvailable) {
    addMissing("npm", "npm non trovato nel PATH.", "npm is not available in PATH.");
  }

  if (npmAvailable) {
    const npmPrefixResult = runCommand(commandRunner, "npm", ["prefix", "-g"]);
    const npmPrefix = String(npmPrefixResult?.stdout || "").trim();
    if (!npmPrefixResult || npmPrefixResult.status !== 0 || !npmPrefix) {
      addMissing(
        "npm-prefix",
        "Impossibile determinare il prefisso globale di npm (`npm prefix -g`).",
        "Unable to determine the global npm prefix (`npm prefix -g`).",
      );
    } else if (!canWritePath(npmPrefix) && !commandIsAvailable(commandRunner, "sudo")) {
      addMissing(
        "npm-write",
        `Il prefisso globale npm non e' scrivibile (${npmPrefix}) e \`sudo\` non e' disponibile.`,
        `The global npm prefix is not writable (${npmPrefix}) and \`sudo\` is not available.`,
      );
    }
  }

  if (requiresDockerRuntime) {
    if (!fs.existsSync(dockerComposeFile)) {
      addMissing(
        "docker-compose-file",
        `File docker compose non trovato: ${dockerComposeFile}`,
        `Docker compose file not found: ${dockerComposeFile}`,
      );
    }
    const dockerAvailable = commandIsAvailable(commandRunner, "docker");
    if (!dockerAvailable) {
      addMissing("docker", "Docker non trovato nel PATH.", "Docker is not available in PATH.");
    } else {
      if (!commandIsAvailable(commandRunner, "docker", ["compose", "version"])) {
        addMissing(
          "docker-compose",
          "`docker compose` non e' disponibile per l'utente corrente.",
          "`docker compose` is not available for the current user.",
        );
      }
      if (!commandIsAvailable(commandRunner, "docker", ["info"])) {
        addMissing(
          "docker-daemon",
          "Il daemon Docker non e' raggiungibile per l'utente corrente (`docker info` fallisce).",
          "The Docker daemon is not reachable for the current user (`docker info` failed).",
        );
      }
    }
  }

  return {
    ok: missing.length === 0,
    requiresDockerRuntime,
    dockerComposeFile,
    missing,
  };
}

function formatUpdatePrerequisitesFailure(result, locale = "it") {
  const normalizedLocale = normalizeLocale(locale);
  const header = normalizedLocale === "en"
    ? "Update prerequisites are not satisfied. Install/fix the following items and run `llmproxy update` again:"
    : "I prerequisiti per `llmproxy update` non sono soddisfatti. Installa/correggi questi elementi e rilancia `llmproxy update`:";
  const lines = [header];
  for (const item of result.missing || []) {
    lines.push(`- ${normalizedLocale === "en" ? item.messageEn : item.messageIt}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatQwenPlanLabel(endpointVariant) {
  const variant = normalizeQwenEndpointVariant(endpointVariant);
  if (variant === "token_plan") return "subscription";
  if (variant === "dashscope") return "payg";
  return "";
}

function formatProviderPlanSuffix(provider) {
  if (String(provider?.provider || "").toLowerCase() !== "qwen") return "";
  const plan = formatQwenPlanLabel(provider?.endpoint_variant);
  return plan ? ` plan=${plan}` : "";
}

function formatVisionSuffix(provider) {
  if (provider.vision === true) return " vision=true";
  if (provider.vision === false) return " vision=false";
  return "";
}

function formatProviderList(providers) {
  return providers.map((provider, index) => `${index + 1}. ${provider.id} (${provider.name})${formatProviderPlanSuffix(provider)}${formatVisionSuffix(provider)}`).join("\n");
}

function formatProviderStatus(providers) {
  const activeProviderId = providers[0]?.id || "none";
  const lines = [`Active provider: ${activeProviderId}`];
  providers.forEach((provider, index) => {
    const activeSuffix = index === 0 ? " [active]" : "";
    const defaultModel = provider.default_model || (provider.provider === "copilot" ? DEFAULT_COPILOT_MODEL : "");
    const state = provider.access_token && (provider.provider === "copilot" || defaultModel) ? "configured" : "incomplete";
    const modelSuffix = defaultModel ? ` model=${defaultModel}` : " model=missing";
    lines.push(`${index + 1}. ${provider.id} (${provider.name})${activeSuffix} provider=${provider.provider || "copilot"} auth=${provider.auth_type || "oauth"} state=${state}${modelSuffix}${formatVisionSuffix(provider)}${formatProviderPlanSuffix(provider)}`);
  });
  return lines.join("\n");
}

function resolveQwenEndpointVariant(providerId, planFlag, apiKey) {
  if (providerId !== "qwen") return "";
  const explicit = normalizeQwenEndpointVariant(planFlag);
  if (explicit) return explicit;
  return /^sk-sp-/i.test(String(apiKey || "").trim()) ? "token_plan" : "dashscope";
}

function formatModelList(models) {
  return models.map((model, index) => `${index + 1}. ${model}`).join("\n");
}

function sortBreakdownEntries(entriesObject = {}) {
  return Object.entries(entriesObject)
    .map(([key, value]) => [key, value || {}])
    .sort((left, right) => {
      const leftTotal = Number(left[1].tokens_input || 0) + Number(left[1].tokens_output || 0);
      const rightTotal = Number(right[1].tokens_input || 0) + Number(right[1].tokens_output || 0);
      if (rightTotal !== leftTotal) return rightTotal - leftTotal;
      const leftRequests = Number(left[1].requests || 0);
      const rightRequests = Number(right[1].requests || 0);
      if (rightRequests !== leftRequests) return rightRequests - leftRequests;
      return String(left[0]).localeCompare(String(right[0]));
    });
}

function formatBreakdownSection(title, entriesObject = {}) {
  const entries = sortBreakdownEntries(entriesObject);
  if (entries.length === 0) return `${title}:\n  none`;
  return `${title}:\n${entries.map(([key, value], index) => {
    const input = Number(value.tokens_input || 0);
    const output = Number(value.tokens_output || 0);
    const total = input + output;
    const requests = Number(value.requests || 0);
    return `  ${index + 1}. ${key} requests=${requests} total=${total} in=${input} out=${output}`;
  }).join("\n")}`;
}

async function fetchDbLayerStats(fetchFn, baseUrl) {
  const response = await fetchFn(`${String(baseUrl).replace(/\/$/, "")}/metering/stats`);
  if (!response.ok) {
    throw new Error(`db-layer stats HTTP ${response.status}`);
  }
  return response.json();
}

async function loadMeteringStats({ env, paths, fetchFn }) {
  const fallbackSink = createJsonlMeteringSink({ filePath: paths.meteringFile });
  const sinkMode = String(env.LLMPROXY_METERING_SINK || "").trim().toLowerCase();

  if (sinkMode === "dblayer") {
    try {
      const stats = await fetchDbLayerStats(fetchFn, env.DBLAYER_URL || "http://localhost:7046");
      return { stats, source: "dblayer" };
    } catch {
      return { stats: await Promise.resolve(fallbackSink.computeStats({})), source: "local-fallback" };
    }
  }

  if (sinkMode === "jsonl") {
    return { stats: await Promise.resolve(fallbackSink.computeStats({})), source: "jsonl" };
  }

  return { stats: await Promise.resolve(fallbackSink.computeStats({})), source: "local" };
}

function formatStatsReport(stats = {}, source = "unknown") {
  const totalRequests = Number(stats.total_requests || 0);
  const successCount = Number(stats.success_count || 0);
  const errorCount = Number(stats.error_count || 0);
  const input = Number(stats.total_tokens_input || 0);
  const output = Number(stats.total_tokens_output || 0);
  const total = Number(stats.total_tokens || 0);
  const lines = [
    `Source: ${source}`,
    `Requests: ${totalRequests} | Success: ${successCount} | Errors: ${errorCount}`,
    `Tokens: total=${total} in=${input} out=${output}`,
  ];
  if (stats.earliest_timestamp || stats.latest_timestamp) {
    lines.push(`Range: ${stats.earliest_timestamp || "n/a"} -> ${stats.latest_timestamp || "n/a"}`);
  }
  lines.push(formatBreakdownSection("Providers", stats.by_provider || {}));
  lines.push(formatBreakdownSection("Models", stats.by_model || {}));
  return lines.join("\n");
}

function sanitizeTestAssistantText(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith("[llmproxy] "))
    .join("\n")
    .trim();
}

function decodeBase64Utf8(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function parseCommitMessageReleaseNotes(commitMessage) {
  return String(commitMessage || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function formatReleaseNotes(version, locale = "it", options = {}) {
  const normalizedLocale = normalizeLocale(locale);
  const notesFromCommit = parseCommitMessageReleaseNotes(options.commitMessage);
  const notesFromPackage = readEmbeddedReleaseNotes(options.packageRoot, version);
  const value = RELEASE_NOTES[String(version || "").trim()];
  const fallbackNotes = Array.isArray(value)
    ? value
    : Array.isArray(value?.[normalizedLocale])
      ? value[normalizedLocale]
      : [];
  const notes = notesFromCommit.length > 0
    ? notesFromCommit
    : notesFromPackage.length > 0
      ? notesFromPackage
      : fallbackNotes;

  const title = normalizedLocale === "en" ? `Changelog ${version}:` : `Changelog ${version}:`;
  const lines = [title];
  if (!notes.length) {
    lines.push(normalizedLocale === "en"
      ? "- Release notes are not available for this version yet."
      : "- Note di rilascio non disponibili per questa versione.");
    return lines.join("\n");
  }
  for (const note of notes) lines.push(`- ${note}`);
  return lines.join("\n");
}

function resolveDefaultModel(selection, availableModels = getAvailableModels()) {
  const models = Array.isArray(availableModels) && availableModels.length > 0 ? availableModels : getAvailableModels();
  const rawSelection = String(selection || "").trim();
  if (!rawSelection) return DEFAULT_COPILOT_MODEL;

  if (!/^\d+$/.test(rawSelection)) {
    throw new Error("Usa l'indice numerico di `llmproxy models:list` con `llmproxy claude:setup --model <indice>`.");
  }

  const index = Number(rawSelection) - 1;
  if (index < 0 || index >= models.length) {
    throw new Error(`Indice modello non valido: ${rawSelection}`);
  }
  return models[index];
}

function runSelfUpdate(commandRunner = spawnSync, repo = "alessiobacin/llmProxy", locale = "it") {
  const script = [
    "set -e",
    "tmpdir=$(mktemp -d)",
    "cleanup() { rm -rf \"$tmpdir\"; }",
    "trap cleanup EXIT",
    "",
    "# Load nvm if available to use the correct Node version",
    'if [ -f "$HOME/.nvm/nvm.sh" ]; then',
    '  source "$HOME/.nvm/nvm.sh" 2>/dev/null || true',
    'elif [ -f "/usr/share/nvm/init-nvm.sh" ]; then',
    '  source "/usr/share/nvm/init-nvm.sh" 2>/dev/null || true',
    'fi',
    "",
    "# Try to use a modern Node version (20+) if available",
    'if command -v nvm >/dev/null 2>&1; then',
    '  nvm use 22 >/dev/null 2>&1 || nvm use 20 >/dev/null 2>&1 || nvm use lts >/dev/null 2>&1 || true',
    'fi',
    "",
    "# Verify Node version is at least 20",
    'node_version=$(node -v 2>/dev/null | sed "s/v//" | cut -d. -f1)',
    'if [ -n "$node_version" ] && [ "$node_version" -lt 20 ]; then',
    '  echo "Warning: Node v$(node -v) may be too old. Attempting to use a newer version..."',
    'fi',
    "",
    "existing_bins=$(which -a llmproxy 2>/dev/null | awk '!seen[$0]++')",
    "current_bin=$(command -v llmproxy 2>/dev/null || true)",
    "used_sudo=0",
    `gh repo clone ${repo} \"$tmpdir/repo\" -- --depth=1 >/dev/null`,
    'cd "$tmpdir/repo"',
    'target_version=$(node -p "require(\'./package.json\').version")',
    "commit_message_base64=$(git log -1 --pretty=%B | base64 | tr -d '\\n')",
    "",
    "# Try pnpm pack first, fall back to npm pack",
    'if command -v pnpm >/dev/null 2>&1 && pnpm pack --pack-destination "$tmpdir" >/dev/null 2>&1; then',
    '  package_file=$(find "$tmpdir" -maxdepth 1 -name "*.tgz" -print | head -n 1)',
    'else',
    '  npm pack >/dev/null 2>&1',
    '  package_file=$(find "$tmpdir" -maxdepth 1 -name "*.tgz" -print | head -n 1)',
    'fi',
    '[ -n "$package_file" ]',
    "",
    "# Try npm install, fall back to sudo if permissions fail",
    'if ! npm install -g "$package_file" 2>/dev/null; then',
    '  echo "Standard npm install failed, trying with sudo..."',
    '  if command -v sudo >/dev/null 2>&1; then',
    '    if sudo npm install -g "$package_file" 2>/dev/null; then',
    '      used_sudo=1',
    '    else',
    '      echo "Error: Cannot install llmproxy globally. Please run with sudo or fix npm permissions."',
    '      exit 1',
    '    fi',
    '  else',
    '    echo "Error: npm install failed and sudo is not available."',
    '    exit 1',
    '  fi',
    'fi',
    "",
    "# Clean up pnpm global if present",
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy" >/dev/null 2>&1 || true',
    'fi',
    "",
    "# Determine npm global prefix",
    'if [ "$used_sudo" -eq 1 ]; then',
    '  npm_prefix=$(sudo npm prefix -g 2>/dev/null || echo "/usr/local")',
    'else',
    '  npm_prefix=$(npm prefix -g 2>/dev/null || echo "/usr/local")',
    'fi',
    "",
    "# Find the newly installed binary",
    "resolved_bins=$(which -a llmproxy 2>/dev/null | awk '!seen[$0]++')",
    'new_bin=""',
    'for candidate_bin in $resolved_bins; do',
    '  if [ -x "$candidate_bin" ]; then',
    '    candidate_version=$("$candidate_bin" version 2>/dev/null || true)',
    '    if [ "$candidate_version" = "$target_version" ]; then',
    '      new_bin="$candidate_bin"',
    '      break',
    '    fi',
    '  fi',
    'done',
    'if [ -z "$new_bin" ]; then',
    '  new_bin="$npm_prefix/bin/llmproxy"',
    'fi',
    '[ -x "$new_bin" ]',
    'version_output=$("$new_bin" version)',
    '[ "$version_output" = "$target_version" ]',
    "",
    "# Remove old duplicate binaries",
    'for installed_bin in $resolved_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$new_bin" ] && [ "$installed_bin" != "$current_bin" ]; then',
    '    rm -f "$installed_bin" >/dev/null 2>&1 || { if [ "$used_sudo" -eq 1 ]; then sudo rm -f "$installed_bin" >/dev/null 2>&1 || true; else true; fi; }',
    '  fi',
    'done',
    "",
    "# Update current bin if it points to an old location",
    'if [ -n "$current_bin" ] && [ "$current_bin" != "$new_bin" ]; then',
    '  current_bin_dir=$(dirname "$current_bin")',
    '  if [ -w "$current_bin_dir" ]; then',
    '    rm -f "$current_bin" >/dev/null 2>&1 || true',
    '    cat > "$current_bin" <<EOF',
    '#!/bin/sh',
    'exec "$new_bin" "$@"',
    'EOF',
    '    chmod +x "$current_bin"',
    '  fi',
    'fi',
    "",
    "# Restart service",
    'service_restart_status=0',
    'service_restart_output=$("$new_bin" service:restart 2>&1 >/dev/null) || service_restart_status=$?',
    "",
    "# Update Docker container if running",
    'docker_compose_file="$npm_prefix/lib/node_modules/llmproxy/docker-compose.production.yml"',
    'if command -v docker >/dev/null 2>&1 && [ -f "$docker_compose_file" ]; then',
    '  if docker compose -f "$docker_compose_file" ps --services --status running 2>/dev/null | grep -qx "llmproxy"; then',
    '    docker compose -f "$docker_compose_file" up -d --build llmproxy >/dev/null || true',
    '  fi',
    'fi',
    "",
    "# Output results",
    `release_notes_output=$("$new_bin" release-notes --version "$version_output" --locale ${shellQuote(normalizeLocale(locale))} --commit-message-base64 "$commit_message_base64")`,
    'printf "__LLMPROXY_VERSION__=%s\\n" "$version_output"',
    'printf "__LLMPROXY_RELEASE_NOTES_START__\\n%s\\n__LLMPROXY_RELEASE_NOTES_END__\\n" "$release_notes_output"',
    'if [ "$service_restart_status" -ne 0 ]; then',
    '  printf "__LLMPROXY_SERVICE_RESTART_WARNING__=%s\\n" "$service_restart_output"',
    'fi',
  ].join("\n");
  return commandRunner("sh", ["-c", script], { encoding: "utf8" });
}

function runSelfUninstall(commandRunner = spawnSync) {
  const script = [
    'set -e',
    'npm uninstall -g llmproxy >/dev/null 2>&1 || true',
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy" >/dev/null 2>&1 || true',
    'fi',
  ].join("\n");
  return commandRunner("sh", ["-c", script], { encoding: "utf8" });
}

function buildPersistentInstallScript(options = {}) {
  const platform = String(options.platform || process.platform);
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const locale = options.locale === "en" ? "en" : "it";

  if (platform !== "darwin" && platform !== "linux") {
    if (locale === "en") {
      throw new Error(`Unsupported platform for persistent installation: ${platform}`);
    }
    throw new Error(`Piattaforma non supportata per installazione persistente: ${platform}`);
  }

  return [
    "set -e",
    `platform=${shellQuote(platform)}`,
    'case "$platform" in',
    '  darwin|linux) ;;',
    '  *) echo "Unsupported platform: $platform" >&2; exit 1 ;;',
    'esac',
    "existing_bins=$(which -a llmproxy 2>/dev/null | awk '!seen[$0]++')",
    `npm install -g ${shellQuote(packageRoot)}`,
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy"',
    'fi',
    'npm_prefix=$(npm prefix -g)',
    'global_bin="$npm_prefix/bin/llmproxy"',
    '[ -x "$global_bin" ]',
    'linger_user=${SUDO_USER:-$USER}',
    'for installed_bin in $existing_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$global_bin" ]; then',
    '    rm -f "$installed_bin"',
    '  fi',
    'done',
    'if [ "$platform" = "linux" ] && command -v sudo >/dev/null 2>&1; then',
    '  sudo -n loginctl enable-linger "$linger_user" >/dev/null 2>&1 || true',
    'fi',
    '"$global_bin" service:start',
    'printf "__LLMPROXY_GLOBAL_BIN__=%s\\n" "$global_bin"',
    'case "$global_bin" in',
    '  "$HOME"/*)',
    '    printf "__LLMPROXY_BIN_SCOPE__=user\\n"',
    '    printf "__LLMPROXY_BIN_HINT__=%s\\n" "Global bin is under \\$HOME ($global_bin). Other users on this server will not see the llmproxy command. To install server-wide, set npm prefix to a system path (e.g. /usr/local) and re-run with sufficient privileges (sudo)." ;;',
    '  *) printf "__LLMPROXY_BIN_SCOPE__=server\\n" ;;',
    'esac',
  ].join("\n");
}

function resolveInstallLocale(command) {
  if (command === "install" || command === "install:persistent-en") return "en";
  return "it";
}

function isPersistentInstallCommand(command) {
  return command === "install"
    || command === "install:persistent"
    || command === "install:persistent-it"
    || command === "install:persistent-en";
}

function runPersistentInstall(commandRunner = spawnSync, options = {}) {
  return commandRunner("sh", ["-c", buildPersistentInstallScript(options)], { encoding: "utf8" });
}

function getProxyBaseUrl(envOrOptions = process.env) {
  const options = envOrOptions && typeof envOrOptions === "object"
    && (Object.prototype.hasOwnProperty.call(envOrOptions, "env")
      || Object.prototype.hasOwnProperty.call(envOrOptions, "dataRoot")
      || Object.prototype.hasOwnProperty.call(envOrOptions, "host")
      || Object.prototype.hasOwnProperty.call(envOrOptions, "port"))
    ? envOrOptions
    : { env: envOrOptions };
  const { host, port } = resolveProxyHostPort(options);
  return `http://${host}:${port}`;
}

function resolveCliServiceManagerOptions({ env, paths, targetPlatform }) {
  const dockerComposeFile = path.join(paths.packageRoot, "docker-compose.production.yml");
  const proxyBinding = resolveProxyHostPort({ env, dataRoot: paths.dataRoot });

  return {
    platform: targetPlatform,
    packageRoot: paths.packageRoot,
    entryFile: resolveServiceEntryFile({ env, packageRoot: paths.packageRoot, targetPlatform }),
    serviceFile: targetPlatform === "darwin" ? paths.launchAgentFile : paths.systemdUnitFile,
    stdoutPath: paths.stdoutLogFile,
    stderrPath: paths.stderrLogFile,
    environment: resolveServiceEnvironment({
      env: { ...env, HOST: proxyBinding.host, PORT: proxyBinding.port },
      paths,
      dockerComposeFile,
    }),
  };
}

function resolveServiceEnvironment({ env = process.env, paths, dockerComposeFile }) {
  const binding = resolveProxyHostPort({ env, dataRoot: paths.dataRoot });
  return {
    PORT: String(binding.port),
    HOST: String(binding.host),
    NODE_ENV: String(env.NODE_ENV || "production"),
    LLMPROXY_ENV: String(env.LLMPROXY_ENV || env.NODE_ENV || "production"),
    LLMPROXY_HOME: paths.dataRoot,
    LLMPROXY_MODE: String(env.LLMPROXY_MODE || "platform"),
    LLMPROXY_METERING_SINK: String(env.LLMPROXY_METERING_SINK || "dblayer"),
    DBLAYER_URL: String(env.DBLAYER_URL || "http://localhost:7046"),
    EVENTBUS_URL: String(env.EVENTBUS_URL || "http://localhost:7048"),
    LLMPROXY_LOG_RETENTION_DAYS: String(env.LLMPROXY_LOG_RETENTION_DAYS || "30"),
    LLMPROXY_DOCKER_COMPOSE_FILE: dockerComposeFile,
    PATH: String(env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
  };
}

function resolveServiceEntryFile({ env = process.env, packageRoot, targetPlatform = process.platform }) {
  const forcedRuntime = String(env.LLMPROXY_SERVICE_RUNTIME || "").trim().toLowerCase();
  if (forcedRuntime === "docker") {
    return path.join(packageRoot, "lib", "service", "docker-launchd-entry.js");
  }
  if (forcedRuntime === "node") {
    return path.join(packageRoot, "server.js");
  }

  const profile = normalizeRuntimeProfile(env.LLMPROXY_ENV || env.NODE_ENV)
    || (String(packageRoot || "").includes(`${path.sep}node_modules${path.sep}`) ? "production" : "development");
  if ((profile === "production" || profile === "staging") && targetPlatform === "darwin") {
    return path.join(packageRoot, "lib", "service", "docker-launchd-entry.js");
  }

  return path.join(packageRoot, "server.js");
}

function writeClaudeSettings(options = {}) {
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const selectedModel = String(options.model || "").trim();
  const settingsDir = path.join(cwd, ".claude");
  const settingsFile = path.join(settingsDir, "settings.json");
  let existingConfig = {};

  if (fs.existsSync(settingsFile)) {
    existingConfig = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  }

  const proxyEnvSource = env.LLMPROXY_HOME && options.port == null
    ? { ...env, PORT: "" }
    : env;
  const proxyEnv = {
    ANTHROPIC_BASE_URL: getProxyBaseUrl({
      env: proxyEnvSource,
      dataRoot: env.LLMPROXY_HOME || options.dataRoot,
      host: options.host,
      port: options.port,
    }),
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
  if (options.includeDefaultModel !== false) {
    proxyEnv.ANTHROPIC_DEFAULT_MODEL = selectedModel;
  }
  const uiModelLabel = String(options.uiModelLabel || "llmProxy").trim() || "llmProxy";
  const existingEnv = existingConfig.env && typeof existingConfig.env === "object" ? existingConfig.env : {};
  if (options.includeDefaultModel === false) {
    delete existingEnv.ANTHROPIC_DEFAULT_MODEL;
  }
  if (options.omitAuthToken !== false) {
    delete existingEnv.ANTHROPIC_AUTH_TOKEN;
  }

  const nextConfig = {
    ...existingConfig,
    model: uiModelLabel,
    env: {
      ...existingEnv,
      ...proxyEnv,
    },
  };

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  stdout.write(`Configurazione Claude scritta in ${settingsFile}\n`);
  stdout.write(`ANTHROPIC_BASE_URL: ${proxyEnv.ANTHROPIC_BASE_URL}\n`);
  stdout.write(`Default model: ${selectedModel}\n`);
  return 0;
}

function configureClaudeSettings(options = {}) {
  const defaultModel = resolveDefaultModel(options.model, options.availableModels);
  return writeClaudeSettings({
    cwd: options.cwd,
    env: options.env,
    stdout: options.stdout,
    model: defaultModel,
    includeDefaultModel: false,
    omitAuthToken: true,
    uiModelLabel: "llmProxy",
    dataRoot: options.dataRoot,
  });
}

function setClaudeModel(options = {}) {
  const selectedModel = String(options.model || "").trim();
  if (!selectedModel) {
    throw new Error("Uso: llmproxy model:set <model>");
  }
  return writeClaudeSettings({
    cwd: options.cwd,
    env: options.env,
    stdout: options.stdout,
    model: selectedModel,
    uiModelLabel: selectedModel,
  });
}

function tailFile(filePath, lines = 80) {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf8").trimEnd();
  if (!content) return "";
  const chunks = content.split(/\r?\n/);
  return chunks.slice(-lines).join("\n");
}

function tailLatestRequestLog(logsDir, lines = 80) {
  if (!fs.existsSync(logsDir)) return "";
  const requestLogs = fs.readdirSync(logsDir)
    .filter((fileName) => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName))
    .sort();

  const latestLog = requestLogs.at(-1);
  if (!latestLog) return "";
  return tailFile(path.join(logsDir, latestLog), lines);
}

function followLogs(paths, stdout, stderr) {
  const requestLogs = fs.existsSync(paths.logsDir)
    ? fs.readdirSync(paths.logsDir)
      .filter((fileName) => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName))
      .sort()
      .map((fileName) => path.join(paths.logsDir, fileName))
    : [];
  const files = [paths.stdoutLogFile, paths.stderrLogFile, ...requestLogs].filter((filePath) => fs.existsSync(filePath));
  if (files.length === 0) {
    stdout.write("Nessun file di log disponibile. Avvia prima il servizio.\n");
    return Promise.resolve(0);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("tail", ["-n", "50", "-f", ...files], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function isTransientLocalFetchError(error) {
  const message = String(error?.message || error || "").trim();
  return /fetch failed|socket connection was closed unexpectedly|socket.*closed|econnreset|econnrefused|etimedout|timeout|network error/i.test(message);
}

async function runLocalProxyTestRequest(fetchFn, url, request, sleepFn) {
  const delay = typeof sleepFn === "function"
    ? sleepFn
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetchFn(url, request);
    } catch (error) {
      if (!isTransientLocalFetchError(error) || attempt === 3) throw error;
      await delay(250);
    }
  }
}

async function runCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const fetchFn = options.fetchFn || fetch;
  const sleep = options.sleep;
  const env = loadRuntimeEnv({ env: options.env || process.env, packageRoot: options.packageRoot });
  const parsed = parseArgs(argv || process.argv);
  const targetPlatform = options.platform || process.platform;
  const paths = createPaths({ dataRoot: options.dataRoot, packageRoot: options.packageRoot, env, homeDir: options.homeDir, platform: targetPlatform });
  ensureRuntimeDirs(paths);
  const tokenStore = options.tokenStore || createTokenStore({ filePath: paths.tokenFile });
  const modelCatalogStore = options.modelCatalogStore || createCopilotModelCatalogStore({ filePath: paths.modelCatalogFile });
  const serviceManager = options.serviceManager || createServiceManager(resolveCliServiceManagerOptions({ env, paths, targetPlatform }));
  const smartRouterStore = options.smartRouterStore || createSmartRouterStore({ filePath: paths.smartRouterFile });

  if (parsed.command === "help") {
    if (parsed.args[0]) return printCommandHelp(parsed.args[0], stdout);
    printHelp(stdout);
    return 0;
  }

  if (parsed.command === "setup") {
    stdout.write(`Runtime root: ${paths.dataRoot}\n`);
    stdout.write(`Service manager: ${serviceManager.kind}\n`);
    return 0;
  }

  if (parsed.command === "version") {
    stdout.write(`${readPackageVersion(paths.packageRoot)}\n`);
    return 0;
  }

  if (parsed.command === "release-notes") {
    const version = String(parsed.flags.version || parsed.args[0] || readPackageVersion(paths.packageRoot)).trim();
    const locale = parsed.flags.locale
      ? normalizeLocale(parsed.flags.locale)
      : resolveOutputLocale({ env, paths });
    const commitMessage = decodeBase64Utf8(parsed.flags["commit-message-base64"] || parsed.flags.commitMessageBase64);
    stdout.write(`${formatReleaseNotes(version, locale, { commitMessage, packageRoot: paths.packageRoot })}\n`);
    return 0;
  }

  if (isPersistentInstallCommand(parsed.command)) {
    const installLocale = resolveInstallLocale(parsed.command);
    const isEnglishInstallCommand = installLocale === "en";
    if (targetPlatform !== "darwin" && targetPlatform !== "linux") {
      if (isEnglishInstallCommand) {
        stderr.write(`Unsupported platform for persistent installation: ${targetPlatform}\n`);
      } else {
        stderr.write(`Piattaforma non supportata per installazione persistente: ${targetPlatform}\n`);
      }
      return 1;
    }

    const result = runPersistentInstall(options.commandRunner, {
      packageRoot: paths.packageRoot,
      platform: targetPlatform,
      locale: installLocale,
    });

    if (result?.status === 0) {
      const rawStdout = String(result.stdout || "");
      const globalBinMatch = rawStdout.match(/^__LLMPROXY_GLOBAL_BIN__=(.+)$/m);
      const binScopeMatch = rawStdout.match(/^__LLMPROXY_BIN_SCOPE__=(.+)$/m);
      const binHintMatch = rawStdout.match(/^__LLMPROXY_BIN_HINT__=(.+)$/m);
      const visibleStdout = rawStdout
        .replace(/^__LLMPROXY_GLOBAL_BIN__=.+$/m, "")
        .replace(/^__LLMPROXY_BIN_SCOPE__=.+$/m, "")
        .replace(/^__LLMPROXY_BIN_HINT__=.+$/m, "")
        .trim();

      const binScope = binScopeMatch?.[1]?.trim() || "unknown";

      if (isEnglishInstallCommand) {
        stdout.write("Persistent installation completed.\n");
        if (globalBinMatch?.[1]) stdout.write(`Global binary: ${String(globalBinMatch[1]).trim()}\n`);
        stdout.write(`Binary scope: ${binScope === "server" ? "server-wide (available to all users)" : binScope === "user" ? "user-only (current user)" : binScope}\n`);
        if (binScope === "user" && binHintMatch?.[1]) {
          stdout.write(`Hint: ${binHintMatch[1].trim()}\n`);
        }
        stdout.write(`Persistent service enabled with ${serviceManager.kind}.\n`);
      } else {
        stdout.write("Installazione persistente completata.\n");
        if (globalBinMatch?.[1]) stdout.write(`Binario globale: ${String(globalBinMatch[1]).trim()}\n`);
        stdout.write(`Visibilità binario: ${binScope === "server" ? "server-wide (disponibile a tutti gli utenti)" : binScope === "user" ? "solo utente corrente" : binScope}\n`);
        if (binScope === "user" && binHintMatch?.[1]) {
          stdout.write(`Suggerimento: ${binHintMatch[1].trim()}\n`);
        }
        stdout.write(`Servizio persistente attivato con ${serviceManager.kind}.\n`);
      }
      if (visibleStdout) stdout.write(`${visibleStdout}\n`);
      if (targetPlatform === "linux") {
        if (isEnglishInstallCommand) {
          stdout.write("Linux note: to restart even without a user login, enable linger with `sudo loginctl enable-linger $USER`.\n");
        } else {
          stdout.write("Nota Linux: per riavvio anche senza login utente abilita linger con `sudo loginctl enable-linger $USER`.\n");
        }
      }
      persistInstallLocale(paths, installLocale);
      return 0;
    }

    if (isEnglishInstallCommand) {
      stderr.write((result?.stderr && String(result.stderr).trim()) || "Persistent installation failed.\n");
    } else {
      stderr.write((result?.stderr && String(result.stderr).trim()) || "Installazione persistente fallita.\n");
    }
    return 1;
  }

  if (parsed.command === "models:list") {
    const models = await resolveAvailableCopilotModels({
      tokenStore,
      fetchFn,
      catalogStore: modelCatalogStore,
      fallbackModels: getAvailableModels(),
    });
    stdout.write(`${formatModelList(models)}\n`);
    return 0;
  }

  if (parsed.command === "test") {
    const providers = tokenStore.listProviders();
    const allProviders = Boolean(parsed.flags["all-providers"]);
    const targets = providers.length > 0
      ? providers
      : [{ id: "auto", name: "auto", provider: "copilot", default_model: DEFAULT_COPILOT_MODEL }];
    const selectedTargets = allProviders ? targets : targets.slice(0, 1);

    // Verifica che il proxy sia raggiungibile prima di iniziare i test
    const proxyBaseUrl = getProxyBaseUrl({ env, dataRoot: paths.dataRoot });
    stdout.write(`Proxy endpoint: ${proxyBaseUrl}\n`);

    try {
      const healthCheck = await fetchFn(`${proxyBaseUrl}/v1/llm/health`, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      if (!healthCheck.ok) {
        stderr.write(`Errore: Il proxy non è raggiungibile su ${proxyBaseUrl}\n`);
        stderr.write(`  Status: ${healthCheck.status}\n`);
        stderr.write(`  Verifica che il servizio llmproxy sia in esecuzione:\n`);
        stderr.write(`    llmproxy service:start\n`);
        stderr.write(`    # oppure\n`);
        stderr.write(`    systemctl --user status llmproxy\n`);
        return 1;
      }
      const healthData = await healthCheck.json();
      stdout.write(`Proxy stato: ${healthData.ok ? 'OK' : 'ERRORE'} (versione: ${healthData.manifest_version || 'sconosciuta'})\n\n`);
    } catch (error) {
      stderr.write(`Errore: Il proxy non è raggiungibile su ${proxyBaseUrl}\n`);
      stderr.write(`  ${error.message}\n`);
      stderr.write(`  Verifica che il servizio llmproxy sia in esecuzione:\n`);
      stderr.write(`    llmproxy service:start\n`);
      stderr.write(`    # oppure\n`);
      stderr.write(`    systemctl --user status llmproxy\n`);
      stderr.write(`  Se il servizio è in esecuzione, verifica la porta:\n`);
      stderr.write(`    ss -tlnp | grep node\n`);
      return 1;
    }

    let failures = 0;

    for (const provider of selectedTargets) {
      const model = provider.default_model || (String(provider.provider || "copilot") === "copilot" ? DEFAULT_COPILOT_MODEL : "");
      if (!model) {
        stdout.write(`${provider.id}: skipped (default model mancante)\n`);
        failures += 1;
        continue;
      }

      try {
        const response = await runLocalProxyTestRequest(
          fetchFn,
          `${proxyBaseUrl}/v1/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              provider: provider.id === "auto" ? undefined : provider.id,
              model,
              stream: false,
              max_tokens: 256,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: `Rispondi solo: llmproxy-test-${provider.id}` }],
                },
              ],
            }),
          },
          sleep,
        );

        if (!response.ok) {
          stdout.write(`${provider.id}: fail HTTP ${response.status} (${model})\n`);
          failures += 1;
          continue;
        }

        const payload = await response.json();
        const assistantText = Array.isArray(payload?.content)
          ? payload.content
            .filter((item) => item && item.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("\n")
            .trim()
          : "";
        const visibleAssistantText = sanitizeTestAssistantText(assistantText);

        if (!visibleAssistantText) {
          stdout.write(`${provider.id}: fail risposta vuota (${model})\n`);
          failures += 1;
          continue;
        }

        stdout.write(`${provider.id}: ok (${model}) ${visibleAssistantText}\n`);
      } catch (error) {
        const errorMessage = error.message || String(error || "");
        stdout.write(`${provider.id}: fail ${errorMessage} (${model})\n`);

        // Fornisci suggerimenti specifici basati sul tipo di errore
        if (/fetch failed|econnrefused|network error|socket hang up/i.test(errorMessage)) {
          stdout.write(`  Il provider non è raggiungibile. Possibili cause:\n`);
          stdout.write(`  1. Il proxy non è in esecuzione (avvia con: llmproxy service:start)\n`);
          stdout.write(`  2. La API key per ${provider.id} non è valida o è scaduta\n`);
          stdout.write(`  3. Il modello '${model}' non è disponibile per il tuo piano\n`);
          stdout.write(`  4. Problemi di rete o firewall\n`);
          stdout.write(`\n`);
          stdout.write(`  Verifica lo stato dei provider:\n`);
          stdout.write(`    llmproxy provider:list\n`);
          stdout.write(`  Aggiorna la API key se necessario:\n`);
          stdout.write(`    llmproxy provider:key ${provider.id} --api-key <nuova-key>\n`);
        } else if (/401|unauthorized|invalid api key/i.test(errorMessage)) {
          stdout.write(`  La API key per ${provider.id} non è valida.\n`);
          stdout.write(`  Aggiornala con: llmproxy provider:key ${provider.id} --api-key <key>\n`);
        } else if (/429|rate limit|too many requests/i.test(errorMessage)) {
          stdout.write(`  Hai raggiunto il limite di richieste per ${provider.id}.\n`);
          stdout.write(`  Attendi qualche minuto o usa un altro provider.\n`);
        }
        failures += 1;
      }
    }

    return failures === 0 ? 0 : 1;
  }

  if (parsed.command === "claude:setup") {
    try {
      const models = await resolveAvailableCopilotModels({
        tokenStore,
        fetchFn,
        catalogStore: modelCatalogStore,
        fallbackModels: getAvailableModels(),
      });
      return configureClaudeSettings({ cwd: options.cwd, env, stdout, model: parsed.flags.model, availableModels: models, dataRoot: paths.dataRoot });
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "model:set") {
    try {
      return setClaudeModel({ cwd: options.cwd, env, stdout, model: parsed.args[0] });
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "update") {
    const locale = resolveOutputLocale({ env, paths });
    const preflight = resolveUpdatePrerequisites({
      commandRunner: options.commandRunner || spawnSync,
      env,
      paths,
    });
    if (!preflight.ok) {
      stderr.write(formatUpdatePrerequisitesFailure(preflight, locale));
      return 1;
    }
    const result = runSelfUpdate(options.commandRunner, undefined, locale);
    if (result?.status === 0) {
      const rawStdout = String(result.stdout || "");
      const versionMatch = rawStdout.match(/^__LLMPROXY_VERSION__=(.+)$/m);
      const releaseNotesMatch = rawStdout.match(/__LLMPROXY_RELEASE_NOTES_START__\n([\s\S]*?)\n__LLMPROXY_RELEASE_NOTES_END__/m);
      const serviceRestartWarningMatch = rawStdout.match(/^__LLMPROXY_SERVICE_RESTART_WARNING__=(.+)$/m);
      const visibleStdout = rawStdout
        .replace(/^__LLMPROXY_VERSION__=.+$/m, "")
        .replace(/__LLMPROXY_RELEASE_NOTES_START__\n[\s\S]*?\n__LLMPROXY_RELEASE_NOTES_END__\n?/m, "")
        .replace(/^__LLMPROXY_SERVICE_RESTART_WARNING__=.+$/m, "")
        .trim();
      stdout.write("Aggiornamento completato.\n");
      if (visibleStdout) stdout.write(`${visibleStdout}\n`);
      if (versionMatch?.[1]) {
        const currentVersion = String(versionMatch[1]).trim();
        stdout.write(`Versione corrente: ${currentVersion}\n`);
        const releaseNotes = releaseNotesMatch?.[1]?.trim() || formatReleaseNotes(currentVersion, locale);
        stdout.write(`${releaseNotes}\n`);
        if (serviceRestartWarningMatch?.[1]) {
          stdout.write(`Warning riavvio servizio: ${String(serviceRestartWarningMatch[1]).trim()}\n`);
        }
        return 0;
      }
      stderr.write("Aggiornamento completato, ma il rilancio di llmproxy e' fallito.\n");
      return 1;
    }
    stderr.write((result?.stderr && String(result.stderr).trim()) || "Aggiornamento fallito.\n");
    return 1;
  }

  if (parsed.command === "uninstall") {
    const result = runSelfUninstall(options.commandRunner);
    if (result?.status === 0) {
      stdout.write("Disinstallazione completata.\n");
      return 0;
    }
    stderr.write((result?.stderr && String(result.stderr).trim()) || "Disinstallazione fallita.\n");
    return 1;
  }

  if (parsed.command === "login") {
    const deviceData = await startDeviceFlow({ fetchFn });
    stdout.write(`Apri ${deviceData.verification_uri} e inserisci il codice ${deviceData.user_code}\n`);
    const result = await pollForToken(deviceData.device_code, deviceData.interval || 5, { fetchFn, store: tokenStore, sleep });
    if (!result.success) {
      stderr.write(`Login fallito: ${result.error}\n`);
      return 1;
    }
    stdout.write("Login completato.\n");
    return 0;
  }

  if (parsed.command === "provider:add") {
    const providerId = normalizeKnownProviderId(parsed.args[0]);
    const providerName = String(parsed.flags.name || getKnownProvider(providerId).displayName || providerId || "").trim();
    const apiKey = String(parsed.flags["api-key"] || "").trim();
    const defaultModel = String(parsed.flags.model || parsed.flags["default-model"] || "").trim();
    const explicitQwenPlan = normalizeQwenEndpointVariant(parsed.flags.plan);
    const endpointVariant = resolveQwenEndpointVariant(providerId, parsed.flags.plan, apiKey);
    const visionFlag = parsed.flags.vision;
    const visionEnabled = visionFlag === "true" || visionFlag === true;
    const visionDisabled = visionFlag === "false" || visionFlag === false;
    if (!providerId) {
      stderr.write("Provider id richiesto. Uso: llmproxy provider:add <id> --api-key <key> --model <model> --vision <true|false> [--name <name>] [--plan <plan>]\n");
      return 1;
    }

    const providerInfo = getKnownProvider(providerId);
    if (!providerInfo.auth) {
      stderr.write(`Provider non supportato: ${providerId}. Esempi: copilot, openrouter, kimi, qwen, z.ai\n`);
      return 1;
    }

    if (providerInfo.auth === "api_key") {
      if (!apiKey) {
        stderr.write(`Il provider ${providerId} richiede --api-key. Uso: llmproxy provider:add ${providerId} --api-key <key> --model <model> --vision <true|false>\n`);
        return 1;
      }
      if (providerId === "qwen" && parsed.flags.plan && !explicitQwenPlan) {
        stderr.write("Per `qwen` usa --plan subscription oppure --plan payg.\n");
        return 1;
      }
      if (!defaultModel) {
        stderr.write(`Il provider ${providerId} richiede --model per salvare e verificare il modello di default.\n`);
        return 1;
      }
      if (visionFlag === undefined || visionFlag === null || visionFlag === "") {
        stderr.write(`Il provider ${providerId} richiede --vision <true|false>. Esempio: llmproxy provider:add ${providerId} --api-key <key> --model ${defaultModel} --vision true\n`);
        return 1;
      }
      if (!visionEnabled && !visionDisabled) {
        stderr.write(`--vision deve essere 'true' oppure 'false'. Valore ricevuto: '${visionFlag}'\n`);
        return 1;
      }
      const probe = await probeApiKeyProviderModel({ provider: { provider: providerId, endpoint_variant: endpointVariant }, apiKey, model: defaultModel, fetchFn });
      if (!probe.ok) {
        stderr.write(`Test provider fallito per ${providerId}/${defaultModel}: ${probe.status || "network"} ${probe.error || ""}\n`);
        return 1;
      }
      tokenStore.saveProvider(providerId, {
        access_token: apiKey,
        token_type: "api_key",
        scope: "api_key",
        provider: providerId,
        auth_type: "api_key",
        default_model: defaultModel,
        endpoint_variant: endpointVariant,
        vision: visionEnabled,
      }, { name: providerName || providerId });
      const planSuffix = providerId === "qwen" ? `, plan: ${formatQwenPlanLabel(endpointVariant)}` : "";
      stdout.write(`Provider configurato con API key: ${providerId} (default model: ${defaultModel}, vision: ${visionEnabled}${planSuffix}).\n`);
      return 0;
    }

    const deviceData = await startDeviceFlow({ fetchFn });
    stdout.write(`Apri ${deviceData.verification_uri} e inserisci il codice ${deviceData.user_code}\n`);
    const result = await pollForToken(deviceData.device_code, deviceData.interval || 5, {
      fetchFn,
      sleep,
      store: {
        save(data) {
          return tokenStore.saveProvider(providerId, {
            ...data,
            provider: "copilot",
            auth_type: "oauth",
            default_model: defaultModel || DEFAULT_COPILOT_MODEL,
          }, { name: providerName || providerId });
        },
      },
    });
    if (!result.success) {
      stderr.write(`Login fallito: ${result.error}\n`);
      return 1;
    }
    stdout.write(`Login completato per provider ${providerId}.\n`);
    return 0;
  }

  if (parsed.command === "provider:key") {
    const providerId = normalizeKnownProviderId(parsed.args[0]);
    const apiKey = String(parsed.flags["api-key"] || "").trim();
    const defaultModel = String(parsed.flags.model || parsed.flags["default-model"] || "").trim();
    const explicitQwenPlan = normalizeQwenEndpointVariant(parsed.flags.plan);
    const visionFlag = parsed.flags.vision;
    if (!providerId || !apiKey) {
      stderr.write("Uso: llmproxy provider:key <id> --api-key <key> [--model <model>] [--vision <true|false>] [--plan <plan>]\n");
      return 1;
    }

    const providerInfo = getKnownProvider(providerId);
    if (!providerInfo.auth) {
      stderr.write(`Provider non supportato: ${providerId}.\n`);
      return 1;
    }
    if (providerInfo.auth !== "api_key") {
      stderr.write(`Il provider ${providerId} non usa API key. Usa \`llmproxy provider:add ${providerId}\` per autenticazione OAuth.\n`);
      return 1;
    }

    const existing = tokenStore.getProvider(providerId);
    const endpointVariant = resolveQwenEndpointVariant(providerId, parsed.flags.plan, apiKey) || existing?.endpoint_variant || "";
    const nextDefaultModel = defaultModel || existing?.default_model || "";
    if (!nextDefaultModel) {
      stderr.write(`Il provider ${providerId} non ha un modello di default salvato. Usa --model <model>.\n`);
      return 1;
    }
    if (providerId === "qwen" && parsed.flags.plan && !explicitQwenPlan) {
      stderr.write("Per `qwen` usa --plan subscription oppure --plan payg.\n");
      return 1;
    }
    let nextVision = existing?.vision;
    if (visionFlag !== undefined && visionFlag !== null && visionFlag !== "") {
      if (visionFlag !== "true" && visionFlag !== true && visionFlag !== "false" && visionFlag !== false) {
        stderr.write(`--vision deve essere 'true' oppure 'false'. Valore ricevuto: '${visionFlag}'\n`);
        return 1;
      }
      nextVision = visionFlag === "true" || visionFlag === true;
    }
    const probe = await probeApiKeyProviderModel({ provider: { provider: providerId, endpoint_variant: endpointVariant }, apiKey, model: nextDefaultModel, fetchFn });
    if (!probe.ok) {
      stderr.write(`Test provider fallito per ${providerId}/${nextDefaultModel}: ${probe.status || "network"} ${probe.error || ""}\n`);
      return 1;
    }
    tokenStore.saveProvider(providerId, {
      ...(existing || {}),
      access_token: apiKey,
      token_type: "api_key",
      scope: "api_key",
      provider: providerId,
      auth_type: "api_key",
      default_model: nextDefaultModel,
      endpoint_variant: endpointVariant,
      vision: nextVision,
    }, { name: existing?.name || providerInfo.displayName || providerId });

    const planSuffix = providerId === "qwen" ? `, plan: ${formatQwenPlanLabel(endpointVariant)}` : "";
    const visionSuffix = nextVision !== undefined ? `, vision: ${nextVision}` : "";
    stdout.write(`API key aggiornata per provider ${providerId} (default model: ${nextDefaultModel}${visionSuffix}${planSuffix}).\n`);
    return 0;
  }

  if (parsed.command === "provider:list") {
    const providers = tokenStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato.\n");
      return 0;
    }
    stdout.write(`${formatProviderList(providers)}\n`);
    return 0;
  }

  if (parsed.command === "provider:test") {
    const providers = tokenStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato. Usa 'llmproxy provider:add' per aggiungere un provider.\n");
      return 1;
    }

    // Leggi l'immagine di test dal file assets
    const testImagePath = path.join(paths.packageRoot, "assets", "test-vision.png");
    let testImageBase64;
    try {
      const imageBuffer = fs.readFileSync(testImagePath);
      testImageBase64 = imageBuffer.toString('base64');
    } catch (err) {
      stdout.write(`Errore: impossibile leggere l'immagine di test da ${testImagePath}\n`);
      return 1;
    }

    // Prompt che chiede esplicitamente di descrivere i colori
    const visionPrompt = "Descrivi questa immagine. Quali colori vedi e dove sono posizionati?";

    // Parole chiave che indicano visione effettiva
    const visionKeywords = ["rosso", "red", "blu", "blue", "colore", "color", "immagine", "image", "alto", "top", "basso", "bottom", "sopra", "above", "sotto", "below"];

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    stdout.write("Test visione provider...\n\n");

    for (const provider of providers) {
      const model = provider.default_model;
      const vision = provider.vision;
      const providerName = provider.name || provider.id;

      if (!model) {
        stdout.write(`⏭️  ${providerName}: saltato (modello non configurato)\n`);
        skipCount++;
        continue;
      }

      // Mostra stato atteso
      const expectedStatus = vision === true ? "visione ✅" : vision === false ? "testo ❌" : "visione sconosciuta ⚠️";
      stdout.write(`🔍 ${providerName} (${model}) - atteso: ${expectedStatus}\n`);

      try {
        const baseUrl = getProxyBaseUrl({ env, dataRoot: paths.dataRoot });
        const response = await runLocalProxyTestRequest(
          fetchFn,
          `${baseUrl}/v1/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              provider: provider.id,
              model,
              stream: false,
              max_tokens: 150,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: visionPrompt },
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: testImageBase64,
                      },
                    },
                  ],
                },
              ],
            }),
          },
          sleep,
        );

        if (!response.ok) {
          const errorText = await response.text();
          // Per provider con vision=false, gli errori sono attesi (immagini non elaborate)
          if (vision === false) {
            stdout.write(`  ✅ PASS - Visione correttamente disabilitata (errore HTTP ${response.status})\n`);
            passCount++;
            continue;
          }
          stdout.write(`  ❌ Errore HTTP ${response.status}: ${errorText.slice(0, 100)}\n`);
          failCount++;
          continue;
        }

        const payload = await response.json();
        
        // La risposta può essere in formato Anthropic o OpenAI a seconda dell'endpoint
        let assistantText = "";
        let reasoningText = "";
        
        // Formato OpenAI (choices[0].message)
        if (payload?.choices?.[0]?.message) {
          const message = payload.choices[0].message;
          assistantText = typeof message.content === "string" ? message.content : "";
          reasoningText = message.reasoning_content || "";
        }
        // Formato Anthropic (content array)
        else if (Array.isArray(payload?.content)) {
          assistantText = payload.content
            .filter((item) => item && item.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("\n")
            .trim();
          reasoningText = payload.reasoning_content || "";
        }

        const combinedText = [assistantText, reasoningText].filter(t => t).join("\n");

        if (!combinedText) {
          stdout.write(`  ❌ Risposta vuota\n`);
          failCount++;
          continue;
        }

        // Verifica se la risposta contiene parole chiave di visione
        const responseLower = combinedText.toLowerCase();
        const hasVisionIndicators = visionKeywords.some((keyword) => responseLower.includes(keyword));

        if (hasVisionIndicators) {
          // Provider ha effettivamente visto l'immagine
          if (vision === true) {
            stdout.write(`  ✅ PASS - Visione confermata\n`);
            stdout.write(`     Risposta: ${combinedText.slice(0, 100)}...\n`);
            passCount++;
          } else {
            stdout.write(`  ⚠️  WARN - Visione rilevata ma flag vision=false\n`);
            stdout.write(`     Risposta: ${combinedText.slice(0, 100)}...\n`);
            passCount++;
          }
        } else {
          // Provider NON ha visto l'immagine
          if (vision === false) {
            stdout.write(`  ✅ PASS - Visione correttamente disabilitata\n`);
            stdout.write(`     Risposta: ${combinedText.slice(0, 80)}...\n`);
            passCount++;
          } else {
            stdout.write(`  ❌ FAIL - Visione attesa ma non rilevata\n`);
            stdout.write(`     Risposta: ${combinedText.slice(0, 80)}...\n`);
            failCount++;
          }
        }
      } catch (error) {
        stdout.write(`  ❌ Errore: ${error.message}\n`);
        failCount++;
      }
    }

    stdout.write("\n");
    stdout.write(`Risultati: ${passCount} pass, ${failCount} fail, ${skipCount} skip\n`);

    return failCount === 0 ? 0 : 1;
  }

  if (parsed.command === "provider:available") {
    stdout.write(`${formatAvailableProviders()}\n`);
    return 0;
  }

  if (parsed.command === "provider:status") {
    const providers = tokenStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato.\n");
      return 0;
    }
    stdout.write(`${formatProviderStatus(providers)}\n`);
    return 0;
  }

  if (parsed.command === "provider:order") {
    const providerId = String(parsed.args[0] || "").trim();
    const position = Number(parsed.args[1] || 0);
    if (!providerId || !Number.isFinite(position) || position <= 0) {
      stderr.write("Uso: llmproxy provider:order <id> <position>\n");
      return 1;
    }
    try {
      const providers = tokenStore.moveProvider(providerId, position);
      stdout.write(`Nuovo ordine provider: ${providers.map((provider) => provider.id).join(", ")}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "provider:rename") {
    const providerId = String(parsed.args[0] || "").trim();
    const nextName = parsed.args.slice(1).join(" ").trim();
    if (!providerId || !nextName) {
      stderr.write("Uso: llmproxy provider:rename <id> <name>\n");
      return 1;
    }
    try {
      const provider = tokenStore.renameProvider(providerId, nextName);
      stdout.write(`Provider rinominato: ${provider.id} -> ${provider.name}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "provider:remove") {
    const providerId = String(parsed.args[0] || "").trim();
    if (!providerId) {
      stderr.write("Uso: llmproxy provider:remove <id>\n");
      return 1;
    }
    tokenStore.clearProvider(providerId);
    stdout.write(`Provider rimosso: ${providerId}\n`);
    return 0;
  }

  if (parsed.command === "logout") {
    tokenStore.clear();
    stdout.write("Token Copilot rimosso.\n");
    return 0;
  }

  if (parsed.command === "run") {
    const { host, port } = await startServer({
      dataRoot: paths.dataRoot,
      packageRoot: paths.packageRoot,
      host: proxyBinding.host,
      port: Number(proxyBinding.port),
    });
    stdout.write(`llmProxy in ascolto su http://${host}:${port}\n`);
    return new Promise(() => {});
  }

  if (parsed.command === "status") {
    const status = serviceManager.status();
    const providers = tokenStore.listProviders();
    stdout.write(`Service manager: ${serviceManager.kind}\n`);
    stdout.write(`Service active: ${status.active ? "yes" : "no"}\n`);
    stdout.write(`Authenticated: ${tokenStore.getAccessToken() ? "yes" : "no"}\n`);
    if (providers.length > 0) {
      stdout.write(`Active provider: ${providers[0].id}\n`);
      stdout.write(`Fallback order: ${providers.map((provider) => provider.id).join(", ")}\n`);
      stdout.write("Providers:\n");
      providers.forEach((provider, index) => {
        const defaultModel = provider.default_model || (provider.provider === "copilot" ? DEFAULT_COPILOT_MODEL : "");
        const state = provider.access_token && (provider.provider === "copilot" || defaultModel) ? "configured" : "incomplete";
        stdout.write(`${index + 1}. ${provider.id} (${provider.name}) provider=${provider.provider || "copilot"} auth=${provider.auth_type || "oauth"} state=${state} model=${defaultModel || "missing"}\n`);
      });
    }
    if (status.stdout) stdout.write(`${status.stdout}\n`);
    if (!status.ok && status.stderr) stderr.write(`${status.stderr}\n`);
    if (parsed.flags.docker) {
      const composeFile = env.LLMPROXY_DOCKER_COMPOSE_FILE || dockerComposeFile;
      stdout.write(`\nDocker containers (${path.basename(composeFile)}):\n`);
      const dockerResult = spawnSync(
        "docker",
        ["compose", "-f", composeFile, "ps", "--format", "table"],
        { encoding: "utf8" },
      );
      if (dockerResult.error) {
        stderr.write(`Docker non disponibile: ${dockerResult.error.message}\n`);
      } else if (dockerResult.status !== 0) {
        stderr.write(dockerResult.stderr || "Errore docker compose ps.\n");
      } else {
        stdout.write(dockerResult.stdout || "(nessun container trovato)\n");
      }
    }
    return status.ok ? 0 : 1;
  }

  if (parsed.command === "stats") {
    try {
      const result = await loadMeteringStats({ env, paths, fetchFn });
      stdout.write(`${formatStatsReport(result.stats, result.source)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "logs") {
    if (parsed.follow) {
      return followLogs(paths, stdout, stderr);
    }
    const outLog = tailFile(paths.stdoutLogFile);
    const errLog = tailFile(paths.stderrLogFile);
    const requestLog = tailLatestRequestLog(paths.logsDir);
    if (outLog) stdout.write(`${outLog}\n`);
    if (errLog) stderr.write(`${errLog}\n`);
    if (requestLog) stdout.write(`${requestLog}\n`);
    if (!outLog && !errLog && !requestLog) stdout.write("Nessun log disponibile.\n");
    return 0;
  }

  if (parsed.command === "service:start") {
    const result = serviceManager.install();
    if (!result.ok) {
      stderr.write((result.stderr && String(result.stderr).trim()) || "Installazione servizio fallita.\n");
      return 1;
    }
    stdout.write(`Servizio installato con ${serviceManager.kind}.\n`);
    stdout.write(`stdout: ${result.stdoutPath}\n`);
    stdout.write(`stderr: ${result.stderrPath}\n`);
    return 0;
  }

  if (parsed.command === "service:stop") {
    const result = serviceManager.stop();
    if (!result.ok) {
      stderr.write(result.stderr || "Arresto servizio fallito.\n");
      return 1;
    }
    stdout.write("Servizio arrestato.\n");
    return 0;
  }

  if (parsed.command === "service:restart") {
    let stopResult = { ok: true, stdout: "", stderr: "" };
    let startResult;

    if (serviceManager.kind === "launchd") {
      if (typeof serviceManager.install === "function") {
        startResult = serviceManager.install();
      } else {
        startResult = serviceManager.start();
      }
    } else {
      stopResult = serviceManager.stop();
      startResult = serviceManager.start();
    }

    if (!stopResult.ok || !startResult.ok) {
      stderr.write(((startResult.stderr || stopResult.stderr) && String(startResult.stderr || stopResult.stderr).trim()) || "Riavvio servizio fallito.\n");
      return 1;
    }
    stdout.write("Servizio riavviato.\n");
    return 0;
  }

  if (parsed.command === "smart:add") {
    const providerId = normalizeKnownProviderId(parsed.flags.provider);
    const model = String(parsed.flags.model || "").trim();
    const apiKey = String(parsed.flags["api-key"] || "").trim();

    if (!providerId || !model || !apiKey) {
      stderr.write("Uso: llmproxy smart:add --provider <p> --model <m> --api-key <k>\n");
      return 1;
    }

    const providerInfo = getKnownProvider(providerId);
    if (!providerInfo.auth || providerInfo.auth !== "api_key") {
      stderr.write(`Provider non supportato come classifier: ${providerId}. Usa un provider api_key (es. openrouter, deepseek).\n`);
      return 1;
    }

    smartRouterStore.setConfig({
      classifierProvider: providerId,
      classifierModel: model,
      classifierApiKey: apiKey,
      enabled: true,
    });

    stdout.write(`Smart router configurato: provider=${providerId} model=${model} apiKey=sk-****\n`);
    return 0;
  }

  if (parsed.command === "smart:status") {
    const config = smartRouterStore.getConfig();
    const isConfigured = smartRouterStore.isConfigured();
    const providers = tokenStore.listProviders();
    const maskedKey = config.classifierApiKey
      ? `${String(config.classifierApiKey).slice(0, 5)}-****`
      : "(none)";

    stdout.write(`Smart router status:\n`);
    stdout.write(`  Enabled: ${config.enabled ? "yes" : "no"}\n`);
    stdout.write(`  Configured: ${isConfigured ? "yes" : "no"}\n`);
    if (isConfigured) {
      stdout.write(`  Classifier provider: ${config.classifierProvider}\n`);
      stdout.write(`  Classifier model: ${config.classifierModel}\n`);
      stdout.write(`  Classifier API key: ${maskedKey}\n`);
    } else {
      stdout.write(`  (non configurato — usa llmproxy smart:add per attivarlo)\n`);
    }
    stdout.write(`  Registered providers: ${providers.length}\n`);
    for (const p of providers) {
      stdout.write(`    - ${p.id} (${p.name}) model=${p.default_model || "n/a"}\n`);
    }
    return 0;
  }

  if (parsed.command === "smart:test") {
    const config = smartRouterStore.getConfig();
    if (!smartRouterStore.isConfigured()) {
      stdout.write("Smart router non configurato. Usa: llmproxy smart:add --provider <p> --model <m> --api-key <k>\n");
      return 0;
    }

    const providers = tokenStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato. Aggiungi prima un provider con llmproxy provider:add.\n");
      return 0;
    }

    const activeProviders = providers.map((p) => ({
      provider: p.provider || "copilot",
      scope_type: "user",
      scope_id: p.id,
      active: true,
      models: p.default_model ? [p.default_model] : [],
    }));

    const scenarios = [
      { name: "simple (chat breve)", body: { messages: [{ role: "user", content: "Ciao" }] } },
      { name: "moderate (con tools)", body: { messages: [{ role: "user", content: "Analizza questo file" }], tools: [{ name: "read_file" }] } },
      { name: "complex (vision + tools)", body: { messages: [{ role: "user", content: [{ type: "text", text: "Descrivi" }, { type: "image" }] }], tools: [{ name: "read_file" }, { name: "write_file" }] } },
    ];

    stdout.write(`Simulazione routing (classifier: ${config.classifierProvider}/${config.classifierModel}):\n\n`);
    for (const scenario of scenarios) {
      const analysis = analyzeRequest(scenario.body);
      const route = routeRequest(analysis, activeProviders, "balanced");
      stdout.write(`  ${scenario.name}:\n`);
      stdout.write(`    complexity=${analysis.complexity} vision=${analysis.needsVision} tools=${analysis.needsTools} tier=${analysis.recommendedTier}\n`);
      if (route) {
        stdout.write(`    -> model=${route.model} provider=${route.provider} tier=${route.tier}\n`);
      } else {
        stdout.write(`    -> (nessun modello adatto)\n`);
      }
    }
    return 0;
  }

  if (parsed.command === "smart:refresh") {
    // La cache è in-memory nel processo server; dalla CLI invalidiamo il file di stato.
    stdout.write("Cache availability provider invalidata. Il prossimo request ricaricherà lo stato.\n");
    return 0;
  }

  printHelp(stderr);
  return 1;
}

module.exports = {
  runCli,
  parseArgs,
  printHelp,
  configureClaudeSettings,
  setClaudeModel,
  formatAvailableProviders,
  formatBreakdownSection,
  formatModelList,
  formatProviderList,
  formatProviderStatus,
  formatStatsReport,
  loadMeteringStats,
  sanitizeTestAssistantText,
  getProxyBaseUrl,
  resolveDefaultModel,
  runSelfUpdate,
  buildPersistentInstallScript,
  runPersistentInstall,
  resolveServiceEntryFile,
  resolveServiceEnvironment,
  resolveCliServiceManagerOptions,
};
