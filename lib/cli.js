const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createPaths, ensureRuntimeDirs, getDockerHostProjectsRoot } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createProviderRegistry } = require("./provider-registry");
const { createCopilotModelCatalogStore, resolveAvailableCopilotModels } = require("./copilot-models");
const { startDeviceFlow, pollForToken } = require("./copilot-auth");
const { createServiceManager } = require("./service-manager");
const { startServer } = require("./app");
const { getAvailableModels, mapModel, DEFAULT_COPILOT_MODEL } = require("./openai-translate");
const { probeApiKeyProviderModel, normalizeQwenEndpointVariant, parseProviderModelPreferences } = require("./copilot-proxy");
const {
  loadRuntimeEnv,
  normalizeRuntimeProfile,
  resolveProxyHostPort,
  resolveRuntimeProfile,
} = require("./runtime-env");
const { createJsonlMeteringSink } = require("./metering");
const { resolveClaudeProjectSettings } = require("./project-context");
const { resolveDockerComposeCommand, runDockerCompose } = require("./docker-compose");
const { listPortListeners } = require("./port-guard");
const {
  inferScopeFromKey,
  hasLocalClaudeFolder,
  listConfigSpecs,
  listScopeValues,
  getScopeValue,
  migrateManagedConfig,
  readServiceConfig,
  setScopeValue,
  unsetScopeValue,
  writeServiceConfig,
} = require("./configuration");
function buildProxyAgentUrl(proxyUrlRaw, proxyApiKey) {
  if (!proxyUrlRaw && !proxyApiKey) return "";
  const host = proxyUrlRaw ? proxyUrlRaw.replace(/^https?:\/\//, "").split("/")[0] : "";
  const key = (proxyApiKey || "").trim();
  if (key && host) return `http://proxy:${key}@${host}:7064`;
  if (host) return `http://${host}:7064`;
  return "";
}

const AVAILABLE_PROVIDER_SPECS = [
  { id: "copilot", auth: "oauth", displayName: "GitHub Copilot", aliases: [] },
  { id: "openrouter", auth: "api_key", displayName: "OpenRouter", aliases: [] },
  { id: "zai", auth: "api_key", displayName: "Z.AI", aliases: ["z.ai"] },
  { id: "kimi", auth: "api_key", displayName: "Kimi (Moonshot)", aliases: [] },
  { id: "qwen", auth: "api_key", displayName: "Qwen (DashScope)", aliases: [] },
  { id: "opencode", auth: "api_key", displayName: "OpenCode Zen", aliases: ["zen"] },
  { id: "opencode-go", auth: "api_key", displayName: "OpenCode Go", aliases: ["go", "opencodego"] },
  { id: "openai", auth: "api_key", displayName: "OpenAI", aliases: [] },
  { id: "anthropic", auth: "api_key", displayName: "Anthropic", aliases: [] },
  { id: "deepseek", auth: "api_key", displayName: "DeepSeek", aliases: [] },
  { id: "groq", auth: "api_key", displayName: "Groq", aliases: [] },
  { id: "mistral", auth: "api_key", displayName: "Mistral", aliases: [] },
  { id: "xai", auth: "api_key", displayName: "xAI", aliases: [] },
  { id: "perplexity", auth: "api_key", displayName: "Perplexity", aliases: [] },
  { id: "together", auth: "api_key", displayName: "Together", aliases: [] },
  { id: "fireworks", auth: "api_key", displayName: "Fireworks", aliases: [] },
  { id: "commandcode", auth: "api_key", displayName: "Command Code", aliases: [] },
  { id: "nvidia", auth: "api_key", displayName: "NVIDIA", aliases: [] },
];

const KNOWN_PROVIDERS = AVAILABLE_PROVIDER_SPECS.reduce((acc, provider) => {
  const entry = { auth: provider.auth, displayName: provider.displayName };
  acc[provider.id] = entry;
  for (const alias of provider.aliases) acc[alias] = entry;
  return acc;
}, {});

const SHORT_COMMAND_ALIASES = {
  // Comandi senza gruppo
  h: "help",
  su: "setup",
  v: "version",
  rn: "release-notes",
  up: "update",
  un: "uninstall",
  in: "install",
  li: "login",
  lo: "logout",
  sto: "stop",
  st: "status",
  sa: "stats",
  lg: "logs",
  t: "test",
  // Gruppo provider
  "p:a": "provider:add",
  "p:k": "provider:key",
  "p:av": "provider:available",
  "p:l": "provider:list",
  "p:t": "provider:test",
  "p:s": "provider:status",
  "p:u": "provider:usage",
  "p:o": "provider:order",
  "p:rn": "provider:rename",
  "p:rm": "provider:remove",
  // Gruppo config
  "c:l": "config:list",
  "c:g": "config:get",
  "c:s": "config:set",
  "c:u": "config:unset",
  // Gruppo service
  "sv:sta": "service:start",
  "sv:sto": "service:stop",
  "sv:r": "service:restart",
  "sv:rt": "service:runtime",
  // Gruppo model/models
  "m:l": "models:list",
  "m:s": "model:set",
  // Gruppo claude
  "cc:s": "claude:setup",
  // Gruppo stats
  "sa:r": "stats:reset",
  // Gruppo install
  "in:p": "install:persistent",
  "in:it": "install:persistent-it",
  "in:en": "install:persistent-en",
};

const INSTALL_LOCALE_FILE = "install-locale.txt";

const REVERSE_SHORT_ALIASES = Object.fromEntries(
  Object.entries(SHORT_COMMAND_ALIASES).map(([short, full]) => [full, short]),
);

const RELEASE_NOTES = {
  "0.3.01": {
    it: [
      "Self-update: backup automatico del pacchetto globale attuale prima di installare la nuova release.",
      "Verifica post-update: il binario appena installato deve superare `version`, `config:list` e `status` prima di essere confermato.",
      "Rollback automatico: se la nuova build non passa i controlli, llmProxy ripristina la versione precedente e riavvia il servizio gestito.",
    ],
    en: [
      "Self-update: automatically back up the current global package before installing the new release.",
      "Post-update verification: the freshly installed binary must pass `version`, `config:list`, and `status` before it is accepted.",
      "Automatic rollback: if the new build fails validation, llmProxy restores the previous version and restarts the managed service.",
    ],
  },
  "0.2.68": {
    it: [
      "Self-update: usa sempre il binario del pacchetto appena installato prima di qualunque wrapper vecchio trovato nel PATH.",
      "Wrapper globale: ricreazione automatica di `llmproxy` se manca dopo l'aggiornamento.",
      "Cleanup update: il wrapper globale valido viene preservato e non puo' piu' essere rimosso dall'update stesso.",
    ],
    en: [
      "Self-update: always prefer the freshly installed package CLI before any stale wrapper found in PATH.",
      "Global wrapper: automatically recreate `llmproxy` when it is missing after update.",
      "Update cleanup: preserve the valid global wrapper so the updater cannot remove its own entrypoint.",
    ],
  },
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
  if (normalized === "zen" || normalized === "opencode") return "opencode";
  if (normalized === "go" || normalized === "opencodego" || normalized === "opencode-go") return "opencode-go";
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
    if (token.startsWith("-") && !token.startsWith("--")) {
      const shortFlags = token.slice(1).trim();
      if (shortFlags) {
        // Se il token dopo il singolo dash contiene un hyphen, è un long flag
        // scritto con un dash solo per errore (es. -all-providers → --all-providers)
        if (shortFlags.includes("-")) {
          flags[shortFlags] = true;
          continue;
        }
        for (const shortFlag of shortFlags) flags[shortFlag] = true;
        continue;
      }
    }
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

  const command = args[0] || "help";
  const expandedCommand = SHORT_COMMAND_ALIASES[command] || command;

  return {
    command: expandedCommand,
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
    description: "Disinstallazione completa: ferma il servizio, rimuove container Docker, dati, file di servizio e pacchetto globale.",
    when: "Usalo quando vuoi rimuovere completamente llmproxy dal sistema (servizio, Docker, dati, pacchetto).",
    example: "llmproxy uninstall",
  },
  "login": {
    usage: "llmproxy login",
    description: "Alias legacy di `llmproxy provider:add copilot`: autentica GitHub Copilot via device flow.",
    when: "Usalo solo per compatibilita'; il flusso consigliato e' `llmproxy provider:add copilot`.",
    example: "llmproxy provider:add copilot",
  },
  "logout": {
    usage: "llmproxy logout",
    description: "Rimuove i token Copilot locali.",
    when: "Usalo per forzare un nuovo login o per pulire completamente le credenziali locali.",
    example: "llmproxy logout",
  },
  "provider:add": {
    usage: "llmproxy provider:add <id> --api-key <key> --model <model> --vision <true|false> [--free-model [true|false]] [--name <name>] [--plan <plan>]",
    description: "Aggiunge un provider noto: Copilot via device flow, gli altri provider tramite API key e modello predefinito. --vision e' obbligatorio per i provider API key. Usa --free-model per marcare la coppia provider/modello come gratuita e impedire all'auto-escalation di abbandonarla.",
    when: "Usalo quando vuoi configurare un provider di fallback aggiuntivo, per esempio openrouter o kimi, oltre al provider principale.",
    example: "llmproxy provider:add qwen --api-key sk-sp-... --model qwen3.7-plus --vision true --plan subscription",
  },
  "provider:key": {
    usage: "llmproxy provider:key <id> --api-key <key> [--model <model>] [--vision <true|false>] [--free-model <true|false>] [--plan <plan>]",
    description: "Aggiorna o imposta la API key di un provider gia' configurato con autenticazione api_key. --vision e' opzionale (mantiene il valore esistente se omesso). --free-model puo' attivare o disattivare il blocco dell'auto-escalation per quella coppia provider/modello.",
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
    description: "Elenca i provider configurati o, dentro un progetto con override Claude, la chain effettiva di fallback del progetto.",
    when: "Usalo per controllare rapidamente quali provider verranno davvero provati, con i modelli effettivi derivati da ANTHROPIC_DEFAULT_MODEL quando presente.",
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
  "provider:usage": {
    usage: "llmproxy provider:usage",
    description: "Mostra il consumo di token giornaliero, settimanale e mensile con breakdown per provider e modello.",
    when: "Usalo quando vuoi monitorare il consumo di token e capire quale provider/modello costa di piu'.",
    example: "llmproxy provider:usage",
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
    description: "Avvia l'istanza locale/dev in foreground.",
    when: "Usalo per debug rapido locale sulla porta 5045 senza toccare il servizio persistente.",
    example: "llmproxy run",
  },
  "stop": {
    usage: "llmproxy stop",
    description: "Ferma solo l'istanza locale/dev avviata con `llmproxy run` sulla porta 5045.",
    when: "Usalo quando vuoi chiudere la run locale senza fermare il servizio persistente.",
    example: "llmproxy stop",
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
  "stats:reset": {
    usage: "llmproxy stats:reset [--hard]",
    description: "Azzera tutte le statistiche di utilizzo (metering records). Con --hard resetta anche la cache dello smart router e il file di configurazione auto-rank.",
    when: "Usalo quando vuoi ripartire da zero con le statistiche, per esempio dopo un cambio configurazione o per fare test puliti.",
    example: "llmproxy stats:reset --hard",
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
    description: "Riavvia il servizio persistente e verifica che il runtime Docker/locale sia tornato sano.",
    when: "Usalo dopo update o modifiche alla configurazione runtime.",
    example: "llmproxy service:restart",
  },
  "service:runtime": {
    usage: "llmproxy service:runtime <docker|native|launchd|systemd>",
    description: "Passa in modo esplicito tra runtime Docker e runtime nativo, pulendo quello precedente e verificando l'health finale.",
    when: "Usalo quando vuoi migrare la macchina dalla variante Docker a quella launchd/systemd o viceversa con un solo comando.",
    example: "llmproxy service:runtime docker",
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
  "config:list": {
    usage: "llmproxy config:list [--project|--service]",
    description: "Mostra le variabili configurabili di progetto e/o servizio gestite da llmproxy.",
    when: "Usalo per verificare rapidamente gli override in .claude/settings.json e la configurazione persistita del servizio.",
    example: "llmproxy config:list --project",
  },
  "config:get": {
    usage: "llmproxy config:get <key> [--project|--service]",
    description: "Legge una variabile configurabile di llmproxy dal progetto o dal servizio.",
    when: "Usalo quando vuoi verificare il valore effettivo di una variabile prima di cambiarla.",
    example: "llmproxy config:get LLMPROXY_PRICE_PERFORMANCE_ROUTING --project",
  },
  "config:set": {
    usage: "llmproxy config:set <key> <value> [--project|--service]",
    description: "Imposta una variabile configurabile di llmproxy nello scope corretto.",
    when: "Usalo per aggiornare routing di progetto o parametri runtime senza editare i file a mano.",
    example: "llmproxy config:set LLMPROXY_PRICE_PERFORMANCE_ROUTING 1 --project",
  },
  "config:unset": {
    usage: "llmproxy config:unset <key> [--project|--service]",
    description: "Rimuove una variabile configurabile di llmproxy dal progetto o dal servizio.",
    when: "Usalo quando vuoi tornare al comportamento di default senza lasciare override residui.",
    example: "llmproxy config:unset ANTHROPIC_DEFAULT_MODEL --project",
  },
  "test": {
    usage: "llmproxy test [-i|--inference] [--all-providers]",
    description: "Esegue un probe rapido dei provider oppure, con -i, una vera inferenza con fallback reale contro il proxy locale.",
    when: "Usalo per verificare rapidamente lo stato sintetico dei provider oppure quale provider risponde davvero a una richiesta /v1/messages.",
    example: "llmproxy test -i --all-providers",
  },
  "claude:setup": {
    usage: "llmproxy claude:setup [--model <indice>]",
    description: "Scrive .claude/settings.json per usare llmproxy come backend locale di Claude Code.",
    when: "Usalo nel progetto che vuoi collegare a llmproxy, dopo aver configurato almeno un provider e dopo aver scelto il modello con models:list.",
    example: "llmproxy claude:setup --model 2",
  },
};

function printCommandHelp(command, stdout = process.stdout) {
  const entry = COMMAND_HELP[command];
  if (!entry) {
    stdout.write(`Comando non documentato: ${command}\n`);
    stdout.write("Usa `llmproxy help` per l'elenco completo.\n");
    return 1;
  }

  const shortAlias = REVERSE_SHORT_ALIASES[command] || "";
  const isEnglishInstallCommand = entry.locale === "en";
  const descriptionLabel = isEnglishInstallCommand ? "Description" : "Descrizione";
  const whenLabel = isEnglishInstallCommand ? "When to use" : "Quando usarlo";
  const exampleLabel = isEnglishInstallCommand ? "Example" : "Esempio";
  const description = isEnglishInstallCommand ? (entry.englishDescription || entry.description) : entry.description;
  const when = isEnglishInstallCommand ? (entry.englishWhen || entry.when) : entry.when;
  const example = isEnglishInstallCommand ? (entry.englishExample || entry.example) : entry.example;

  if (shortAlias) stdout.write(`Short: llmp ${shortAlias}\n`);
  stdout.write(`${entry.usage}\n\n`);
  stdout.write(`${descriptionLabel}: ${description}\n`);
  stdout.write(`${whenLabel}: ${when}\n`);
  if (example) stdout.write(`${exampleLabel}: ${example}\n`);
  return 0;
}

function printHelp(stdout = process.stdout) {
  const knownProvidersInline = formatKnownProvidersInline();
  const s = (cmd) => {
    const alias = REVERSE_SHORT_ALIASES[cmd];
    return alias ? `[llmp ${alias}]` : "";
  };
  stdout.write(`llmProxy CLI

Comandi principali:
  llmproxy help                            ${s("help")}  mostra questa guida
  llmproxy setup                           ${s("setup")}  verifica il runtime locale, il data root e il service manager selezionato
  llmproxy version                         ${s("version")}  mostra la versione corrente della CLI installata
  llmproxy install:persistent-it           ${s("install:persistent-it")}  installa globalmente la CLI corrente e attiva il servizio persistente nativo dell'OS
  llmproxy install:persistent-en           ${s("install:persistent-en")}  installs the current CLI globally and enables the native persistent service for the OS
  llmproxy install                         ${s("install")}  English alias for install:persistent-en
  llmproxy install:persistent              ${s("install:persistent")}  alias legacy di install:persistent-it
  llmproxy update                          ${s("update")}  scarica e installa l'ultima versione dalla repo e verifica il binario aggiornato
  llmproxy uninstall                       ${s("uninstall")}  disinstallazione completa: servizio, Docker, dati e pacchetto globale

Esecuzione proxy:
  llmproxy run                                       avvia l'istanza locale/dev in foreground su 127.0.0.1:5045
  llmproxy stop                            ${s("stop")}  ferma solo l'istanza locale/dev su 127.0.0.1:5045
  llmproxy status                          ${s("status")}  mostra stato del servizio, autenticazione e ordine dei provider
  llmproxy stats                           ${s("stats")}  mostra statistiche aggregate di utilizzo per provider e modello
  llmproxy stats:reset [--hard]            ${s("stats:reset")}  azzera le statistiche di utilizzo; con --hard resetta anche cache e auto-rank
  llmproxy logs [--follow]                 ${s("logs")}  legge i log recenti; usa --follow per seguire il flusso in tempo reale

Servizio persistente:
  llmproxy service:start                   ${s("service:start")}  installa e avvia il servizio utente persistente
  llmproxy service:stop                    ${s("service:stop")}  ferma il servizio persistente
  llmproxy service:restart                 ${s("service:restart")}  riavvia il servizio persistente dopo modifiche o update
  llmproxy service:runtime <target>        ${s("service:runtime")}  passa tra runtime docker e runtime nativo pulendo quello precedente

Provider:
  llmproxy provider:add <id> ...           ${s("provider:add")}  aggiunge un provider noto (Copilot avvia il login; gli altri usano API key)
  llmproxy provider:key <id> --api-key <k> ${s("provider:key")}  aggiorna/imposta la API key per provider API-key
  llmproxy provider:available              ${s("provider:available")}  elenca i provider supportati dalla CLI
  llmproxy provider:list                   ${s("provider:list")}  elenca i provider configurati o la chain effettiva del progetto corrente
  llmproxy provider:test                   ${s("provider:test")}  testa la capacita' di visione di tutti i provider configurati
  llmproxy provider:status                 ${s("provider:status")}  mostra quale provider e' attivo in questo momento
  llmproxy provider:usage                  ${s("provider:usage")}  mostra consumo token giornaliero, settimanale e mensile
  llmproxy provider:order <id> <position>  ${s("provider:order")}  cambia la priorita' di fallback di un provider
  llmproxy provider:rename <id> <name>     ${s("provider:rename")}  rinomina un provider per distinguerlo meglio
  llmproxy provider:remove <id>            ${s("provider:remove")}  rimuove un provider configurato

Provider noti:
  ${knownProvidersInline}

Modelli e Claude Code:
  llmproxy models:list                     ${s("models:list")}  mostra i modelli disponibili in forma numerata
  llmproxy model:set <model>               ${s("model:set")}  aggiorna il modello del progetto (es. deepseek:deepseek-v4-flash)
  llmproxy config:list [--project|--service]  ${s("config:list")}  mostra le variabili configurabili gestite da llmproxy
  llmproxy config:get <key> [...]          ${s("config:get")}  legge una variabile configurabile
  llmproxy config:set <key> <value> [...]  ${s("config:set")}  imposta una variabile configurabile
  llmproxy config:unset <key> [...]        ${s("config:unset")}  rimuove una variabile configurabile
  llmproxy test                            ${s("test")}  esegue un test rapido di inferenza contro il proxy locale
  llmproxy claude:setup [--model <indice>] ${s("claude:setup")}  scrive .claude/settings.json per usare llmproxy come backend locale

Quando usare cosa:
  1. Prima installazione persistente: install:persistent-it oppure install:persistent-en -> provider:add <provider> -> models:list -> claude:setup
  2. Uso come servizio: service:start -> status -> logs
  3. Multi-account: provider:add -> provider:list -> provider:order
  4. Aggiornamento CLI: update
  5. Rimozione completa: uninstall

Problemi comuni:
  - llmproxy non risponde: usa llmproxy status e poi llmproxy logs --follow
  - Claude Code non vede il proxy: rilancia llmproxy claude:setup nel progetto corretto
  - un modello fallisce: controlla llmproxy models:list e scegli un indice valido
  - il token Copilot non funziona: riesegui llmproxy provider:add copilot
`);
}

function readPackageVersion(packageRoot) {
  const packageFile = path.join(packageRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  return String(pkg.version || "0.0.0");
}

async function readRemotePackageVersion(fetchFn, repo = "alessiobacin/llmProxy", options = {}) {
  if (typeof fetchFn !== "function") return "";
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : 3000;
  const versionRequest = fetchFn(`https://raw.githubusercontent.com/${repo}/main/package.json`, {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
  const response = await Promise.race([
    Promise.resolve(versionRequest),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!response || !response.ok) return "";
  const payload = await response.json();
  return String(payload?.version || "").trim();
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

function readOsReleaseInfo(options = {}) {
  const platform = String(options.platform || process.platform);
  if (platform !== "linux") return {};
  const content = typeof options.content === "string"
    ? options.content
    : (fs.existsSync("/etc/os-release") ? fs.readFileSync("/etc/os-release", "utf8") : "");
  if (!content) return {};

  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function detectLinuxPackageFamily(osRelease = {}) {
  const tokens = [
    osRelease.ID,
    osRelease.ID_LIKE,
    osRelease.NAME,
    osRelease.PRETTY_NAME,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/(ubuntu|debian|mint|pop)/.test(tokens)) return "debian";
  if (/(rhel|fedora|centos|rocky|almalinux)/.test(tokens)) return "rhel";
  if (/(arch|manjaro)/.test(tokens)) return "arch";
  return "generic";
}

function getPrerequisiteFixCommands(key, options = {}) {
  const locale = normalizeLocale(options.locale);
  const platform = String(options.platform || process.platform);
  const linuxFamily = detectLinuxPackageFamily(options.osRelease);
  const localPrefixCommands = locale === "en"
    ? [
      "mkdir -p \"$HOME/.local/npm\"",
      "npm config set prefix \"$HOME/.local/npm\"",
      "echo 'export PATH=\"$HOME/.local/npm/bin:$PATH\"' >> ~/.profile",
    ]
    : [
      "mkdir -p \"$HOME/.local/npm\"",
      "npm config set prefix \"$HOME/.local/npm\"",
      "echo 'export PATH=\"$HOME/.local/npm/bin:$PATH\"' >> ~/.profile",
    ];

  if (platform === "darwin") {
    if (key === "npm") return ["brew install node"];
    if (key === "docker" || key === "docker-compose") return ["brew install --cask docker"];
    if (key === "docker-daemon") return ["open -a Docker"];
    if (key === "npm-write") return localPrefixCommands;
    return [];
  }

  if (platform === "win32") {
    if (key === "npm") return ["Scarica e installa Node.js da https://nodejs.org (versione LTS 22.x)"];
    if (key === "npm-write") return locale === "en"
      ? ["Run PowerShell as Administrator: npm config set prefix \"%APPDATA%\\npm\""]
      : ["Esegui PowerShell come Amministratore: npm config set prefix \"%APPDATA%\\npm\""];
    return [];
  }

  if (platform !== "linux") return [];

  if (key === "systemd-user-bus") return locale === "en"
    ? ["loginctl enable-linger", "sudo loginctl enable-linger $USER"]
    : ["loginctl enable-linger", "sudo loginctl enable-linger $USER"];

  if (linuxFamily === "debian") {
    if (key === "npm") return ["sudo apt update && sudo apt install -y nodejs npm"];
    if (key === "docker" || key === "docker-compose") return ["sudo apt update && sudo apt install -y docker.io docker-compose-v2"];
    if (key === "docker-daemon") return ["sudo systemctl enable --now docker", "sudo usermod -aG docker \"$USER\""];
    if (key === "systemctl") return ["sudo apt update && sudo apt install -y systemd"];
    if (key === "npm-write") return localPrefixCommands;
    return [];
  }

  if (linuxFamily === "rhel") {
    if (key === "npm") return ["sudo dnf install -y nodejs npm"];
    if (key === "docker" || key === "docker-compose") return ["sudo dnf install -y docker docker-compose-plugin"];
    if (key === "docker-daemon") return ["sudo systemctl enable --now docker", "sudo usermod -aG docker \"$USER\""];
    if (key === "systemctl") return ["sudo dnf install -y systemd"];
    if (key === "npm-write") return localPrefixCommands;
    return [];
  }

  if (linuxFamily === "arch") {
    if (key === "npm") return ["sudo pacman -Sy --noconfirm nodejs npm"];
    if (key === "docker" || key === "docker-compose") return ["sudo pacman -Sy --noconfirm docker docker-compose"];
    if (key === "docker-daemon") return ["sudo systemctl enable --now docker", "sudo usermod -aG docker \"$USER\""];
    if (key === "systemctl") return ["sudo pacman -Sy --noconfirm systemd"];
    if (key === "npm-write") return localPrefixCommands;
    return [];
  }

  if (key === "npm") return [locale === "en" ? "Install Node.js + npm with your distro package manager." : "Installa Node.js + npm con il package manager della tua distro."];
  if (key === "docker" || key === "docker-compose") {
    return [locale === "en"
      ? "Install Docker Engine plus Docker Compose plugin (or the legacy docker-compose binary)."
      : "Installa Docker Engine piu' il plugin Docker Compose (oppure il binario legacy docker-compose)."];
  }
  if (key === "docker-daemon") return ["sudo systemctl enable --now docker", "sudo usermod -aG docker \"$USER\""];
  if (key === "systemctl") {
    return [locale === "en"
      ? "Use a Linux environment with systemd user services enabled."
      : "Usa un ambiente Linux con servizi utente systemd abilitati."];
  }
  if (key === "npm-write") return localPrefixCommands;
  return [];
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
      if (!resolveDockerComposeCommand(commandRunner).ok) {
        addMissing(
          "docker-compose",
          "Docker Compose non e' disponibile (`docker compose` e `docker-compose` falliscono).",
          "Docker Compose is not available (`docker compose` and `docker-compose` both failed).",
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

function resolvePersistentInstallPrerequisites(options = {}) {
  const commandRunner = options.commandRunner || spawnSync;
  const env = options.env || process.env;
  const targetPlatform = String(options.targetPlatform || process.platform);
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const runtimeEnv = {
    ...env,
    LLMPROXY_ENV: String(env.LLMPROXY_ENV || env.NODE_ENV || "production"),
  };
  const runtimeEntry = resolveServiceEntryFile({ env: runtimeEnv, packageRoot: path.join("/tmp", "node_modules", "llmproxy"), targetPlatform });
  const requiresDockerRuntime = path.basename(runtimeEntry) === "docker-launchd-entry.js";
  const dockerComposeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(packageRoot, "docker-compose.production.yml")).trim();
  const missing = [];

  const addMissing = (key, messageIt, messageEn) => {
    if (missing.some((item) => item.key === key)) return;
    missing.push({ key, messageIt, messageEn });
  };

  if (!fs.existsSync(packageRoot)) {
    addMissing(
      "package-root",
      `Directory del progetto non trovata: ${packageRoot}`,
      `Project directory not found: ${packageRoot}`,
    );
  }

  const npmAvailable = commandIsAvailable(commandRunner, "npm");
  if (!npmAvailable) {
    addMissing("npm", "npm non trovato nel PATH.", "npm is not available in PATH.");
  }

  if (targetPlatform === "win32") {
    if (!commandIsAvailable(commandRunner, "powershell.exe", ["-NoProfile", "-Command", "Get-Command", "sc.exe"])) {
      addMissing(
        "sc",
        "Windows Service Control (`sc.exe`) non disponibile. Windows non e' supportato correttamente.",
        "Windows Service Control (`sc.exe`) is not available. Windows is not fully supported.",
      );
    }
  }

  if (targetPlatform === "linux" && !commandIsAvailable(commandRunner, "systemctl", ["--version"])) {
    addMissing(
      "systemctl",
      "systemd (`systemctl`) non e' disponibile: l'installazione persistente Linux richiede un servizio `systemd --user`.",
      "systemd (`systemctl`) is not available: persistent Linux installs require a `systemd --user` service.",
    );
  }

  if (targetPlatform === "linux" && commandIsAvailable(commandRunner, "systemctl", ["--version"])) {
    // Under sudo, delegate to real user via sudo -u (D-Bus enforces uid match on the socket)
    const sudoUser = process.env.SUDO_USER;
    const checkCmd = sudoUser
      ? `sudo -u "${sudoUser}" env XDG_RUNTIME_DIR=/run/user/$(id -u "${sudoUser}") DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "${sudoUser}")/bus" systemctl --user is-system-running --quiet`
      : "systemctl --user is-system-running --quiet";
    const userBusCheck = runCommand(commandRunner, "bash", ["-c", checkCmd]);
    if (userBusCheck && userBusCheck.status !== 0 && userBusCheck.stderr && userBusCheck.stderr.includes("bus")) {
      addMissing(
        "systemd-user-bus",
        "Il bus systemd --user non e' raggiungibile. Attiva `loginctl enable-linger` per mantenere attivo il manager utente.",
        "The systemd --user bus is not reachable. Enable linger with `loginctl enable-linger` to keep the user manager running.",
      );
    }
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
    const dockerCompose = resolveDockerComposeCommand(commandRunner);
    if (!dockerCompose.dockerAvailable) {
      addMissing("docker", "Docker non trovato nel PATH.", "Docker is not available in PATH.");
    } else if (!dockerCompose.ok) {
      addMissing(
        "docker-compose",
        "Docker Compose non e' disponibile (`docker compose` e `docker-compose` falliscono).",
        "Docker Compose is not available (`docker compose` and `docker-compose` both failed).",
      );
    }
    if (dockerCompose.dockerAvailable && !commandIsAvailable(commandRunner, "docker", ["info"])) {
      addMissing(
        "docker-daemon",
        "Il daemon Docker non e' raggiungibile per l'utente corrente (`docker info` fallisce).",
        "The Docker daemon is not reachable for the current user (`docker info` failed).",
      );
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    requiresDockerRuntime,
    dockerComposeFile,
  };
}

function formatPersistentInstallPrerequisitesFailure(result, options = {}) {
  const locale = normalizeLocale(options.locale);
  const platform = String(options.platform || process.platform);
  const osRelease = options.osRelease || {};
  const header = locale === "en"
    ? "Persistent installation prerequisites are not satisfied. Install/fix the following items and run the command again:"
    : "I prerequisiti per l'installazione persistente non sono soddisfatti. Installa/correggi questi elementi e rilancia il comando:";
  const lines = [header];

  for (const item of result.missing || []) {
    lines.push(`- ${locale === "en" ? item.messageEn : item.messageIt}`);
    const commands = getPrerequisiteFixCommands(item.key, { locale, platform, osRelease });
    for (const command of commands) {
      lines.push(`  ${locale === "en" ? "Command" : "Comando"}: ${command}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatQwenPlanLabel(endpointVariant) {
  const variant = normalizeQwenEndpointVariant(endpointVariant);
  if (variant === "token_plan") return "subscription";
  if (variant === "dashscope") return "payg";
  return "";
}

function formatProviderPlanSuffix(provider, useColor = false) {
  if (String(provider?.provider || "").toLowerCase() !== "qwen") return "";
  const plan = formatQwenPlanLabel(provider?.endpoint_variant);
  return plan ? ` plan=${colorize(plan, "cyan", useColor)}` : "";
}

function formatVisionSuffix(provider, useColor = false) {
  if (provider.vision === true) return ` vision=${colorize("true", "green", useColor)}`;
  if (provider.vision === false) return ` vision=${colorize("false", "red", useColor)}`;
  return "";
}

function formatFreeModelSuffix(provider, useColor = false) {
  if (provider.free_model === true) return ` free=${colorize("true", "green", useColor)}`;
  if (provider.free_model === false) return ` free=${colorize("false", "dim", useColor)}`;
  return "";
}

function parseOptionalBooleanFlag(value, { defaultValue = null, allowBareTrue = false } = {}) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (value === true && allowBareTrue) return true;
  if (value === false) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (allowBareTrue && normalized === "true") return true;
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  return null;
}

function getProviderKind(provider) {
  return String(provider?.provider || "copilot").toLowerCase();
}

function resolveEffectiveProviderList(providers, configuredModel) {
  const baseProviders = Array.isArray(providers) ? providers.map((provider) => ({ ...provider })) : [];
  const preferences = parseProviderModelPreferences(configuredModel);
  if (!configuredModel || preferences.length === 0) {
    return {
      providers: baseProviders,
      configuredModel: "",
      projectOverrideActive: false,
    };
  }

  return {
    providers: baseProviders,
    configuredModel: String(configuredModel || "").trim(),
    projectOverrideActive: true,
  };
}

function formatProviderList(providers, options = {}) {
  const useColor = shouldUseColorOutput(options.stdout, options.env);
  const env = options.env || process.env;
  const creditInline = String(env?.LLMPROXY_PROVIDER_CREDIT_INLINE || "").trim() === "1";
  return providers.map((provider, index) => {
    const defaultModel = provider.effective_model || provider.default_model || (provider.provider === "copilot" ? DEFAULT_COPILOT_MODEL : "");
    const linePrefix = colorize(`${index + 1}.`, "dim", useColor);
    const providerId = colorize(provider.id, "cyan", useColor);
    const providerName = colorize(provider.name, "bright", useColor);
    const modelValue = defaultModel
      ? colorize(defaultModel, "yellow", useColor)
      : colorize("missing", "red", useColor);
    const codingValue = colorize(provider.coding_info?.label || "n/a", provider.coding_info?.color || "dim", useColor);
    const creditValue = colorize(provider.credit_info?.label || "n/a", provider.credit_info?.color || "dim", useColor);
    const currentPrice = colorize(provider.price_info?.currentPriceLabel || "n/a", provider.price_info?.currentPriceColor || "dim", useColor);
    const bestProvider = colorize(provider.price_info?.bestProviderLabel || "n/a", provider.price_info?.bestProviderColor || "dim", useColor);
    const bestPrice = colorize(provider.price_info?.bestPriceLabel || "n/a", provider.price_info?.bestPriceColor || "dim", useColor);

    let inlineCredit = "";

    if (creditInline) {
      inlineCredit = ` [${creditValue}]`;
    }

    const details = [
      `   model=${modelValue} coding=${codingValue}${formatVisionSuffix(provider, useColor)}${formatFreeModelSuffix(provider, useColor)}${formatProviderPlanSuffix(provider, useColor)}`,
      `   credit=${creditValue}`,
      `   price=${currentPrice}`,
      `   best=${bestProvider} (${bestPrice})`,
    ];

    return `${linePrefix} ${providerId} (${providerName})${inlineCredit}\n${details.join("\n")}`;
  }).join("\n\n");
}

function shouldUseColorOutput(stream = process.stdout, env = process.env) {
  if (String(env?.NO_COLOR || "").trim()) return false;
  if (String(env?.FORCE_COLOR || "").trim()) return true;
  return Boolean(stream && stream.isTTY);
}

function colorize(text, style, enabled) {
  if (!enabled) return String(text);
  const STYLES = {
    dim: "\x1b[2m",
    bright: "\x1b[1m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
  };
  const prefix = STYLES[style];
  if (!prefix) return String(text);
  return `${prefix}${text}\x1b[0m`;
}

function formatProviderCreditSuffix(creditInfo, useColor = false) {
  const label = String(creditInfo?.label || "n/a").trim() || "n/a";
  const color = label === "n/a"
    ? "dim"
    : label === "unavailable"
      ? "red"
      : label.includes("-")
        ? "red"
        : "blue";
  return ` credit=${colorize(label, color, useColor)}`;
}

function formatProviderPriceSuffix(priceInfo, useColor = false) {
  const currentPrice = String(priceInfo?.currentPriceLabel || "n/a").trim() || "n/a";
  const bestProvider = String(priceInfo?.bestProviderLabel || "n/a").trim() || "n/a";
  const bestPrice = String(priceInfo?.bestPriceLabel || "n/a").trim() || "n/a";
  const currentColor = currentPrice === "n/a" || currentPrice === "unavailable" ? "dim" : "magenta";
  const bestProviderColor = bestProvider === "n/a" || bestProvider === "unavailable" ? "dim" : "green";
  const bestPriceColor = bestPrice === "n/a" || bestPrice === "unavailable" ? "dim" : "green";
  return ` price=${colorize(currentPrice, currentColor, useColor)} best=${colorize(bestProvider, bestProviderColor, useColor)} (${colorize(bestPrice, bestPriceColor, useColor)})`;
}

function formatCodingScoreLabel(value) {
  if (value == null || value === "") return "n/a";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return numeric.toFixed(1);
}

function colorForCodingScore(label) {
  if (label === "n/a") return "dim";
  if (label === "unavailable") return "red";
  const numeric = Number(label);
  if (!Number.isFinite(numeric)) return "dim";
  if (numeric >= 0.8 || numeric >= 80) return "green";
  if (numeric >= 0.6 || numeric >= 60) return "yellow";
  return "red";
}

function normalizeModelLookupCandidates(model) {
  const raw = String(model || "").trim();
  if (!raw) return [];
  const withoutDate = raw.replace(/-\d{8}$/i, "");
  const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
  const leafWithoutDate = leaf.replace(/-\d{8}$/i, "");
  return Array.from(new Set([raw, withoutDate, leaf, leafWithoutDate]
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean)));
}

function extractBenchmarkCodingScore(payload) {
  const sources = Array.isArray(payload?.data?.sources) ? payload.data.sources : [];
  for (const source of sources) {
    const scores = Array.isArray(source?.scores) ? source.scores : [];
    const codingScore = scores.find((entry) => String(entry?.metric || "").trim().toLowerCase() === "coding_index");
    const numeric = Number(codingScore?.value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

async function fetchProviderCodingInfo(provider, fetchFn, cache = new Map()) {
  const model = String(provider?.effective_model || provider?.default_model || "").trim();
  const candidates = normalizeCloudPriceModelCandidates(model);
  if (candidates.length === 0) return { label: "n/a", color: "dim" };

  const cacheKey = candidates.join("|").toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    for (const candidate of candidates) {
      try {
        const response = await fetchFn(`https://ai.cloudprice.net/api/v1/models/${encodeURIComponent(candidate)}/benchmarks`, {
          method: "GET",
          headers: { "content-type": "application/json" },
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(7000) : undefined,
        });
        if (!response?.ok) continue;
        const payload = await readJsonResponseSafe(response);
        const score = extractBenchmarkCodingScore(payload);
        if (score != null) {
          const label = formatCodingScoreLabel(score);
          return { label, color: colorForCodingScore(label) };
        }
      } catch {
        // try next candidate
      }
    }
    return { label: "n/a", color: "dim" };
  })();

  cache.set(cacheKey, promise);
  return promise;
}

function formatCreditAmount(amount, currency = "") {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "";
  const formatted = numeric.toFixed(2);
  const normalizedCurrency = String(currency || "").trim().toUpperCase();
  return normalizedCurrency ? `${normalizedCurrency} ${formatted}` : formatted;
}

async function readJsonResponseSafe(response) {
  if (!response || typeof response.json !== "function") return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchProviderCreditInfo(provider, fetchFn, cache = new Map()) {
  const providerKind = String(provider?.provider || provider?.id || "").trim().toLowerCase();
  const accessToken = String(provider?.access_token || "").trim();
  const endpointVariant = String(provider?.endpoint_variant || "").trim().toLowerCase();
  if (!providerKind || !accessToken) return { label: "n/a", color: "dim" };

  const cacheKey = crypto
    .createHash("sha1")
    .update(`${providerKind}|${endpointVariant}|${accessToken}`)
    .digest("hex");

  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const unsupported = { label: "n/a", color: "dim" };
    const unavailable = { label: "unavailable", color: "red" };
    const request = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(5000) : undefined,
    };

    try {
      if (providerKind === "deepseek") {
        const response = await fetchFn("https://api.deepseek.com/user/balance", request);
        if (!response?.ok) return unavailable;
        const payload = await readJsonResponseSafe(response);
        const balances = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
        const preferred = balances.find((entry) => String(entry?.currency || "").trim().toUpperCase() === "USD") || balances[0];
        const label = formatCreditAmount(preferred?.total_balance, preferred?.currency);
        return label ? { label, color: "blue" } : unavailable;
      }

      if (providerKind === "kimi") {
        const response = await fetchFn("https://api.moonshot.ai/v1/users/me/balance", request);
        if (!response?.ok) return unavailable;
        const payload = await readJsonResponseSafe(response);
        const label = formatCreditAmount(payload?.data?.available_balance);
        return label ? { label, color: "blue" } : unavailable;
      }

      if (providerKind === "openrouter") {
        const response = await fetchFn("https://openrouter.ai/api/v1/credits", request);
        if (!response?.ok) return unavailable;
        const payload = await readJsonResponseSafe(response);
        const totalCredits = Number(payload?.data?.total_credits);
        const totalUsage = Number(payload?.data?.total_usage);
        if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return unavailable;
        const remainingCredits = Math.max(0, totalCredits - totalUsage);
        return { label: `${remainingCredits.toFixed(2)} credits`, color: "blue" };
      }

      return unsupported;
    } catch {
      return unavailable;
    }
  })();

  cache.set(cacheKey, promise);
  return promise;
}

function normalizeCloudPriceModelCandidates(model) {
  const raw = String(model || "").trim();
  if (!raw) return [];
  const withoutDate = raw.replace(/-\d{8}$/i, "");
  const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
  const leafWithoutDate = leaf.replace(/-\d{8}$/i, "");
  return Array.from(new Set([raw, withoutDate, leaf, leafWithoutDate].filter(Boolean)));
}

function mapProviderToCloudPriceIds(provider) {
  const providerKind = String(provider?.provider || provider?.id || "").trim().toLowerCase();
  if (!providerKind) return [];
  const mappings = {
    deepseek: ["deepseek"],
    openrouter: ["openrouter"],
    qwen: ["alibaba_qwen", "qwen"],
    kimi: ["moonshot", "moonshot_ai", "moonshotai", "kimi"],
    fireworks: ["fireworks", "fireworks_ai"],
    opencode: ["opencode", "opencode_zen", "opencode-go", "opencode_go"],
  };
  return mappings[providerKind] || [providerKind];
}

function mapCloudPriceProviderLabel(providerId) {
  const normalized = String(providerId || "").trim().toLowerCase();
  const mappings = {
    alibaba_qwen: "qwen",
    fireworks_ai: "fireworks",
    moonshot_ai: "kimi",
    moonshotai: "kimi",
    vercel_ai_gateway: "vercel_ai_gateway",
    azure_aifoundry: "azure_aifoundry",
  };
  return mappings[normalized] || normalized;
}

function formatCloudPriceBreakdownLabel(entry) {
  const breakdown = Array.isArray(entry?.breakdown) ? entry.breakdown : [];
  const input = breakdown.find((item) => String(item?.dimension || "").trim().toLowerCase() === "input");
  const output = breakdown.find((item) => String(item?.dimension || "").trim().toLowerCase() === "output");
  const inputPrice = Number(input?.unit_price);
  const outputPrice = Number(output?.unit_price);
  if (!Number.isFinite(inputPrice) && !Number.isFinite(outputPrice)) return "n/a";
  const parts = [];
  if (Number.isFinite(inputPrice)) parts.push(`in=USD ${inputPrice.toFixed(2)}/1M`);
  if (Number.isFinite(outputPrice)) parts.push(`out=USD ${outputPrice.toFixed(2)}/1M`);
  return parts.join(" ");
}

function pickCloudPriceCurrentOption(options, provider) {
  const providerIds = new Set(mapProviderToCloudPriceIds(provider));
  const matches = (Array.isArray(options) ? options : []).filter((option) => {
    const optionProviderId = String(option?.provider_id || "").trim().toLowerCase();
    return providerIds.has(optionProviderId) && String(option?.tier || "standard").trim().toLowerCase() === "standard";
  });
  if (matches.length === 0) return null;
  matches.sort((left, right) => Number(left?.total_cost || Infinity) - Number(right?.total_cost || Infinity));
  return matches[0];
}

function pickCloudPriceBestProvider(resultProviders, provider) {
  const candidates = Array.isArray(resultProviders) ? resultProviders : [];
  if (candidates.length === 0) return null;
  const currentIds = new Set(mapProviderToCloudPriceIds(provider));
  const llmProxySupported = new Set(AVAILABLE_PROVIDER_SPECS.map((entry) => entry.id));
  const preferredAlternative = candidates.find((candidate) => {
    const mapped = mapCloudPriceProviderLabel(candidate?.provider_id);
    return mapped && !currentIds.has(String(candidate?.provider_id || "").trim().toLowerCase()) && llmProxySupported.has(mapped);
  });
  if (preferredAlternative) return preferredAlternative;
  const nonCurrent = candidates.find((candidate) => !currentIds.has(String(candidate?.provider_id || "").trim().toLowerCase()));
  if (nonCurrent) return nonCurrent;
  return candidates[0];
}

async function fetchCloudPriceModelPricing(model, fetchFn, cache = new Map()) {
  const candidates = normalizeCloudPriceModelCandidates(model);
  if (candidates.length === 0) return null;
  const cacheKey = candidates.join("|").toLowerCase();
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const query = "?tier=standard&input_tokens=1000000&output_tokens=1000000";
    for (const candidate of candidates) {
      try {
        const response = await fetchFn(`https://ai.cloudprice.net/api/v1/models/${encodeURIComponent(candidate)}/pricing/calculate${query}`, {
          method: "GET",
          headers: { "content-type": "application/json" },
          signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(7000) : undefined,
        });
        if (!response?.ok) continue;
        const payload = await readJsonResponseSafe(response);
        if (payload?.data?.result || Array.isArray(payload?.data?.options)) return payload.data;
      } catch {
        // try next candidate
      }
    }
    return null;
  })();

  cache.set(cacheKey, promise);
  return promise;
}

async function fetchProviderPriceInfo(provider, fetchFn, cache = new Map()) {
  const model = String(provider?.effective_model || provider?.default_model || "").trim();
  if (!model) {
    return {
      currentPriceLabel: "n/a",
      currentPriceColor: "dim",
      bestProviderLabel: "n/a",
      bestProviderColor: "dim",
      bestPriceLabel: "n/a",
      bestPriceColor: "dim",
    };
  }
  const data = await fetchCloudPriceModelPricing(model, fetchFn, cache);
  if (!data) {
    return {
      currentPriceLabel: "unavailable",
      currentPriceColor: "dim",
      bestProviderLabel: "unavailable",
      bestProviderColor: "dim",
      bestPriceLabel: "unavailable",
      bestPriceColor: "dim",
    };
  }

  const currentOption = pickCloudPriceCurrentOption(data.options, provider);
  const bestProvider = pickCloudPriceBestProvider(data?.result?.providers, provider);
  const currentPriceLabel = currentOption ? formatCloudPriceBreakdownLabel(currentOption) : "n/a";
  const bestProviderLabel = bestProvider ? mapCloudPriceProviderLabel(bestProvider.provider_id) : "n/a";
  const bestPriceLabel = data?.result ? formatCloudPriceBreakdownLabel(data.result) : "n/a";
  return {
    currentPriceLabel,
    currentPriceColor: currentPriceLabel === "n/a" || currentPriceLabel === "unavailable" ? "dim" : "magenta",
    bestProviderLabel,
    bestProviderColor: bestProviderLabel === "n/a" || bestProviderLabel === "unavailable" ? "dim" : "green",
    bestPriceLabel,
    bestPriceColor: bestPriceLabel === "n/a" || bestPriceLabel === "unavailable" ? "dim" : "green",
  };
}

function formatProviderStatus(providers) {
  const activeProviderId = providers[0]?.id || "none";
  const lines = [`Active provider: ${activeProviderId}`];
  providers.forEach((provider, index) => {
    const activeSuffix = index === 0 ? " [active]" : "";
    const defaultModel = provider.effective_model || provider.default_model || (provider.provider === "copilot" ? DEFAULT_COPILOT_MODEL : "");
    const state = provider.access_token && (provider.provider === "copilot" || defaultModel) ? "configured" : "incomplete";
    const modelSuffix = defaultModel ? ` model=${defaultModel}` : " model=missing";
    lines.push(`${index + 1}. ${provider.id} (${provider.name})${activeSuffix} provider=${provider.provider || "copilot"} auth=${provider.auth_type || "oauth"} state=${state}${modelSuffix}${formatVisionSuffix(provider)}${formatProviderPlanSuffix(provider)}`);
  });
  return lines.join("\n");
}

function formatConfigEntries(entries) {
  return entries
    .map((entry) => `${entry.scope}.${entry.key}=${entry.value == null ? "" : String(entry.value)}`)
    .join("\n");
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

function resolveDbLayerUrlForEnv(env = {}) {
  const explicit = String(env.DBLAYER_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const profile = resolveRuntimeProfile({ env });
  if (profile === "staging") return "http://localhost:6001";
  if (profile === "production") return "http://localhost:7001";
  return "http://localhost:5001";
}

function resolveEventBusUrlForEnv(env = {}) {
  const explicit = String(env.EVENTBUS_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const profile = resolveRuntimeProfile({ env });
  if (profile === "staging") return "http://localhost:6048";
  if (profile === "production") return "http://localhost:7048";
  return "http://localhost:5048";
}

async function loadMeteringStats({ env, paths, fetchFn }) {
  const fallbackSink = createJsonlMeteringSink({ filePath: paths.meteringFile });
  const mode = String(env.LLMPROXY_MODE || "standalone").trim().toLowerCase();
  const mongoConnectionString = String(env.LLMPROXY_MONGODB_CONNECTION_STRING || "").trim();

  if (mode === "platform") {
    try {
      const stats = await fetchDbLayerStats(fetchFn, resolveDbLayerUrlForEnv(env));
      return { stats, source: "dblayer" };
    } catch {
      return { stats: await Promise.resolve(fallbackSink.computeStats({})), source: "local-fallback" };
    }
  }

  if (mongoConnectionString) {
    const { createMongoMeteringSink } = require("./metering-db");
    const sink = createMongoMeteringSink({
      uri: mongoConnectionString,
      collectionName: "llmproxy_metering",
    });
    try {
      const stats = await Promise.resolve(sink.computeStats({}));
      return { stats, source: "mongodb" };
    } finally {
      await Promise.resolve(sink.close()).catch(() => {});
    }
  }

  return { stats: await Promise.resolve(fallbackSink.computeStats({})), source: "jsonl" };
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

const LLM_STATS_API_KEY_REQUIRED_MESSAGE = [
  "LLMPROXY_LLM_STATS_API_KEY is mandatory for llmProxy Claude Code inference.",
  "",
  "Get a free API key from https://llm-stats.com/developer",
  "Then set it in .claude/settings.json under env.LLMPROXY_LLM_STATS_API_KEY and retry.",
  "",
  "Example:",
  "{",
  '  "env": {',
  '    "LLMPROXY_LLM_STATS_API_KEY": "your-free-key"',
  "  }",
  "}",
].join("\n");

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
    "# Preserve the caller's current global npm bin before any nvm switch",
    'original_npm_prefix=$(npm prefix -g 2>/dev/null || true)',
    'original_global_bin_path=""',
    'original_global_short_bin_path=""',
    'if [ -n "$original_npm_prefix" ]; then',
    '  original_global_bin_path="$original_npm_prefix/bin/llmproxy"',
    '  original_global_short_bin_path="$original_npm_prefix/bin/llmp"',
    'fi',
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
    "existing_bins=$( (which -a llmproxy 2>/dev/null; which -a llmp 2>/dev/null) | awk '!seen[$0]++')",
    "current_bin=$(command -v llmproxy 2>/dev/null || true)",
    "current_short_bin=$(command -v llmp 2>/dev/null || true)",
    'current_version=$(llmproxy version 2>/dev/null || true)',
    'original_npm_root=$(npm root -g 2>/dev/null || true)',
    'current_bin_prefix=""',
    'if [ -n "$current_bin" ]; then',
    '  current_bin_dir=$(dirname "$current_bin")',
    '  current_bin_prefix=$(cd "$current_bin_dir/.." 2>/dev/null && pwd || true)',
    'fi',
    "used_sudo=0",
    'rollback_manifest="$tmpdir/rollback-manifest.txt"',
    'touch "$rollback_manifest"',
    'rollback_primary_dir=""',
    'backup_install_dir() {',
    '  src="$1"',
    '  [ -d "$src" ] || return 0',
    '  archive="$tmpdir/rollback-$(wc -l < "$rollback_manifest" | tr -d " ")-$(basename "$src").tar"',
    '  tar -cf "$archive" -C "$(dirname "$src")" "$(basename "$src")"',
    '  printf "%s|%s\\n" "$src" "$archive" >> "$rollback_manifest"',
    '  if [ -z "$rollback_primary_dir" ]; then',
    '    rollback_primary_dir="$src"',
    '  fi',
    '}',
    'restore_backups() {',
    '  if [ ! -s "$rollback_manifest" ]; then',
    '    return 1',
    '  fi',
    '  while IFS="|" read -r target archive; do',
    '    [ -n "$target" ] || continue',
    '    parent_dir=$(dirname "$target")',
    '    rm -rf "$target" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo rm -rf "$target" >/dev/null 2>&1 || return 1; else return 1; fi; }',
    '    mkdir -p "$parent_dir" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo mkdir -p "$parent_dir" >/dev/null 2>&1 || return 1; else return 1; fi; }',
    '    tar -xf "$archive" -C "$parent_dir" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo tar -xf "$archive" -C "$parent_dir" >/dev/null 2>&1 || return 1; else return 1; fi; }',
    '  done < "$rollback_manifest"',
    '  return 0',
    '}',
    'rollback_and_exit() {',
    '  rollback_reason="$1"',
    '  restored_version="$current_version"',
    '  if restore_backups; then',
    '    if [ -n "$rollback_primary_dir" ] && [ -f "$rollback_primary_dir/bin/llmproxy.js" ]; then',
    '      package_cli="$rollback_primary_dir/bin/llmproxy.js"',
    '      new_bin="$package_cli"',
    '      new_bin_mode="node"',
    '      if type ensure_wrapper_path >/dev/null 2>&1; then',
    '        ensure_wrapper_path "${global_bin_path:-}" >/dev/null 2>&1 || true',
    '        for preserved_bin in ${preserved_bin_paths:-}; do',
    '          ensure_wrapper_path "$preserved_bin" >/dev/null 2>&1 || true',
    '        done',
    '      fi',
    '      if [ "$used_sudo" -eq 1 ] && [ "$(uname -s)" = "Linux" ] && [ -n "${SUDO_USER:-}" ] && command -v sudo >/dev/null 2>&1; then',
    '        sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SUDO_USER")/bus" node "$package_cli" service:restart >/dev/null 2>&1 || true',
    '      else',
    '        node "$package_cli" service:restart >/dev/null 2>&1 || true',
    '      fi',
    '      restored_version=$(node "$package_cli" version 2>/dev/null || printf "%s" "$current_version")',
    '    fi',
    '  fi',
    '  printf "__LLMPROXY_ROLLBACK__=1\\n"',
    '  printf "__LLMPROXY_ROLLBACK_VERSION__=%s\\n" "$restored_version"',
    '  printf "__LLMPROXY_ROLLBACK_REASON__=%s\\n" "$rollback_reason"',
    '  exit 0',
    '}',
    'backup_install_dir "${original_npm_root:+$original_npm_root/llmproxy}"',
    'backup_install_dir "${current_bin_prefix:+$current_bin_prefix/lib/node_modules/llmproxy}"',
    'cleanup_global_service_port() {',
    '  service_port="${1:-7045}"',
    '  [ -n "$service_port" ] || return 0',
    '  if command -v docker >/dev/null 2>&1; then',
    '    docker_ids=$(docker ps --format \'{{.ID}} {{.Ports}}\' 2>/dev/null | awk -v port="$service_port" \'index($0, ":" port "->") > 0 { print $1 }\')',
    '    if [ -n "$docker_ids" ]; then',
    '      for docker_id in $docker_ids; do',
    '        docker stop "$docker_id" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo docker stop "$docker_id" >/dev/null 2>&1 || true; else true; fi; }',
    '        docker rm "$docker_id" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo docker rm "$docker_id" >/dev/null 2>&1 || true; else true; fi; }',
    '      done',
    '    fi',
    '  fi',
    '  if command -v lsof >/dev/null 2>&1; then',
    '    listener_pids=$(lsof -tiTCP:"$service_port" -sTCP:LISTEN 2>/dev/null || true)',
    '    if [ -n "$listener_pids" ]; then',
    '      for listener_pid in $listener_pids; do',
    '        kill "$listener_pid" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo kill "$listener_pid" >/dev/null 2>&1 || true; else true; fi; }',
    '      done',
    '      sleep 1',
    '      listener_pids=$(lsof -tiTCP:"$service_port" -sTCP:LISTEN 2>/dev/null || true)',
    '      if [ -n "$listener_pids" ]; then',
    '        for listener_pid in $listener_pids; do',
    '          kill -9 "$listener_pid" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo kill -9 "$listener_pid" >/dev/null 2>&1 || true; else true; fi; }',
    '        done',
    '      fi',
    '    fi',
    '  fi',
    '}',
    `git clone --depth=1 https://github.com/${repo}.git \"$tmpdir/repo\" >/dev/null 2>&1`,
    'cd "$tmpdir/repo"',
    'target_version=$(node -p "require(\'./package.json\').version")',
    "commit_message_base64=$(git log -1 --pretty=%B | base64 | tr -d '\\n')",
    "",
    "# Try pnpm pack first, fall back to npm pack",
    'if command -v pnpm >/dev/null 2>&1 && pnpm pack --pack-destination "$tmpdir" >/dev/null 2>&1; then',
    '  package_file=$(find "$tmpdir" -maxdepth 1 -name "*.tgz" -print | head -n 1)',
    'else',
    '  npm pack --pack-destination "$tmpdir" >/dev/null 2>&1',
    '  package_file=$(find "$tmpdir" -maxdepth 1 -name "*.tgz" -print | head -n 1)',
    'fi',
    '[ -n "$package_file" ]',
    "",
    '# Check npm prefix: if user-local, force system-wide install via sudo for multi-user server',
    'npm_prefix_global=$(npm prefix -g 2>/dev/null || echo "/usr/local")',
    'case "$npm_prefix_global" in',
    '  "$HOME"/*)',
    '    if command -v sudo >/dev/null 2>&1; then',
    '      if sudo npm install -g --force "$package_file" 2>/dev/null; then',
    '        used_sudo=1',
    '      else',
    '        echo "Warning: could not install system-wide. Falling back to user-local." >&2',
    '        if ! npm install -g --force "$package_file" 2>/dev/null; then',
    '          rollback_and_exit "npm install failed while applying $target_version"',
    '        fi',
    '      fi',
    '    else',
    '      if ! npm install -g --force "$package_file" 2>/dev/null; then',
    '        rollback_and_exit "npm install failed while applying $target_version"',
    '      fi',
    '    fi',
    '    ;;',
    '  *)',
    '    if ! npm install -g --force "$package_file" 2>/dev/null; then',
    '      echo "Standard npm install failed, trying with sudo..."',
    '      if command -v sudo >/dev/null 2>&1; then',
    '        if sudo npm install -g --force "$package_file" 2>/dev/null; then',
    '          used_sudo=1',
    '        else',
    '          rollback_and_exit "npm install failed while applying $target_version"',
    '        fi',
    '      else',
    '        rollback_and_exit "npm install failed while applying $target_version"',
    '      fi',
    '    fi',
    '    ;;',
    'esac',
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
    'install_dir="$npm_prefix/lib/node_modules/llmproxy"',
    'package_cli="$install_dir/bin/llmproxy.js"',
    'global_bin_path="$npm_prefix/bin/llmproxy"',
    'global_short_bin_path="$npm_prefix/bin/llmp"',
    'new_bin_mode="bin"',
    'run_new_llmproxy() {',
    '  if [ "$new_bin_mode" = "node" ] && [ -f "$new_bin" ]; then',
    '    node "$new_bin" "$@"',
    '  elif [ -x "$new_bin" ]; then',
    '    "$new_bin" "$@"',
    '  elif [ -f "$package_cli" ]; then',
    '    node "$package_cli" "$@"',
    '  else',
    '    return 127',
    '  fi',
    '}',
    'build_wrapper_payload() {',
    '  if [ "$new_bin_mode" = "node" ] && [ -f "$package_cli" ]; then',
    '    printf \'%s\\n\' \'#!/bin/sh\' "exec node \\"$package_cli\\" \\"\\$@\\""',
    '    return 0',
    '  fi',
    '  if [ -n "$new_bin" ] && [ -e "$new_bin" ]; then',
    '    printf \'%s\\n\' \'#!/bin/sh\' "exec \\"$new_bin\\" \\"\\$@\\""',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    'ensure_wrapper_path() {',
    '  target_path="$1"',
    '  if [ -z "$target_path" ] || [ "$target_path" = "$new_bin" ]; then',
    '    return 0',
    '  fi',
    '  target_dir=$(dirname "$target_path")',
    '  if [ ! -d "$target_dir" ]; then',
    '    return 0',
    '  fi',
    '  wrapper_payload=$(build_wrapper_payload) || return 1',
    '  if [ -w "$target_dir" ]; then',
    '    rm -f "$target_path" >/dev/null 2>&1 || true',
    '    printf "%s\\n" "$wrapper_payload" > "$target_path"',
    '    chmod +x "$target_path"',
    '    return 0',
    '  fi',
    '  if command -v sudo >/dev/null 2>&1; then',
    '    sudo rm -f "$target_path" >/dev/null 2>&1 || true',
    '    printf "%s\\n" "$wrapper_payload" | sudo tee "$target_path" >/dev/null',
    '    sudo chmod +x "$target_path"',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    'ensure_global_bin() {',
    '  if [ -x "$global_bin_path" ]; then',
    '    return 0',
    '  fi',
    '  ensure_wrapper_path "$global_bin_path"',
    '}',
    'ensure_global_short_bin() {',
    '  if [ -x "$global_short_bin_path" ]; then',
    '    return 0',
    '  fi',
    '  ensure_wrapper_path "$global_short_bin_path"',
    '}',
    "",
    "# System-wide install: make installed package world-readable (keep root ownership)",
    'if [ "$used_sudo" -eq 1 ]; then',
    '  if [ -d "$install_dir" ]; then',
    '    sudo chmod -R a+rX "$install_dir" 2>/dev/null || echo "Warning: could not make $install_dir world-readable. Non-root users may not be able to use llmproxy." >&2',
    '  fi',
    'fi',
    "",
    "# Find the newly installed binary",
    "resolved_bins=$( (which -a llmproxy 2>/dev/null; which -a llmp 2>/dev/null) | awk '!seen[$0]++')",
    'new_bin=""',
    'version_output=""',
    'if [ -f "$package_cli" ]; then',
    '  package_cli_version=$(node "$package_cli" version 2>/dev/null || true)',
    '  if [ "$package_cli_version" = "$target_version" ]; then',
    '    new_bin="$package_cli"',
    '    new_bin_mode="node"',
    '    version_output="$package_cli_version"',
    '  fi',
    'fi',
    'if [ "$version_output" != "$target_version" ] && [ -x "$global_bin_path" ]; then',
    '  global_bin_version=$("$global_bin_path" version 2>/dev/null || true)',
    '  if [ "$global_bin_version" = "$target_version" ]; then',
    '    new_bin="$global_bin_path"',
    '    new_bin_mode="bin"',
    '    version_output="$global_bin_version"',
    '  fi',
    'fi',
    'if [ "$version_output" != "$target_version" ]; then',
    '  for candidate_bin in $resolved_bins; do',
    '    if [ -x "$candidate_bin" ]; then',
    '      candidate_version=$("$candidate_bin" version 2>/dev/null || true)',
    '      if [ "$candidate_version" = "$target_version" ]; then',
    '        new_bin="$candidate_bin"',
    '        new_bin_mode="bin"',
    '        version_output="$candidate_version"',
    '        break',
    '      fi',
    '    fi',
    '  done',
    'fi',
    'if [ "$version_output" != "$target_version" ]; then',
    '  rollback_and_exit "installed binary verification failed for $target_version"',
    'fi',
    'ensure_global_bin >/dev/null 2>&1 || true',
    'ensure_global_short_bin >/dev/null 2>&1 || true',
    'preserved_bin_paths=$(printf "%s\\n" "$current_bin" "$current_short_bin" "$global_bin_path" "$global_short_bin_path" "$original_global_bin_path" "$original_global_short_bin_path" "/usr/bin/llmproxy" "/usr/local/bin/llmproxy" "/usr/bin/llmp" "/usr/local/bin/llmp" $existing_bins | awk \'NF && !seen[$0]++\')',
    'for preserved_bin in $preserved_bin_paths; do',
    '  ensure_wrapper_path "$preserved_bin" >/dev/null 2>&1 || true',
    'done',
    'is_preserved_bin_path() {',
    '  candidate_path="$1"',
    '  for preserved_bin in $preserved_bin_paths; do',
    '    if [ "$preserved_bin" = "$candidate_path" ]; then',
    '      return 0',
    '    fi',
    '  done',
    '  return 1',
    '}',
    "",
    "# Remove old duplicate binaries",
    'for installed_bin in $resolved_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$new_bin" ] && ! is_preserved_bin_path "$installed_bin"; then',
    '    rm -f "$installed_bin" >/dev/null 2>&1 || { if [ "$used_sudo" -eq 1 ]; then sudo rm -f "$installed_bin" >/dev/null 2>&1 || true; else true; fi; }',
    '  fi',
    'done',
    "",
    "# Update current bin if it points to an old location",
    'if [ -n "$current_bin" ] && [ "$current_bin" != "$new_bin" ] && [ "$current_bin" != "$global_bin_path" ]; then',
    '  current_bin_dir=$(dirname "$current_bin")',
    '  if [ "$new_bin_mode" = "node" ]; then',
    '    current_wrapper_payload=$(printf \'%s\\n\' \'#!/bin/sh\' "exec node \\"$new_bin\\" \\"\\$@\\"" )',
    '  else',
    '    current_wrapper_payload=$(printf \'%s\\n\' \'#!/bin/sh\' "exec \\"$new_bin\\" \\"\\$@\\"" )',
    '  fi',
    '  if [ -w "$current_bin_dir" ]; then',
    '    rm -f "$current_bin" >/dev/null 2>&1 || true',
    '    printf "%s\\n" "$current_wrapper_payload" > "$current_bin"',
    '    chmod +x "$current_bin"',
    '  elif command -v sudo >/dev/null 2>&1; then',
    '    sudo rm -f "$current_bin" >/dev/null 2>&1 || true',
    '    printf "%s\\n" "$current_wrapper_payload" | sudo tee "$current_bin" >/dev/null',
    '    sudo chmod +x "$current_bin"',
    '  fi',
    'fi',
    'if [ -n "$current_short_bin" ] && [ "$current_short_bin" != "$new_bin" ] && [ "$current_short_bin" != "$global_short_bin_path" ]; then',
    '  current_short_bin_dir=$(dirname "$current_short_bin")',
    '  if [ "$new_bin_mode" = "node" ]; then',
    '    current_short_wrapper_payload=$(printf \'%s\\n\' \'#!/bin/sh\' "exec node \\"$new_bin\\" \\"\\$@\\"" )',
    '  else',
    '    current_short_wrapper_payload=$(printf \'%s\\n\' \'#!/bin/sh\' "exec \\"$new_bin\\" \\"\\$@\\"" )',
    '  fi',
    '  if [ -w "$current_short_bin_dir" ]; then',
    '    rm -f "$current_short_bin" >/dev/null 2>&1 || true',
    '    printf "%s\\n" "$current_short_wrapper_payload" > "$current_short_bin"',
    '    chmod +x "$current_short_bin"',
    '  elif command -v sudo >/dev/null 2>&1; then',
    '    sudo rm -f "$current_short_bin" >/dev/null 2>&1 || true',
    '    printf "%s\\n" "$current_short_wrapper_payload" | sudo tee "$current_short_bin" >/dev/null',
    '    sudo chmod +x "$current_short_bin"',
    '  fi',
    'fi',
    "",
    "# Ensure systemd --user bus is available before restarting",
    'if [ "$(uname -s)" = "Linux" ] && [ -z "${XDG_RUNTIME_DIR:-}" ]; then',
    '  uid=$(id -u)',
    '  export XDG_RUNTIME_DIR="/run/user/$uid"',
    'fi',
    'if [ "$(uname -s)" = "Linux" ] && [ -d "$XDG_RUNTIME_DIR" ]; then',
    '  bus_socket="$XDG_RUNTIME_DIR/bus"',
    '  if [ ! -S "$bus_socket" ] && command -v systemctl >/dev/null 2>&1; then',
    '    systemctl --user start dbus 2>/dev/null || true',
    '    waited=0',
    '    while [ ! -S "$bus_socket" ] && [ "$waited" -lt 5 ]; do',
    '      sleep 1',
    '      waited=$((waited + 1))',
    '    done',
    '  fi',
    'fi',
    "",
    'cleanup_global_service_port "${PORT:-7045}"',
    "",
    "# Migrate legacy managed config variables to the current schema",
    'run_new_llmproxy config:migrate >/dev/null 2>&1 || true',
    "",
    "# Restart service — use sudo -u when npm install used sudo (systemd --user needs real user session bus)",
    'if [ "$used_sudo" -eq 1 ] && [ "$(uname -s)" = "Linux" ] && [ -n "${SUDO_USER:-}" ] && command -v sudo >/dev/null 2>&1; then',
    '  if [ "$new_bin_mode" = "node" ]; then',
    '    service_restart_output=$(sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SUDO_USER")/bus" node "$new_bin" service:restart 2>&1 >/dev/null) || service_restart_status=$?',
    '  else',
    '    service_restart_output=$(sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SUDO_USER")/bus" "$new_bin" service:restart 2>&1 >/dev/null) || service_restart_status=$?',
    '  fi',
    'else',
    '  service_restart_output=$(run_new_llmproxy service:restart 2>&1 >/dev/null) || service_restart_status=$?',
    'fi',
    "",
    "# Update Docker container if running",
    'docker_compose_file="$npm_prefix/lib/node_modules/llmproxy/docker-compose.production.yml"',
    'if [ -z "$LLMPROXY_HOME" ]; then',
    '  if [ "$(uname -s)" = "Darwin" ]; then',
    '    export LLMPROXY_HOME="$HOME/Library/Application Support/llmProxy"',
    '  else',
    '    export LLMPROXY_HOME="$HOME/.local/share/llmProxy"',
    '  fi',
    'fi',
    'if [ -z "$LLMPROXY_HOST_PROJECTS_ROOT" ]; then',
    '  if [ "$(uname -s)" = "Darwin" ]; then',
    '    export LLMPROXY_HOST_PROJECTS_ROOT="/Users"',
    '  else',
    '    export LLMPROXY_HOST_PROJECTS_ROOT="/home"',
    '  fi',
    'fi',
    'compose_cmd=""',
    'compose_args=""',
    'if command -v docker >/dev/null 2>&1 && [ -f "$docker_compose_file" ]; then',
    '  if docker compose version >/dev/null 2>&1; then',
    '    compose_cmd="docker"',
    '    compose_args="compose"',
    '  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then',
    '    compose_cmd="docker-compose"',
    '  fi',
    '  if [ -n "$compose_cmd" ]; then',
    '    if [ "$compose_cmd" = "docker" ]; then',
    '      if docker compose -f "$docker_compose_file" ps --services --status running 2>/dev/null | grep -qx "llmproxy"; then',
    '        docker compose -f "$docker_compose_file" up -d --build llmproxy >/dev/null || true',
    '      fi',
    '    else',
    '      if docker-compose -f "$docker_compose_file" ps --services --status running 2>/dev/null | grep -qx "llmproxy"; then',
    '        docker-compose -f "$docker_compose_file" up -d --build llmproxy >/dev/null || true',
    '      fi',
    '    fi',
    '  fi',
    'fi',
    "",
    "# Smoke test the freshly installed CLI and managed runtime before declaring success",
    'post_update_check() {',
    '  run_new_llmproxy version >/dev/null 2>&1 || return 1',
    '  run_new_llmproxy config:list >/dev/null 2>&1 || return 1',
    '  attempts=0',
    '  while [ "$attempts" -lt 5 ]; do',
    '    if run_new_llmproxy status >/dev/null 2>&1; then',
    '      return 0',
    '    fi',
    '    attempts=$((attempts + 1))',
    '    sleep 2',
    '  done',
    '  return 1',
    '}',
    'if ! post_update_check; then',
    '  rollback_and_exit "post-update smoke test failed for $target_version"',
    'fi',
    "",
    "# Output results",
    `release_notes_output=$(run_new_llmproxy release-notes --version "$version_output" --locale ${shellQuote(normalizeLocale(locale))} --commit-message-base64 "$commit_message_base64")`,
    'printf "__LLMPROXY_VERSION__=%s\\n" "$version_output"',
    'printf "__LLMPROXY_RELEASE_NOTES_START__\\n%s\\n__LLMPROXY_RELEASE_NOTES_END__\\n" "$release_notes_output"',
    'if [ "$service_restart_status" -ne 0 ]; then',
    '  printf "__LLMPROXY_SERVICE_RESTART_WARNING__=%s\\n" "$service_restart_output"',
    'fi',
  ].join("\n");
  return commandRunner("bash", ["-c", script], { encoding: "utf8" });
}

function runSelfUninstall(commandRunner = spawnSync) {
  const script = [
    'set -e',
    'npm uninstall -g llmproxy >/dev/null 2>&1 || true',
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'npm_prefix=$(npm prefix -g 2>/dev/null || true)',
    'if [ -n "$npm_prefix" ]; then',
    '  rm -f "$npm_prefix/bin/llmproxy" >/dev/null 2>&1 || true',
    '  rm -f "$npm_prefix/bin/llmp" >/dev/null 2>&1 || true',
    'fi',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy" >/dev/null 2>&1 || true',
    '  rm -f "$pnpm_home/bin/llmp" >/dev/null 2>&1 || true',
    'fi',
  ].join("\n");
  return commandRunner("bash", ["-c", script], { encoding: "utf8" });
}

function runSelfUpdateWindows(commandRunner = spawnSync, repo = "alessiobacin/llmProxy", locale = "it") {
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    '$tmpdir = [System.IO.Path]::GetTempPath() + [System.IO.Path]::GetRandomFileName()',
    'New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null',
    '',
    '$currentVersion = ((& llmproxy version 2>$null) | Out-String).Trim()',
    '$currentNpmRoot = ((npm root -g 2>$null) | Out-String).Trim()',
    '$currentInstallDir = if ($currentNpmRoot) { Join-Path $currentNpmRoot "llmproxy" } else { "" }',
    '$rollbackDir = Join-Path $tmpdir "rollback-llmproxy"',
    '$rollbackAvailable = $false',
    'if ($currentInstallDir -and (Test-Path $currentInstallDir)) {',
    '  Copy-Item -Recurse -Force $currentInstallDir $rollbackDir',
    '  $rollbackAvailable = $true',
    '}',
    '',
    `git clone --depth=1 https://github.com/${repo}.git "$tmpdir/repo" 2>&1 | Out-Null`,
    'Set-Location "$tmpdir/repo"',
    '',
    '$targetVersion = node -p "require(\'./package.json\').version"',
    '$commitMessageBytes = [Text.Encoding]::UTF8.GetBytes((git log -1 --pretty=%B 2>$null))',
    '$commitMessageBase64 = [Convert]::ToBase64String($commitMessageBytes)',
    '',
    '# npm pack',
    'npm pack --pack-destination "$tmpdir" 2>&1 | Out-Null',
    '$packageFile = Get-ChildItem "$tmpdir/*.tgz" | Select-Object -First 1 -ExpandProperty FullName',
    '',
    '# Install globally (always same user on Windows)',
    `npm install -g --force "$packageFile" 2>&1`,
    '',
    '# Clean up pnpm global if present',
    'pnpm remove -g llmproxy 2>$null | Out-Null',
    '$pnpmRoot = pnpm root -g 2>$null',
    'if ($pnpmRoot) {',
    '  $pnpmHome = Split-Path (Split-Path $pnpmRoot) -Parent',
    '  Remove-Item -Force "$pnpmHome/bin/llmproxy" -ErrorAction SilentlyContinue',
    '}',
    '',
    'function Resolve-LlmproxyGlobalBin([string]$Prefix) {',
    '  $candidates = @(',
    '    (Join-Path $Prefix "llmproxy.cmd"),',
    '    (Join-Path $Prefix "llmproxy.ps1"),',
    '    (Join-Path $Prefix "llmproxy"),',
    '    (Join-Path $Prefix "llmp.cmd"),',
    '    (Join-Path $Prefix "llmp.ps1"),',
    '    (Join-Path $Prefix "llmp")',
    '  )',
    '  foreach ($candidate in $candidates) {',
    '    if (Test-Path $candidate) { return $candidate }',
    '  }',
    '  return (Join-Path $Prefix "llmproxy.cmd")',
    '}',
    '',
    '# Find the newly installed binary',
    '$npmPrefix = ((npm prefix -g 2>$null) | Out-String).Trim()',
    '$newBin = Resolve-LlmproxyGlobalBin $npmPrefix',
    '$installDir = Join-Path ((npm root -g).Trim()) "llmproxy"',
    '$packageCli = Join-Path $installDir "bin/llmproxy.js"',
    '',
    `$localeArg = ${locale === "en" ? '"en"' : '"it"'}`,
    '',
    'function Invoke-Rollback([string]$Reason) {',
    '  if ($rollbackAvailable -and (Test-Path $rollbackDir)) {',
    '    if ($installDir -and (Test-Path $installDir)) { Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue }',
    '    $parentDir = Split-Path $installDir -Parent',
    '    if ($parentDir) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }',
    '    Copy-Item -Recurse -Force $rollbackDir $installDir',
    '    $restoredCli = Join-Path $installDir "bin/llmproxy.js"',
    '    if (Test-Path $restoredCli) {',
    '      node $restoredCli service:restart 2>$null | Out-Null',
    '      $restoredVersion = ((node $restoredCli version 2>$null) | Out-String).Trim()',
    '      Write-Output "__LLMPROXY_ROLLBACK__=1"',
    '      Write-Output "__LLMPROXY_ROLLBACK_VERSION__=$restoredVersion"',
    '      Write-Output "__LLMPROXY_ROLLBACK_REASON__=$Reason"',
    '      exit 0',
    '    }',
    '  }',
    '  throw "Update verification failed: $Reason"',
    '}',
    '',
    '# Migrate legacy managed config variables to the current schema',
    '& "$newBin" config:migrate 2>$null | Out-Null',
    '',
    '# Restart service via the new binary',
    '& "$newBin" service:restart 2>&1',
    '$resolvedVersion = ((& "$newBin" version 2>$null) | Out-String).Trim()',
    'if ($resolvedVersion -ne $targetVersion) { Invoke-Rollback "installed binary verification failed for $targetVersion" }',
    '& "$newBin" config:list 2>$null | Out-Null',
    'if ($LASTEXITCODE -ne 0) { Invoke-Rollback "config:list failed after installing $targetVersion" }',
    '& "$newBin" status 2>$null | Out-Null',
    'if ($LASTEXITCODE -ne 0) { Invoke-Rollback "post-update smoke test failed for $targetVersion" }',
    '',
    '# Output results',
    '$versionOutput = $resolvedVersion',
    '$releaseNotesOutput = & "$newBin" release-notes --version $targetVersion --locale ' + (locale === "en" ? '"en"' : '"it"') + ' --commit-message-base64 $commitMessageBase64 2>&1',
    'Write-Output "__LLMPROXY_VERSION__=$versionOutput"',
    'Write-Output "__LLMPROXY_RELEASE_NOTES_START__"',
    'Write-Output "$releaseNotesOutput"',
    'Write-Output "__LLMPROXY_RELEASE_NOTES_END__"',
  ].join("\n");
  return commandRunner("powershell.exe", ["-NoProfile", "-Command", psScript], { encoding: "utf8" });
}

function runSelfUninstallWindows(commandRunner = spawnSync) {
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    'npm uninstall -g llmproxy 2>$null | Out-Null',
    'pnpm remove -g llmproxy 2>$null | Out-Null',
    '$npmPrefix = ((npm prefix -g 2>$null) | Out-String).Trim()',
    'if ($npmPrefix) {',
    '  @(',
    '    "llmproxy", "llmproxy.cmd", "llmproxy.ps1",',
    '    "llmp", "llmp.cmd", "llmp.ps1"',
    '  ) | ForEach-Object {',
    '    $candidate = Join-Path $npmPrefix $_',
    '    Remove-Item -Force $candidate -ErrorAction SilentlyContinue',
    '  }',
    '}',
    '$pnpmRoot = pnpm root -g 2>$null',
    'if ($pnpmRoot) {',
    '  $pnpmHome = Split-Path (Split-Path $pnpmRoot) -Parent',
    '  @(',
    '    "llmproxy", "llmproxy.cmd", "llmproxy.ps1",',
    '    "llmp", "llmp.cmd", "llmp.ps1"',
    '  ) | ForEach-Object {',
    '    Remove-Item -Force (Join-Path "$pnpmHome/bin" $_) -ErrorAction SilentlyContinue',
    '  }',
    '}',
  ].join("\n");
  return commandRunner("powershell.exe", ["-NoProfile", "-Command", psScript], { encoding: "utf8" });
}

function buildWindowsPersistentInstallScript(options = {}) {
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const locale = normalizeLocale(options.locale);
  const lines = locale === "en"
    ? [
      "$ErrorActionPreference = 'Stop'",
      "# Remove previous global installs",
      "npm uninstall -g llmproxy 2>$null | Out-Null",
      "pnpm remove -g llmproxy 2>$null | Out-Null",
      "# Install globally",
      `npm install -g ${shellQuote(packageRoot)} 2>&1`,
      "# Remove pnpm global wrapper if it exists",
      "$pnpmRoot = pnpm root -g 2>$null",
      "if ($pnpmRoot) {",
      "  $pnpmHome = Split-Path (Split-Path $pnpmRoot) -Parent",
      "  Remove-Item -Force \"$pnpmHome/bin/llmproxy\" -ErrorAction SilentlyContinue",
      "}",
      "function Resolve-LlmproxyGlobalBin([string]$Prefix) {",
      "  $candidates = @(",
      "    (Join-Path $Prefix \"llmproxy.cmd\"),",
      "    (Join-Path $Prefix \"llmproxy.ps1\"),",
      "    (Join-Path $Prefix \"llmproxy\"),",
      "    (Join-Path $Prefix \"llmp.cmd\"),",
      "    (Join-Path $Prefix \"llmp.ps1\"),",
      "    (Join-Path $Prefix \"llmp\")",
      "  )",
      "  foreach ($candidate in $candidates) {",
      "    if (Test-Path $candidate) { return $candidate }",
      "  }",
      "  return (Join-Path $Prefix \"llmproxy.cmd\")",
      "}",
      "# Remove other llmproxy binaries from PATH (keep the npm one)",
      "$npmPrefix = ((npm prefix -g 2>$null) | Out-String).Trim()",
      "$globalBin = Resolve-LlmproxyGlobalBin $npmPrefix",
      "$existing = Get-Command llmproxy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
      "foreach ($bin in $existing) {",
      "  if ($bin -ne $globalBin -and (Test-Path $bin)) { Remove-Item -Force $bin -ErrorAction SilentlyContinue }",
      "}",
      "# Start persistent service via the newly installed global binary",
      "$env:LLMPROXY_MODE = 'standalone'",
      "$env:LLMPROXY_SERVICE_RUNTIME = 'native'",
      "& \"$globalBin\" service:start 2>&1",
      "Write-Output \"__LLMPROXY_GLOBAL_BIN__=$globalBin\"",
      "Write-Output \"__LLMPROXY_BIN_SCOPE__=user\"",
    ]
    : [
      "$ErrorActionPreference = 'Stop'",
      "# Rimuovi installazioni globali precedenti",
      "npm uninstall -g llmproxy 2>$null | Out-Null",
      "pnpm remove -g llmproxy 2>$null | Out-Null",
      "# Installa globalmente",
      `npm install -g ${shellQuote(packageRoot)} 2>&1`,
      "# Rimuovi wrapper pnpm globale se esiste",
      "$pnpmRoot = pnpm root -g 2>$null",
      "if ($pnpmRoot) {",
      "  $pnpmHome = Split-Path (Split-Path $pnpmRoot) -Parent",
      "  Remove-Item -Force \"$pnpmHome/bin/llmproxy\" -ErrorAction SilentlyContinue",
      "}",
      "function Resolve-LlmproxyGlobalBin([string]$Prefix) {",
      "  $candidates = @(",
      "    (Join-Path $Prefix \"llmproxy.cmd\"),",
      "    (Join-Path $Prefix \"llmproxy.ps1\"),",
      "    (Join-Path $Prefix \"llmproxy\"),",
      "    (Join-Path $Prefix \"llmp.cmd\"),",
      "    (Join-Path $Prefix \"llmp.ps1\"),",
      "    (Join-Path $Prefix \"llmp\")",
      "  )",
      "  foreach ($candidate in $candidates) {",
      "    if (Test-Path $candidate) { return $candidate }",
      "  }",
      "  return (Join-Path $Prefix \"llmproxy.cmd\")",
      "}",
      "# Rimuovi altri binari llmproxy dal PATH (mantieni quello npm)",
      "$npmPrefix = ((npm prefix -g 2>$null) | Out-String).Trim()",
      "$globalBin = Resolve-LlmproxyGlobalBin $npmPrefix",
      "$existing = Get-Command llmproxy -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
      "foreach ($bin in $existing) {",
      "  if ($bin -ne $globalBin -and (Test-Path $bin)) { Remove-Item -Force $bin -ErrorAction SilentlyContinue }",
      "}",
      "# Avvia servizio persistente tramite il binario globale appena installato",
      "$env:LLMPROXY_MODE = 'standalone'",
      "$env:LLMPROXY_SERVICE_RUNTIME = 'native'",
      "& \"$globalBin\" service:start 2>&1",
      "Write-Output \"__LLMPROXY_GLOBAL_BIN__=$globalBin\"",
      "Write-Output \"__LLMPROXY_BIN_SCOPE__=user\"",
    ];

  return lines.join("\n");
}

function buildPersistentInstallScript(options = {}) {
  const platform = String(options.platform || process.platform);
  const packageRoot = path.resolve(String(options.packageRoot || path.join(__dirname, "..")));
  const locale = options.locale === "en" ? "en" : "it";

  if (platform === "win32") {
    return buildWindowsPersistentInstallScript(options);
  }

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
    'append_path_export_once() {',
    '  profile_file="$1"',
    '  bin_dir="$2"',
    '  [ -n "$profile_file" ] || return 0',
    '  [ -n "$bin_dir" ] || return 0',
    '  line="export PATH=\\"$bin_dir:\\$PATH\\""',
    '  if [ ! -f "$profile_file" ]; then',
    '    : > "$profile_file"',
    '  fi',
    '  grep -F "$line" "$profile_file" >/dev/null 2>&1 && return 0',
    '  printf "\\n%s\\n" "$line" >> "$profile_file"',
    '}',
    'persist_user_npm_bin_path() {',
    '  prefix="$1"',
    '  case "$prefix" in',
    '    "$HOME"/*) ;;',
    '    *) return 0 ;;',
    '  esac',
    '  bin_dir="$prefix/bin"',
    '  [ -d "$bin_dir" ] || return 0',
    '  append_path_export_once "$HOME/.profile" "$bin_dir"',
    '  append_path_export_once "$HOME/.bash_profile" "$bin_dir"',
    '  append_path_export_once "$HOME/.zprofile" "$bin_dir"',
    '  PATH="$bin_dir:$PATH"',
    '  export PATH',
    '  hash -r 2>/dev/null || true',
    '}',
    'cleanup_global_service_port() {',
    '  service_port="${1:-7045}"',
    '  [ -n "$service_port" ] || return 0',
    '  if command -v docker >/dev/null 2>&1; then',
    '    docker_ids=$(docker ps --format \'{{.ID}} {{.Ports}}\' 2>/dev/null | awk -v port="$service_port" \'index($0, ":" port "->") > 0 { print $1 }\')',
    '    if [ -n "$docker_ids" ]; then',
    '      for docker_id in $docker_ids; do',
    '        docker stop "$docker_id" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo docker stop "$docker_id" >/dev/null 2>&1 || true; else true; fi; }',
    '        docker rm "$docker_id" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo docker rm "$docker_id" >/dev/null 2>&1 || true; else true; fi; }',
    '      done',
    '    fi',
    '  fi',
    '  if command -v lsof >/dev/null 2>&1; then',
    '    listener_pids=$(lsof -tiTCP:"$service_port" -sTCP:LISTEN 2>/dev/null || true)',
    '    if [ -n "$listener_pids" ]; then',
    '      for listener_pid in $listener_pids; do',
    '        kill "$listener_pid" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo kill "$listener_pid" >/dev/null 2>&1 || true; else true; fi; }',
    '      done',
    '      sleep 1',
    '      listener_pids=$(lsof -tiTCP:"$service_port" -sTCP:LISTEN 2>/dev/null || true)',
    '      if [ -n "$listener_pids" ]; then',
    '        for listener_pid in $listener_pids; do',
    '          kill -9 "$listener_pid" >/dev/null 2>&1 || { if command -v sudo >/dev/null 2>&1; then sudo kill -9 "$listener_pid" >/dev/null 2>&1 || true; else true; fi; }',
    '        done',
    '      fi',
    '    fi',
    '  fi',
    '}',
    "",
    "# Block reinstall if llmproxy is already installed system-wide by another user",
    'existing_global_bin=""',
    'for candidate in $( (which -a llmproxy 2>/dev/null; which -a llmp 2>/dev/null) | awk \'!seen[$0]++\'); do',
    '  case "$candidate" in',
    '    "$HOME"/*) ;;',
    '    *) existing_global_bin="$candidate"; break ;;',
    '  esac',
    'done',
    'if [ -n "$existing_global_bin" ]; then',
    '  bin_owner=$(stat -c "%U" "$existing_global_bin" 2>/dev/null || stat -f "%Su" "$existing_global_bin" 2>/dev/null || true)',
    '  if [ -n "$bin_owner" ] && [ "$bin_owner" != "$(whoami)" ] && [ "$bin_owner" != "root" ]; then',
    `    echo "llmproxy e' gia' installato globalmente da un altro utente ($bin_owner)." >&2`,
    '    echo "Usa llmproxy update per aggiornare, oppure contatta l\'amministratore di sistema." >&2',
    '    echo "Per forzare la reinstallazione usa --force (sovrascrive l\'installazione esistente)." >&2',
    '    exit 1',
    '  fi',
    'fi',
    "",
    "existing_bins=$( (which -a llmproxy 2>/dev/null; which -a llmp 2>/dev/null) | awk '!seen[$0]++')",
    "used_sudo=0",
    'npm_prefix_global=$(npm prefix -g 2>/dev/null || echo "/usr/local")',
    'case "$npm_prefix_global" in',
    '  "$HOME"/*)',
    '    # User-local npm prefix: prefer the existing writable prefix first',
    `    if ! npm install -g ${shellQuote(packageRoot)} 2>/dev/null; then`,
    '      if command -v sudo >/dev/null 2>&1; then',
    `        if sudo npm install -g ${shellQuote(packageRoot)} 2>/dev/null; then`,
    '          used_sudo=1',
    '          echo "System-wide install via sudo (user-local prefix install failed)."',
    '        else',
    '          echo "Error: npm install failed." >&2',
    '          exit 1',
    '        fi',
    '      else',
    '        echo "Error: npm install failed. Install sudo or fix npm permissions." >&2',
    '        exit 1',
    '      fi',
    '    fi',
    '    ;;',
    '  *)',
    '    # System-level npm prefix: normal install, fall back to sudo if permissions fail',
    `    if ! npm install -g ${shellQuote(packageRoot)} 2>/dev/null; then`,
    '      echo "Standard npm install failed, trying with sudo..."',
    '      if command -v sudo >/dev/null 2>&1; then',
    `        if sudo npm install -g ${shellQuote(packageRoot)} 2>/dev/null; then`,
    '          used_sudo=1',
    '        else',
    '          echo "Error: Cannot install llmproxy globally. Run with sudo or fix npm permissions." >&2',
    '          exit 1',
    '        fi',
    '      else',
    '        echo "Error: npm install failed and sudo is not available. Fix npm permissions or run as root." >&2',
    '        exit 1',
    '      fi',
    '    fi',
    '    ;;',
    'esac',
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy"',
    '  rm -f "$pnpm_home/bin/llmp"',
    'fi',
    "# Re-read npm prefix: use sudo when we installed system-wide",
    'if [ "$used_sudo" -eq 1 ]; then',
    '  npm_prefix=$(sudo npm prefix -g 2>/dev/null || echo "/usr/local")',
    'else',
    '  npm_prefix=$(npm prefix -g 2>/dev/null || echo "/usr/local")',
    'fi',
    'persist_user_npm_bin_path "$npm_prefix"',
    "",
    "# System-wide install: make installed package world-readable (keep root ownership)",
    'if [ "$used_sudo" -eq 1 ]; then',
    '  install_dir="$npm_prefix/lib/node_modules/llmproxy"',
    '  if [ -d "$install_dir" ]; then',
    '    sudo chmod -R a+rX "$install_dir" 2>/dev/null || echo "Warning: could not make $install_dir world-readable. Non-root users may not be able to use llmproxy." >&2',
    '  fi',
    'fi',
    "",
    'global_bin="$npm_prefix/bin/llmproxy"',
    'global_short_bin="$npm_prefix/bin/llmp"',
    '[ -x "$global_bin" ]',
    'linger_user=${SUDO_USER:-$USER}',
    'for installed_bin in $existing_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$global_bin" ] && [ "$installed_bin" != "$global_short_bin" ]; then',
    '    rm -f "$installed_bin"',
    '  fi',
    'done',
    'if [ "$platform" = "linux" ] && command -v sudo >/dev/null 2>&1; then',
    '  sudo -n loginctl enable-linger "$linger_user" >/dev/null 2>&1 || true',
    'fi',
    '# On Linux, wait for systemd --user bus to become available after enable-linger',
    'if [ "$platform" = "linux" ] && [ -z "${XDG_RUNTIME_DIR:-}" ]; then',
    '  uid=$(id -u)',
    '  export XDG_RUNTIME_DIR="/run/user/$uid"',
    'fi',
    'if [ "$platform" = "linux" ] && [ -d "$XDG_RUNTIME_DIR" ]; then',
    '  bus_socket="$XDG_RUNTIME_DIR/bus"',
    '  if [ ! -S "$bus_socket" ] && command -v systemctl >/dev/null 2>&1; then',
    '    systemctl --user start dbus 2>/dev/null || true',
    '    # Wait up to 5s for the user bus socket to appear',
    '    waited=0',
    '    while [ ! -S "$bus_socket" ] && [ "$waited" -lt 5 ]; do',
    '      sleep 1',
    '      waited=$((waited + 1))',
    '    done',
    '  fi',
    'fi',
    'cleanup_global_service_port "${PORT:-7045}"',
    '# When npm install used sudo, run service:start as the original user (systemd --user needs the real user session bus)',
    'if [ "$used_sudo" -eq 1 ] && [ "$platform" = "linux" ] && [ -n "${SUDO_USER:-}" ] && command -v sudo >/dev/null 2>&1; then',
    '  sudo -u "$SUDO_USER" XDG_RUNTIME_DIR="/run/user/$(id -u "$SUDO_USER")" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$SUDO_USER")/bus" LLMPROXY_MODE="standalone" LLMPROXY_SERVICE_RUNTIME="native" "$global_bin" service:start',
    'else',
    '  LLMPROXY_MODE="standalone" LLMPROXY_SERVICE_RUNTIME="native" "$global_bin" service:start',
    'fi',
    'printf "__LLMPROXY_GLOBAL_BIN__=%s\\n" "$global_bin"',
    'case "$global_bin" in',
    '  "$HOME"/*)',
    '    printf "__LLMPROXY_BIN_SCOPE__=user\\n"',
    `    printf "__LLMPROXY_BIN_HINT__=%s\\n" "Il binario globale e' sotto \\$HOME ($global_bin). Altri utenti non vedranno llmproxy. Per installarlo a livello server, imposta il prefix npm su un path di sistema (es. /usr/local) e riesegui con sudo." ;;`,
    '  *) printf "__LLMPROXY_BIN_SCOPE__=server\\n" ;;',
    'esac',
    "",
    "# Suggest cleanup of clone directory",
    `clone_dir=${shellQuote(packageRoot)}`,
    'case "$clone_dir" in',
    '  /tmp/*|"$HOME"/llmProxy|"$HOME"/llmproxy|"$HOME"/Modules-Platform/*)',
    '    printf "__LLMPROXY_CLONE_DIR__=%s\\n" "$clone_dir"',
    '    echo ""',
    '    echo "Il codice e\' stato installato globalmente. La directory di clone non serve piu\'."',
    `    echo "Puoi rimuoverla con: rm -rf $clone_dir"`,
    '    echo ""',
    '    ;;',
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
  const platform = String(options.platform || process.platform);
  if (platform === "win32") {
    const psScript = buildPersistentInstallScript(options);
    return commandRunner("powershell.exe", ["-NoProfile", "-Command", psScript], { encoding: "utf8" });
  }
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
    serviceFile: targetPlatform === "darwin" ? paths.launchAgentFile : targetPlatform === "win32" ? paths.serviceRunnerFile : paths.systemdUnitFile,
    wrapperPath: targetPlatform === "win32" ? paths.serviceRunnerFile : undefined,
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
    LLMPROXY_GLOBAL_SERVICE: "1",
    NODE_ENV: String(env.NODE_ENV || "production"),
    LLMPROXY_ENV: String(env.LLMPROXY_ENV || env.NODE_ENV || "production"),
    LLMPROXY_RUNTIME_PROFILE: String(env.LLMPROXY_RUNTIME_PROFILE || env.LLMPROXY_ENV || env.NODE_ENV || "production"),
    LLMPROXY_HOME: paths.dataRoot,
    LLMPROXY_MODE: String(env.LLMPROXY_MODE || "standalone"),
    LLMPROXY_SERVICE_RUNTIME: String(env.LLMPROXY_SERVICE_RUNTIME || "native"),
    LLMPROXY_MONGODB_CONNECTION_STRING: String(env.LLMPROXY_MONGODB_CONNECTION_STRING || ""),
    DBLAYER_URL: resolveDbLayerUrlForEnv(env),
    EVENTBUS_URL: resolveEventBusUrlForEnv(env),
    LLMPROXY_LOG_RETENTION_DAYS: String(env.LLMPROXY_LOG_RETENTION_DAYS || "30"),
    LLMPROXY_HOST_PROJECTS_ROOT: String(
      env.LLMPROXY_HOST_PROJECTS_ROOT || getDockerHostProjectsRoot({ env }),
    ),
    LLMPROXY_DOCKER_COMPOSE_FILE: dockerComposeFile,
    LLMPROXY_DOCKER_SERVICE: String(env.LLMPROXY_DOCKER_SERVICE || "llmproxy"),
    LLMPROXY_DOCKER_POLL_MS: String(env.LLMPROXY_DOCKER_POLL_MS || "30000"),
    PATH: String(env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
  };
}

async function checkServiceHealth(fetchFn, baseUrl) {
  const response = await fetchFn(`${String(baseUrl).replace(/\/$/, "")}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  return response.ok;
}

async function validatePlatformModeSwitch({ fetchFn, env, serviceConfigFile, nextValue }) {
  const normalized = String(nextValue || "").trim().toLowerCase();
  if (normalized !== "platform") return;

  const currentServiceConfig = readServiceConfig(serviceConfigFile);
  const mergedEnv = {
    ...env,
    ...(currentServiceConfig?.env || {}),
    LLMPROXY_MODE: "platform",
  };
  const dbLayerUrl = resolveDbLayerUrlForEnv(mergedEnv);
  const eventBusUrl = resolveEventBusUrlForEnv(mergedEnv);

  const [dbLayerOk, eventBusOk] = await Promise.all([
    checkServiceHealth(fetchFn, dbLayerUrl).catch(() => false),
    checkServiceHealth(fetchFn, eventBusUrl).catch(() => false),
  ]);

  if (dbLayerOk && eventBusOk) return;

  const missing = [];
  if (!dbLayerOk) missing.push(`db-layer (${dbLayerUrl})`);
  if (!eventBusOk) missing.push(`event-bus (${eventBusUrl})`);
  throw new Error(`Non e' possibile passare a LLMPROXY_MODE=platform: dipendenze non raggiungibili: ${missing.join(", ")}`);
}

function resolveServiceEntryFile({ env = process.env, packageRoot, targetPlatform = process.platform }) {
  const forcedRuntime = String(env.LLMPROXY_SERVICE_RUNTIME || "").trim().toLowerCase();
  if (forcedRuntime === "docker") {
    return path.join(packageRoot, "lib", "service", "docker-launchd-entry.js");
  }
  // Native (default): node, native, o non impostato → server.js diretto
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
    LLMPROXY_LLM_STATS_API_KEY: "",
    LLMPROXY_SENDGRID_API_KEY: "",
    LLMPROXY_SENDGRID_FROM_EMAIL: "",
    LLMPROXY_SENDGRID_TO_EMAIL: "",
    LLMPROXY_SENDGRID_TO_MESSAGE_TYPE: "service_unreachable,service_recovered,provider_error,auto_escalation,provider_credit_exhausted,service_update",
    LLMPROXY_AUTO_ESCALATE: "1",
    LLMPROXY_METERING_INLINE: "0",
    LLMPROXY_INFERENCE_INFO_INLINE: "1",
    LLMPROXY_PROVIDER_CREDIT_INLINE: "1",
    LLMPROXY_SHORT_ANSWER: "0",
    LLMPROXY_PRICE_PERFORMANCE_ROUTING: "1",
    LLMPROXY_PRICE_PERFORMANCE_TIEBREAKER: "power",
  };
  if (options.includeDefaultModel !== false) {
    proxyEnv.ANTHROPIC_DEFAULT_MODEL = selectedModel;
  }
  const uiModelLabel = String(options.uiModelLabel || "llmProxy").trim() || "llmProxy";
  const existingEnv = existingConfig.env && typeof existingConfig.env === "object" ? existingConfig.env : {};
  if (options.includeDefaultModel === false) {
    delete existingEnv.ANTHROPIC_DEFAULT_MODEL;
  }
  delete existingEnv.ANTHROPIC_AUTH_TOKEN;
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
  syncClaudeHomeSettings({
    env,
    proxyEnv: {
      ...proxyEnv,
      ANTHROPIC_AUTH_TOKEN: "proxy-local",
    },
    stdout,
  });
  return 0;
}

function syncClaudeHomeSettings(options = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const proxyEnv = options.proxyEnv && typeof options.proxyEnv === "object" ? options.proxyEnv : {};
  const homeDir = path.resolve(String(env.HOME || os.homedir()));
  const settingsDir = path.join(homeDir, ".claude");
  const settingsFile = path.join(settingsDir, "settings.json");
  let existingConfig = {};

  if (fs.existsSync(settingsFile)) {
    existingConfig = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  }

  const existingEnv = existingConfig.env && typeof existingConfig.env === "object" ? existingConfig.env : {};
  const nextConfig = {
    ...existingConfig,
    env: {
      ...existingEnv,
      ANTHROPIC_BASE_URL: proxyEnv.ANTHROPIC_BASE_URL || existingEnv.ANTHROPIC_BASE_URL,
      API_TIMEOUT_MS: proxyEnv.API_TIMEOUT_MS || existingEnv.API_TIMEOUT_MS,
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: proxyEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || existingEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
      ANTHROPIC_AUTH_TOKEN: proxyEnv.ANTHROPIC_AUTH_TOKEN,
    },
  };

  delete nextConfig.env.ANTHROPIC_DEFAULT_MODEL;

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  stdout.write("Supporto globale Claude sincronizzato automaticamente (placeholder auth locale).\n");
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

function resolveConfigScopeFromParsed(parsed, key = "") {
  const wantsProject = Boolean(parsed.flags.project);
  const wantsService = Boolean(parsed.flags.service);
  if (wantsProject && wantsService) {
    throw new Error("Usa solo uno tra --project e --service");
  }
  const explicitScope = wantsProject ? "project" : wantsService ? "service" : "";
  if (!key) return explicitScope;
  return inferScopeFromKey(key, explicitScope);
}

function resolveConfigListScope(parsed, cwd) {
  const explicitScope = resolveConfigScopeFromParsed(parsed);
  if (explicitScope) return explicitScope;
  return hasLocalClaudeFolder(cwd) ? "" : "service";
}

function persistServiceEnvironmentConfig(serviceConfigFile, environment = {}) {
  if (!serviceConfigFile) return;
  writeServiceConfig(serviceConfigFile, { env: { ...environment } });
}

function writeForegroundRunState(filePath, payload = {}) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readForegroundRunState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function removeForegroundRunState(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function stopForegroundDevInstance(options = {}) {
  const {
    paths,
    stdout = process.stdout,
    stderr = process.stderr,
    execCommand,
    killProcess,
  } = options;
  const devPort = 5045;
  const state = readForegroundRunState(paths.foregroundRunPidFile);
  const listeners = listPortListeners({ port: devPort, execCommand });
  const statePid = Number(state?.pid || 0);
  const listenerByStatePid = statePid > 0
    ? listeners.find((listener) => Number(listener.pid) === statePid)
    : null;

  const killFn = typeof killProcess === "function" ? killProcess : process.kill.bind(process);

  if (listenerByStatePid) {
    killFn(listenerByStatePid.pid, "SIGTERM");
    removeForegroundRunState(paths.foregroundRunPidFile);
    stdout.write(`Istanza dev fermata su http://127.0.0.1:${devPort}\n`);
    return 0;
  }

  const fallbackListeners = listeners.filter((listener) => /node|bun|deno/i.test(String(listener.command || "")));
  if (fallbackListeners.length === 1) {
    killFn(fallbackListeners[0].pid, "SIGTERM");
    removeForegroundRunState(paths.foregroundRunPidFile);
    stdout.write(`Istanza dev fermata su http://127.0.0.1:${devPort}\n`);
    return 0;
  }

  if (listeners.length === 0) {
    removeForegroundRunState(paths.foregroundRunPidFile);
    stdout.write(`Nessuna istanza dev attiva su http://127.0.0.1:${devPort}\n`);
    return 0;
  }

  const summary = listeners.map((listener) => `${listener.command || "unknown"} pid=${listener.pid}`).join(", ");
  stderr.write(`Porta ${devPort} occupata da processi non riconosciuti come run locale llmproxy: ${summary}\n`);
  return 1;
}

function normalizeServiceRuntimeTarget(value, targetPlatform = process.platform) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "docker") return "docker";
  if (["native", "launchd", "systemd", "windows"].includes(normalized)) {
    if (normalized === "launchd" && targetPlatform !== "darwin") {
      throw new Error("`launchd` e' valido solo su macOS.");
    }
    if (normalized === "systemd" && targetPlatform !== "linux") {
      throw new Error("`systemd` e' valido solo su Linux.");
    }
    if (normalized === "windows" && targetPlatform !== "win32") {
      throw new Error("`windows` e' valido solo su Windows.");
    }
    return "native";
  }
  throw new Error("Runtime non valido. Usa uno tra: docker, native, launchd, systemd.");
}

function removeNativeServiceArtifacts({ targetPlatform, paths, env, managerOverride }) {
  const nativeEnv = { ...env, LLMPROXY_SERVICE_RUNTIME: "native" };
  const manager = managerOverride || createServiceManager(resolveCliServiceManagerOptions({ env: nativeEnv, paths, targetPlatform }));
  manager.stop();
  const serviceFile = targetPlatform === "darwin"
    ? paths.launchAgentFile
    : targetPlatform === "win32"
      ? paths.serviceRunnerFile
      : paths.systemdUnitFile;
  try { fs.unlinkSync(serviceFile); } catch { /* ignore */ }
  if (targetPlatform === "win32") {
    try {
      spawnSync("sc.exe", ["delete", "llmproxy"], { encoding: "utf8", shell: true });
    } catch { /* ignore */ }
  }
}

function removeDockerRuntime({ commandRunner, env, paths }) {
  const composeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(paths.packageRoot, "docker-compose.production.yml")).trim();
  const composeEnv = resolveServiceEnvironment({ env, paths, dockerComposeFile: composeFile });
  const spawnOptions = { env: { ...process.env, ...composeEnv } };
  runDockerCompose(commandRunner, composeFile, ["down", "--remove-orphans"], { spawnOptions });
}

function formatConfigList(entries, scope = "") {
  const normalizedScope = String(scope || "").trim();
  if (normalizedScope === "project") {
    return `Project configuration:\n${formatConfigEntries(entries)}`;
  }
  if (normalizedScope === "service") {
    return `Service configuration:\n${formatConfigEntries(entries)}`;
  }
  return `Project configuration:\n${formatConfigEntries(entries.filter((entry) => entry.scope === "project"))}\n\nService configuration:\n${formatConfigEntries(entries.filter((entry) => entry.scope === "service"))}`;
}

function buildRestCommandRequest(parsed, options = {}) {
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const headers = { "content-type": "application/json", "x-project-path": cwd };
  const body = {};
  const query = new URLSearchParams();
  const command = parsed.command;

  switch (command) {
    case "version":
      return { method: "GET", path: "/api/version" };
    case "help":
      if (parsed.args[0]) query.set("command", SHORT_COMMAND_ALIASES[parsed.args[0]] || parsed.args[0]);
      return { method: "GET", path: `/api/help${query.toString() ? `?${query.toString()}` : ""}` };
    case "setup":
      return { method: "GET", path: "/api/setup" };
    case "release-notes":
      if (parsed.flags.version || parsed.args[0]) query.set("version", String(parsed.flags.version || parsed.args[0]).trim());
      if (parsed.flags.locale) query.set("locale", String(parsed.flags.locale).trim());
      return { method: "GET", path: `/api/release-notes${query.toString() ? `?${query.toString()}` : ""}` };
    case "login":
      return { method: "POST", path: "/api/auth/login" };
    case "logout":
      return { method: "POST", path: "/api/auth/logout" };
    case "status":
      return { method: "GET", path: "/api/service/status" };
    case "logs":
      if (parsed.follow) return null;
      return { method: "GET", path: "/api/logs" };
    case "models:list":
      return { method: "GET", path: "/api/models" };
    case "claude:setup":
      if (parsed.flags.model) body.model = String(parsed.flags.model).trim();
      body.projectPath = cwd;
      return { method: "POST", path: "/api/claude/setup", headers, body };
    case "model:set":
      body.model = String(parsed.args[0] || "").trim();
      body.projectPath = cwd;
      return { method: "POST", path: "/api/model/set", headers, body };
    case "provider:add": {
      const providerId = normalizeKnownProviderId(parsed.args[0]);
      if (!providerId) return null;
      const apiKey = String(parsed.flags["api-key"] || "").trim();
      const providerName = String(parsed.flags.name || providerId).trim();
      const model = String(parsed.flags.model || parsed.flags["default-model"] || "").trim();
      const plan = String(parsed.flags.plan || "").trim();
      const freeModel = parsed.flags["free-model"];
      if (apiKey) {
        return {
          method: "POST",
          path: `/api/providers/${encodeURIComponent(providerId)}/api-key`,
          headers,
          body: {
            name: providerName,
            apiKey,
            model,
            plan,
            vision: parsed.flags.vision,
            freeModel,
          },
        };
      }
      return {
        method: "POST",
        path: `/api/providers/${encodeURIComponent(providerId)}/login`,
        headers,
        body: {
          name: providerName,
          model,
          plan,
          freeModel,
        },
      };
    }
    case "provider:key": {
      const providerId = normalizeKnownProviderId(parsed.args[0]);
      if (!providerId) return null;
      return {
        method: "POST",
        path: `/api/providers/${encodeURIComponent(providerId)}/api-key`,
        headers,
        body: {
          name: providerId,
          apiKey: String(parsed.flags["api-key"] || "").trim(),
          model: String(parsed.flags.model || parsed.flags["default-model"] || "").trim(),
          plan: String(parsed.flags.plan || "").trim(),
          vision: parsed.flags.vision,
          freeModel: parsed.flags["free-model"],
        },
      };
    }
    case "provider:list":
      return { method: "GET", path: "/api/providers", headers };
    case "provider:available":
      return { method: "GET", path: "/api/providers/available" };
    case "provider:status":
      return { method: "GET", path: "/api/providers/status" };
    case "provider:usage":
      return { method: "GET", path: "/api/providers/usage" };
    case "provider:order":
      return {
        method: "POST",
        path: "/api/providers/order",
        headers,
        body: {
          id: String(parsed.args[0] || "").trim(),
          position: String(parsed.args[1] || "").trim(),
        },
      };
    case "provider:rename":
      return {
        method: "POST",
        path: `/api/providers/${encodeURIComponent(String(parsed.args[0] || "").trim())}/rename`,
        headers,
        body: { name: parsed.args.slice(1).join(" ").trim() },
      };
    case "provider:remove":
      return {
        method: "DELETE",
        path: `/api/providers/${encodeURIComponent(String(parsed.args[0] || "").trim())}`,
        headers,
      };
    case "service:stop":
      return { method: "POST", path: "/api/service/stop" };
    case "service:restart":
      return { method: "POST", path: "/api/service/restart" };
    case "service:runtime":
      body.runtime = String(parsed.args[0] || "").trim();
      return { method: "POST", path: "/api/service/runtime", body };
    case "stats":
      return { method: "GET", path: "/api/stats" };
    case "update":
      return { method: "POST", path: "/api/update" };
    case "uninstall":
      return { method: "POST", path: "/api/uninstall" };
    case "config:list": {
      const scope = resolveConfigScopeFromParsed(parsed);
      if (scope) query.set("scope", scope);
      query.set("projectPath", cwd);
      return { method: "GET", path: `/api/config${query.toString() ? `?${query.toString()}` : ""}`, headers };
    }
    case "config:get": {
      const key = String(parsed.args[0] || "").trim();
      if (!key) return null;
      const scope = resolveConfigScopeFromParsed(parsed, key);
      if (scope) query.set("scope", scope);
      query.set("projectPath", cwd);
      return { method: "GET", path: `/api/config/${encodeURIComponent(key)}?${query.toString()}`, headers };
    }
    case "config:set": {
      const key = String(parsed.args[0] || "").trim();
      if (!key) return null;
      const scope = resolveConfigScopeFromParsed(parsed, key);
      return {
        method: "POST",
        path: `/api/config/${encodeURIComponent(key)}`,
        headers,
        body: {
          value: String(parsed.args[1] || ""),
          scope,
          projectPath: cwd,
        },
      };
    }
    case "config:unset": {
      const key = String(parsed.args[0] || "").trim();
      if (!key) return null;
      const scope = resolveConfigScopeFromParsed(parsed, key);
      return {
        method: "DELETE",
        path: `/api/config/${encodeURIComponent(key)}`,
        headers,
        body: {
          scope,
          projectPath: cwd,
        },
      };
    }
    default:
      return null;
  }
}

async function tryRunViaRest(parsed, options = {}) {
  if (options.preferLocalExecution) return null;
  if (parsed.command === "update" || parsed.command === "uninstall") return null;
  if (options.tokenStore || options.modelCatalogStore || options.serviceManager || options.commandRunner) {
    return null;
  }
  let request = null;
  try {
    request = buildRestCommandRequest(parsed, options);
  } catch {
    return null;
  }
  if (!request) return null;

  const restFetchFn = options.restFetchFn === undefined ? fetch : options.restFetchFn;
  if (typeof restFetchFn !== "function") return null;

  const baseUrl = getProxyBaseUrl({
    env: options.env || process.env,
    dataRoot: options.dataRoot,
  });

  try {
    const healthResponse = await restFetchFn(`${baseUrl}/health`);
    if (!healthResponse?.ok) return null;

    const response = await restFetchFn(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    const payload = await response.json();
    const data = payload?.data || {};
    if (data.output) {
      options.stdout.write(`${String(data.output).trimEnd()}\n`);
    }
    if (data.error) {
      options.stderr.write(`${String(data.error).trimEnd()}\n`);
    }
    return Number.isFinite(Number(payload?.exitCode)) ? Number(payload.exitCode) : (payload?.success ? 0 : 1);
  } catch {
    return null;
  }
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

function readLatestRequestSummary(logsDir, sinceIso = null) {
  if (!fs.existsSync(logsDir)) return null;
  const requestLogs = fs.readdirSync(logsDir)
    .filter((fileName) => /^requests-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(fileName))
    .sort();

  let latest = null;
  for (const fileName of requestLogs) {
    const filePath = path.join(logsDir, fileName);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry?.event !== "request_summary") continue;
      const ts = String(entry?.ts || "").trim();
      if (!ts) continue;
      if (sinceIso && ts < sinceIso) continue;
      if (!latest || ts >= String(latest.ts || "")) latest = entry;
    }
  }
  return latest;
}

async function waitForLatestRequestSummary(logsDir, options = {}) {
  const sinceIso = options.sinceIso || null;
  const matcher = typeof options.matcher === "function" ? options.matcher : null;
  const retries = Number.isInteger(options.retries) ? options.retries : 40;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 50;
  const sleepFn = typeof options.sleepFn === "function"
    ? options.sleepFn
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let retry = 0; retry < retries; retry += 1) {
    const summary = readLatestRequestSummary(logsDir, sinceIso);
    if (summary && (!matcher || matcher(summary))) return summary;
    if (retry < retries - 1) await sleepFn(delayMs);
  }
  return null;
}

function formatInferenceProviderAttempt(attempt = {}) {
  const provider = String(attempt.provider || "unknown").trim();
  const model = String(attempt.actual_model || attempt.effective_model || "").trim();
  if (attempt.success === true) {
    return `${provider}[ok${model ? ` ${model}` : ""}]`;
  }
  if (typeof attempt.status === "number") {
    return `${provider}[HTTP ${attempt.status}${model ? ` ${model}` : ""}]`;
  }
  return `${provider}[fail${model ? ` ${model}` : ""}]`;
}

function normalizeInferenceDisplayModel(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
  return leaf.replace(/-\d{8}$/i, "");
}

function buildRemainingFallbackProviders(providers, finalProviderId, finalModel) {
  const orderedProviders = Array.isArray(providers) ? providers.slice() : [];
  if (orderedProviders.length === 0) return [];

  const normalizedFinalProviderId = String(finalProviderId || "").trim().toLowerCase();
  const normalizedFinalModel = String(finalModel || "").trim().toLowerCase();
  let winnerIndex = orderedProviders.findIndex((provider) => {
    const providerId = String(provider?.id || "").trim().toLowerCase();
    const model = String(provider?.effective_model || provider?.default_model || "").trim().toLowerCase();
    return providerId === normalizedFinalProviderId && (!normalizedFinalModel || model === normalizedFinalModel);
  });

  if (winnerIndex === -1) {
    winnerIndex = orderedProviders.findIndex((provider) => String(provider?.id || "").trim().toLowerCase() === normalizedFinalProviderId);
  }
  if (winnerIndex === -1) return [];
  return orderedProviders.slice(winnerIndex + 1);
}

function formatOrdinalLabel(position) {
  const index = Number(position || 0);
  if (index === 1) return "1st";
  if (index === 2) return "2nd";
  if (index === 3) return "3rd";
  return `${index}th`;
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

async function readResponseErrorSnippet(response) {
  if (!response) return "";
  try {
    if (typeof response.text !== "function") return "";
    const rawText = String(await response.text() || "").trim();
    if (!rawText) return "";
    try {
      const parsed = JSON.parse(rawText);
      const nestedMessage = parsed?.error?.message
        || parsed?.error?.error
        || parsed?.message
        || parsed?.detail
        || parsed?.details;
      const normalizedNested = typeof nestedMessage === "string"
        ? nestedMessage.trim()
        : nestedMessage != null
          ? JSON.stringify(nestedMessage)
          : "";
      if (normalizedNested) return normalizedNested.slice(0, 240);
    } catch {
      // fall back to the raw text
    }
    return rawText.replace(/\s+/g, " ").slice(0, 240);
  } catch {
    return "";
  }
}

async function probeProviderForTest({ fetchFn, proxyBaseUrl, provider, sleepFn, logsDir }) {
  const model = provider.default_model || (String(provider.provider || "copilot") === "copilot" ? DEFAULT_COPILOT_MODEL : "");
  if (!model) {
    return {
      ok: false,
      kind: "missing-model",
      message: "default model mancante",
      model,
      displayModel: model,
    };
  }

  const providerStartedAtIso = new Date().toISOString();
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
    sleepFn,
  );

  if (!response.ok && response.status !== 429 && response.status !== 402) {
    const errorSnippet = await readResponseErrorSnippet(response);
    return {
      ok: false,
      kind: "http",
      status: response.status,
      message: errorSnippet ? `HTTP ${response.status}: ${errorSnippet}` : `HTTP ${response.status}`,
      model,
      displayModel: model,
    };
  }

  if (!response.ok && (response.status === 429 || response.status === 402)) {
    return {
      ok: true,
      model,
      displayModel: model,
      finalProvider: provider.id,
      finalModel: model,
      degradedStatus: response.status,
    };
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
  let summary = readLatestRequestSummary(logsDir, providerStartedAtIso);
  if (summary && String(summary?.finalProvider || "").trim() !== provider.id) {
    summary = null;
  }
  if (!visibleAssistantText && !(summary?.success && String(summary?.finalProvider || "").trim() === provider.id)) {
    summary = await waitForLatestRequestSummary(logsDir, {
      sinceIso: providerStartedAtIso,
      sleepFn,
      matcher: (entry) => {
        const finalProvider = String(entry?.finalProvider || "").trim();
        return entry?.success === true && finalProvider === provider.id;
      },
    });
  }
  const finalProvider = String(summary?.finalProvider || "").trim();
  const finalModel = String(summary?.finalModel || payload?.model || "").trim();
  if (!visibleAssistantText && !(summary?.success && finalProvider)) {
    return {
      ok: false,
      kind: "empty",
      message: "risposta vuota",
      model,
      displayModel: finalModel || model,
    };
  }

  return {
    ok: true,
    model,
    displayModel: finalModel || model,
    finalProvider,
    finalModel,
  };
}

function isDockerManagedRuntime(env, paths, targetPlatform) {
  const entryFile = resolveServiceEntryFile({ env, packageRoot: paths.packageRoot, targetPlatform });
  return path.basename(entryFile) === "docker-launchd-entry.js";
}

function isDockerServiceRunning(commandRunner, composeFile, serviceName, spawnOptions = {}) {
  const result = runDockerCompose(commandRunner, composeFile, ["ps", "--status", "running", "--services", serviceName], { spawnOptions });
  if (!result || result.status !== 0) return false;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .includes(serviceName);
}

function ensureDockerServiceRunning({ commandRunner, env, paths, targetPlatform }) {
  if (!isDockerManagedRuntime(env, paths, targetPlatform)) {
    return { ok: true, checked: false };
  }
  const composeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(paths.packageRoot, "docker-compose.production.yml")).trim();
  const serviceName = String(env.LLMPROXY_DOCKER_SERVICE || "llmproxy").trim() || "llmproxy";
  const composeEnv = resolveServiceEnvironment({ env, paths, dockerComposeFile: composeFile });
  const spawnOptions = { env: { ...process.env, ...composeEnv } };
  if (!fs.existsSync(composeFile)) {
    return { ok: false, error: `File docker compose non trovato: ${composeFile}` };
  }
  try {
    fs.accessSync(composeFile, fs.constants.R_OK);
  } catch {
    const installDir = path.dirname(composeFile);
    return {
      ok: false,
      error: `Permesso negato nella lettura di ${composeFile}. Esegui: sudo chmod -R a+rX "${installDir}"`,
    };
  }
  const dockerCompose = resolveDockerComposeCommand(commandRunner, { spawnOptions });
  if (!dockerCompose.dockerAvailable) {
    return { ok: false, error: "Docker non trovato nel PATH." };
  }
  if (!dockerCompose.ok) {
    return { ok: false, error: "Docker Compose non e' disponibile (`docker compose` e `docker-compose` falliscono)." };
  }
  if (isDockerServiceRunning(commandRunner, composeFile, serviceName, spawnOptions)) {
    return { ok: true, checked: true, restarted: false, composeLabel: dockerCompose.label };
  }
  const upResult = runDockerCompose(commandRunner, composeFile, ["up", "-d", "--build", serviceName], { invocation: dockerCompose, spawnOptions });
  if (!upResult || upResult.status !== 0) {
    return {
      ok: false,
      error: String(upResult?.stderr || upResult?.stdout || `${dockerCompose.label} up failed`).trim(),
    };
  }
  if (!isDockerServiceRunning(commandRunner, composeFile, serviceName, spawnOptions)) {
    return { ok: false, error: `Il container Docker ${serviceName} non risulta attivo dopo il restart.` };
  }
  return { ok: true, checked: true, restarted: true, composeLabel: dockerCompose.label };
}

function getManagedServiceStatus({ commandRunner, env, paths, targetPlatform, serviceManager }) {
  if (!isDockerManagedRuntime(env, paths, targetPlatform)) {
    return {
      kind: serviceManager.kind,
      status: serviceManager.status(),
    };
  }

  const composeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(paths.packageRoot, "docker-compose.production.yml")).trim();
  const serviceName = String(env.LLMPROXY_DOCKER_SERVICE || "llmproxy").trim() || "llmproxy";
  const composeEnv = resolveServiceEnvironment({ env, paths, dockerComposeFile: composeFile });
  const spawnOptions = { env: { ...process.env, ...composeEnv } };
  const dockerCompose = resolveDockerComposeCommand(commandRunner, { spawnOptions });

  if (!dockerCompose.dockerAvailable) {
    return {
      kind: "docker",
      status: { ok: false, active: false, stdout: "", stderr: "Docker non trovato nel PATH." },
    };
  }

  if (!dockerCompose.ok) {
    return {
      kind: "docker",
      status: { ok: false, active: false, stdout: "", stderr: "Docker Compose non e' disponibile (`docker compose` e `docker-compose` falliscono)." },
    };
  }

  const active = isDockerServiceRunning(commandRunner, composeFile, serviceName, spawnOptions);
  return {
    kind: "docker",
    status: {
      ok: true,
      active,
      stdout: active ? `${serviceName} container active via ${dockerCompose.label}` : `${serviceName} container not running`,
      stderr: "",
    },
  };
}

async function waitForLocalProxyHealth({ fetchFn, baseUrl, sleepFn, retries = 20, delayMs = 250 }) {
  const delay = typeof sleepFn === "function"
    ? sleepFn
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchFn(`${baseUrl}/health`, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.ok !== false) return { ok: true, payload };
      }
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(delayMs);
  }

  return {
    ok: false,
    error: lastError ? String(lastError.message || lastError) : "health check failed",
  };
}

async function runCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const fetchFn = options.fetchFn || fetch;
  const sleep = options.sleep;
  const parsed = parseArgs(argv || process.argv);
  const targetPlatform = options.platform || process.platform;
  const env = loadRuntimeEnv({
    env: options.env || process.env,
    packageRoot: options.packageRoot,
    dataRoot: options.dataRoot,
    homeDir: options.homeDir,
    platform: targetPlatform,
  });
  const paths = createPaths({ dataRoot: options.dataRoot, packageRoot: options.packageRoot, env, homeDir: options.homeDir, platform: targetPlatform });
  ensureRuntimeDirs(paths);
  const restExitCode = await tryRunViaRest(parsed, {
    ...options,
    env,
    dataRoot: paths.dataRoot,
    stdout,
    stderr,
  });
  if (restExitCode !== null) {
    return restExitCode;
  }
  const tokenStore = options.tokenStore || createTokenStore({ filePath: paths.tokenFile });
  const providerRegistry = options.providerRegistry || createProviderRegistry({
    filePath: paths.providerRegistryFile,
    secret: env.LLMPROXY_SECRET || null,
  });
  const providerStore = tokenStore;
  const modelCatalogStore = options.modelCatalogStore || createCopilotModelCatalogStore({ filePath: paths.modelCatalogFile });
  const serviceManagerOptions = resolveCliServiceManagerOptions({ env, paths, targetPlatform });
  const serviceManager = options.serviceManager || createServiceManager(serviceManagerOptions);

  if (parsed.command === "help") {
    if (parsed.args[0]) return printCommandHelp(SHORT_COMMAND_ALIASES[parsed.args[0]] || parsed.args[0], stdout);
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
    if (targetPlatform !== "darwin" && targetPlatform !== "linux" && targetPlatform !== "win32") {
      if (isEnglishInstallCommand) {
        stderr.write(`Unsupported platform for persistent installation: ${targetPlatform}\n`);
      } else {
        stderr.write(`Piattaforma non supportata per installazione persistente: ${targetPlatform}\n`);
      }
      return 1;
    }

    const preflight = resolvePersistentInstallPrerequisites({
      commandRunner: options.commandRunner,
      env,
      packageRoot: paths.packageRoot,
      targetPlatform,
    });
    if (!preflight.ok) {
      stderr.write(formatPersistentInstallPrerequisitesFailure(preflight, {
        locale: installLocale,
        platform: targetPlatform,
        osRelease: readOsReleaseInfo({ platform: targetPlatform, content: options.osReleaseContent }),
      }));
      return 1;
    }

    const result = runPersistentInstall(options.commandRunner, {
      packageRoot: paths.packageRoot,
      platform: targetPlatform,
      locale: installLocale,
    });

    if (result?.status === 0) {
      persistServiceEnvironmentConfig(paths.serviceConfigFile, serviceManagerOptions.environment);
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
    const providers = providerStore.listProviders();
    if (providers.length === 0) {
      stderr.write("Non ci sono LLM configurati! Usa llmproxy provider:add <provider> per configurarne uno.\n");
      stderr.write("  Esempi: llmproxy provider:add copilot\n");
      stderr.write("           llmproxy provider:add openrouter --api-key <key> --model <model> --vision true\n");
      stderr.write("  Provider disponibili: llmproxy provider:available\n");
      return 1;
    }
    const inferenceMode = Boolean(parsed.flags.i || parsed.flags.inference);
    const allProviders = Boolean(parsed.flags["all-providers"]);
    const selectedTargets = inferenceMode
      ? []
      : (allProviders ? providers : providers.slice(0, 1));

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

    const projectSettings = resolveClaudeProjectSettings(
      path.resolve(String(options.cwd || process.cwd())),
      { env },
    );
    if (!String(projectSettings.llmStatsApiKey || "").trim()) {
      stderr.write(`${LLM_STATS_API_KEY_REQUIRED_MESSAGE}\n`);
      return 1;
    }

    let failures = 0;

    if (inferenceMode) {
      const startedAtIso = new Date().toISOString();
      try {
        const effectiveProviders = resolveEffectiveProviderList(providers, projectSettings.configuredModel).providers;
        const response = await runLocalProxyTestRequest(
          fetchFn,
          `${proxyBaseUrl}/v1/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              stream: false,
              max_tokens: 256,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: "Rispondi solo: llmproxy-test-inference" }],
                },
              ],
            }),
          },
          sleep,
        );

        if (!response.ok) {
          stdout.write(`inference: fail HTTP ${response.status}\n`);
          return 1;
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
        const summary = await waitForLatestRequestSummary(paths.logsDir, {
          sinceIso: startedAtIso,
          sleepFn: sleep,
          matcher: (entry) => entry?.success === true || String(entry?.finalProvider || "").trim() !== "" || String(entry?.finalModel || "").trim() !== "",
        });
        const finalProvider = String(summary?.finalProvider || "").trim();
        const finalModel = String(summary?.finalModel || payload?.model || "").trim();

        if (!visibleAssistantText && !summary?.success && !finalProvider && !finalModel) {
          stdout.write("inference: fail risposta vuota\n");
          return 1;
        }

        stdout.write(`inference: ok${finalProvider || finalModel ? ` (${[finalProvider, finalModel].filter(Boolean).join(" | ")})` : ""}\n`);
        if (allProviders) {
          const remainingFallbackProviders = buildRemainingFallbackProviders(effectiveProviders, finalProvider, finalModel);
          const workingFallbacks = [];
          const brokenFallbacks = [];
          for (const provider of remainingFallbackProviders) {
            try {
              const probe = await probeProviderForTest({
                fetchFn,
                proxyBaseUrl,
                provider,
                sleepFn: sleep,
                logsDir: paths.logsDir,
              });
              if (probe.ok) {
                workingFallbacks.push({
                  id: provider.id,
                  model: normalizeInferenceDisplayModel(probe.displayModel || provider.effective_model || provider.default_model || ""),
                });
              } else {
                brokenFallbacks.push({
                  id: provider.id,
                  reason: probe.kind === "http"
                    ? `HTTP ${probe.status}`
                    : probe.message,
                  model: probe.displayModel || provider.effective_model || provider.default_model || "",
                });
              }
            } catch (error) {
              brokenFallbacks.push({
                id: provider.id,
                reason: error.message || String(error || ""),
                model: provider.effective_model || provider.default_model || "",
              });
            }
          }
          workingFallbacks.forEach((provider, index) => {
            stdout.write(`${formatOrdinalLabel(index + 1)} fallback: ${provider.id} | ${provider.model || "missing"}\n`);
          });
          brokenFallbacks.forEach((provider) => {
            const model = provider.model ? ` (${provider.model})` : "";
            stdout.write(`invalid fallback: ${provider.id} -> ${provider.reason}${model}\n`);
          });
          if (brokenFallbacks.length > 0) {
            if (visibleAssistantText) stdout.write(`response: ${visibleAssistantText}\n`);
            return 1;
          }
        }
        if (visibleAssistantText) stdout.write(`response: ${visibleAssistantText}\n`);
        return 0;
      } catch (error) {
        const errorMessage = error.message || String(error || "");
        stdout.write(`inference: fail ${errorMessage}\n`);
        return 1;
      }
    }

    for (const provider of selectedTargets) {
      try {
        const probe = await probeProviderForTest({
          fetchFn,
          proxyBaseUrl,
          provider,
          sleepFn: sleep,
          logsDir: paths.logsDir,
        });
        if (!probe.ok) {
          const model = probe.displayModel || probe.model || provider.default_model || "";
          if (probe.kind === "missing-model") {
            stdout.write(`${provider.id}: skipped (${probe.message})\n`);
          } else if (probe.kind === "http") {
            stdout.write(`${provider.id}: fail ${probe.message} (${model})\n`);
          } else {
            stdout.write(`${provider.id}: fail ${probe.message} (${model})\n`);
          }
          failures += 1;
          continue;
        }
        stdout.write(`${provider.id}: ok (${probe.displayModel || probe.model || provider.default_model || ""})\n`);
      } catch (error) {
        const model = provider.default_model || (String(provider.provider || "copilot") === "copilot" ? DEFAULT_COPILOT_MODEL : "");
        stdout.write(`${provider.id}: fail ${error.message || String(error || "")} (${model})\n`);
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

  if (parsed.command === "config:list") {
    try {
      const scope = resolveConfigListScope(parsed, options.cwd);
      const entries = listScopeValues({
        scope,
        cwd: options.cwd,
        serviceConfigFile: paths.serviceConfigFile,
        env,
        packageRoot: paths.packageRoot,
        dataRoot: paths.dataRoot,
      });
      stdout.write(`${formatConfigList(entries, scope)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "config:migrate") {
    try {
      const migrated = migrateManagedConfig({
        cwd: options.cwd,
        serviceConfigFile: paths.serviceConfigFile,
        env,
        packageRoot: paths.packageRoot,
        dataRoot: paths.dataRoot,
      });
      const changedScopes = [
        migrated.project ? "project" : "",
        migrated.global ? "global" : "",
        migrated.service ? "service" : "",
      ].filter(Boolean);
      stdout.write(changedScopes.length > 0
        ? `Config migration completed: ${changedScopes.join(", ")}\n`
        : "Config migration completed: no changes\n");
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "config:get") {
    try {
      const key = String(parsed.args[0] || "").trim();
      if (!key) {
        throw new Error("Uso: llmproxy config:get <key> [--project|--service]");
      }
      const entry = getScopeValue({
        key,
        scope: resolveConfigScopeFromParsed(parsed, key),
        cwd: options.cwd,
        serviceConfigFile: paths.serviceConfigFile,
        env,
        packageRoot: paths.packageRoot,
        dataRoot: paths.dataRoot,
      });
      stdout.write(`${entry.scope}.${entry.key}=${entry.value == null ? "" : String(entry.value)}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "config:set") {
    try {
      const key = String(parsed.args[0] || "").trim();
      if (!key || parsed.args.length < 2) {
        throw new Error("Uso: llmproxy config:set <key> <value> [--project|--service]");
      }
      const scope = resolveConfigScopeFromParsed(parsed, key);
      if (scope === "service" && key === "LLMPROXY_MODE") {
        await validatePlatformModeSwitch({
          fetchFn,
          env,
          serviceConfigFile: paths.serviceConfigFile,
          nextValue: parsed.args[1],
        });
      }
      const entry = setScopeValue({
        key,
        value: parsed.args[1],
        scope,
        cwd: options.cwd,
        serviceConfigFile: paths.serviceConfigFile,
      });
      stdout.write(`Configurazione aggiornata: ${entry.scope}.${entry.key}=${entry.value}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "config:unset") {
    try {
      const key = String(parsed.args[0] || "").trim();
      if (!key) {
        throw new Error("Uso: llmproxy config:unset <key> [--project|--service]");
      }
      const entry = unsetScopeValue({
        key,
        scope: resolveConfigScopeFromParsed(parsed, key),
        cwd: options.cwd,
        serviceConfigFile: paths.serviceConfigFile,
      });
      stdout.write(`Configurazione rimossa: ${entry.scope}.${entry.key}\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "update") {
    const locale = resolveOutputLocale({ env, paths });
    const currentVersion = readPackageVersion(paths.packageRoot).trim();
    try {
      const remoteVersion = await readRemotePackageVersion(fetchFn, undefined, {
        timeoutMs: options.remoteVersionTimeoutMs,
      });
      if (remoteVersion && remoteVersion === currentVersion) {
        if (locale === "en") {
          stdout.write(`Already up to date. Current version: ${currentVersion}\n`);
        } else {
          stdout.write(`Gia' aggiornato. Versione corrente: ${currentVersion}\n`);
        }
        return 0;
      }
    } catch {
      // If the remote version check fails, continue with the standard update flow.
    }
    const preflight = resolveUpdatePrerequisites({
      commandRunner: options.commandRunner || spawnSync,
      env,
      paths,
    });
    if (!preflight.ok) {
      stderr.write(formatUpdatePrerequisitesFailure(preflight, locale));
      return 1;
    }
    const result = targetPlatform === "win32"
      ? runSelfUpdateWindows(options.commandRunner, undefined, locale)
      : runSelfUpdate(options.commandRunner, undefined, locale);
    if (result?.status === 0) {
      const rawStdout = String(result.stdout || "");
      const versionMatch = rawStdout.match(/^__LLMPROXY_VERSION__=(.+)$/m);
      const releaseNotesMatch = rawStdout.match(/__LLMPROXY_RELEASE_NOTES_START__\n([\s\S]*?)\n__LLMPROXY_RELEASE_NOTES_END__/m);
      const serviceRestartWarningMatch = rawStdout.match(/^__LLMPROXY_SERVICE_RESTART_WARNING__=(.+)$/m);
      const rollbackMatch = rawStdout.match(/^__LLMPROXY_ROLLBACK__=(.+)$/m);
      const rollbackVersionMatch = rawStdout.match(/^__LLMPROXY_ROLLBACK_VERSION__=(.+)$/m);
      const rollbackReasonMatch = rawStdout.match(/^__LLMPROXY_ROLLBACK_REASON__=(.+)$/m);
      const visibleStdout = rawStdout
        .replace(/^__LLMPROXY_VERSION__=.+$/m, "")
        .replace(/__LLMPROXY_RELEASE_NOTES_START__\n[\s\S]*?\n__LLMPROXY_RELEASE_NOTES_END__\n?/m, "")
        .replace(/^__LLMPROXY_SERVICE_RESTART_WARNING__=.+$/m, "")
        .replace(/^__LLMPROXY_ROLLBACK__=.+$/m, "")
        .replace(/^__LLMPROXY_ROLLBACK_VERSION__=.+$/m, "")
        .replace(/^__LLMPROXY_ROLLBACK_REASON__=.+$/m, "")
        .trim();
      if (rollbackMatch?.[1] && rollbackMatch[1].trim() !== "0") {
        if (visibleStdout) stdout.write(`${visibleStdout}\n`);
        const restoredVersion = String(rollbackVersionMatch?.[1] || "").trim();
        const rollbackReason = String(rollbackReasonMatch?.[1] || "").trim();
        const prefix = locale === "en"
          ? "Update failed after installation. The previous version has been restored."
          : "Aggiornamento fallito dopo l'installazione. La versione precedente e' stata ripristinata.";
        stderr.write(`${prefix}\n`);
        if (rollbackReason) {
          stderr.write(`${locale === "en" ? "Rollback reason" : "Motivo rollback"}: ${rollbackReason}\n`);
        }
        if (restoredVersion) {
          stderr.write(`${locale === "en" ? "Restored version" : "Versione ripristinata"}: ${restoredVersion}\n`);
        }
        return 1;
      }
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
    const commandRunner = options.commandRunner || spawnSync;

    serviceManager.stop();

    const serviceFile = targetPlatform === "darwin"
      ? paths.launchAgentFile
      : targetPlatform === "win32"
        ? paths.serviceRunnerFile
        : paths.systemdUnitFile;
    try { fs.unlinkSync(serviceFile); } catch { /* ignore if missing */ }

    // On Windows, also delete the Windows service via sc.exe
    if (targetPlatform === "win32") {
      try {
        spawnSync("sc.exe", ["delete", "llmproxy"], { encoding: "utf8", shell: true });
      } catch { /* ignore */ }
    }

    if (isDockerManagedRuntime(env, paths, targetPlatform)) {
      const composeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(paths.packageRoot, "docker-compose.production.yml")).trim();
      const composeEnv = resolveServiceEnvironment({ env, paths, dockerComposeFile: composeFile });
      const spawnOptions = { env: { ...process.env, ...composeEnv } };
      runDockerCompose(commandRunner, composeFile, ["down", "--remove-orphans"], { spawnOptions });
    }

    try { fs.rmSync(paths.dataRoot, { recursive: true, force: true }); } catch { /* ignore */ }

    const result = targetPlatform === "win32"
      ? runSelfUninstallWindows(commandRunner)
      : runSelfUninstall(commandRunner);
    if (result?.status === 0) {
      stdout.write("Disinstallazione completata.\n");
      return 0;
    }
    stderr.write((result?.stderr && String(result.stderr).trim()) || "Disinstallazione fallita.\n");
    return 1;
  }

  if (parsed.command === "login") {
    stdout.write("Warning: `llmproxy login` e' un alias legacy. Usa `llmproxy provider:add copilot`.\n");
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
    const freeModelFlag = parsed.flags["free-model"];
    const visionEnabled = visionFlag === "true" || visionFlag === true;
    const visionDisabled = visionFlag === "false" || visionFlag === false;
    const proxyUrlRaw = String(parsed.flags.proxy || "").trim();
    const proxyApiKey = String(parsed.flags["proxy-key"] || "").trim();
    if (!providerId) {
      stderr.write("Provider id richiesto. Uso: llmproxy provider:add <id> --api-key <key> --model <model> --vision <true|false> [--name <name>] [--plan <plan>] [--proxy <url>] [--proxy-key <key>]\n");
      return 1;
    }

    const providerInfo = getKnownProvider(providerId);
    if (!providerInfo.auth) {
      stderr.write(`Provider non supportato: ${providerId}. Esempi: copilot, openrouter, kimi, qwen, z.ai, opencode, opencode-go\n`);
      return 1;
    }

    if (providerInfo.auth === "api_key") {
      if (!apiKey) {
        stderr.write(`Il provider ${providerId} richiede --api-key. Uso: llmproxy provider:add ${providerId} --api-key <key> --model <model> --vision <true|false> [--proxy <url>] [--proxy-key <key>]\n`);
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
      const freeModel = parseOptionalBooleanFlag(freeModelFlag, { defaultValue: false, allowBareTrue: true });
      if (freeModel === null) {
        stderr.write(`--free-model deve essere 'true' oppure 'false'. Valore ricevuto: '${freeModelFlag}'\n`);
        return 1;
      }
      const proxyUrl = (proxyUrlRaw || proxyApiKey) ? buildProxyAgentUrl(proxyUrlRaw, proxyApiKey) : "";
      const probe = await probeApiKeyProviderModel({ provider: { provider: providerId, endpoint_variant: endpointVariant }, apiKey, model: defaultModel, fetchFn, proxyUrl });
      if (!probe.ok) {
        stderr.write(`Test provider fallito per ${providerId}/${defaultModel}: ${probe.status || "network"} ${probe.error || ""}\n`);
        return 1;
      }
      const allProviders = providerStore.listProviders();
      const sameKindProviders = allProviders.filter((p) => String(p.provider || "").toLowerCase() === providerId);
      const existingWithSameModel = sameKindProviders.find((p) => p.default_model === defaultModel);
      const instanceId = existingWithSameModel
        ? existingWithSameModel.id
        : (sameKindProviders.length > 0 ? defaultModel : providerId);

      providerStore.saveProvider(instanceId, {
        access_token: apiKey,
        token_type: "api_key",
        scope: "api_key",
        provider: providerId,
        auth_type: "api_key",
        default_model: defaultModel,
        endpoint_variant: endpointVariant,
        vision: visionEnabled,
        free_model: freeModel,
        proxy_url: proxyUrl || undefined,
        proxy_api_key: proxyApiKey || undefined,
      }, { name: providerName || providerId });
      const planSuffix = providerId === "qwen" ? `, plan: ${formatQwenPlanLabel(endpointVariant)}` : "";
      stdout.write(`Provider configurato con API key: ${instanceId} (default model: ${defaultModel}, vision: ${visionEnabled}, free: ${freeModel}${planSuffix}).\n`);
      return 0;
    }

    const deviceData = await startDeviceFlow({ fetchFn });
    stdout.write(`Apri ${deviceData.verification_uri} e inserisci il codice ${deviceData.user_code}\n`);
    const result = await pollForToken(deviceData.device_code, deviceData.interval || 5, {
      fetchFn,
      sleep,
      store: {
        save(data) {
          return providerStore.saveProvider(providerId, {
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
    const freeModelFlag = parsed.flags["free-model"];
    if (!providerId || !apiKey) {
      stderr.write("Uso: llmproxy provider:key <id> --api-key <key> [--model <model>] [--vision <true|false>] [--free-model <true|false>] [--plan <plan>]\n");
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

    let existing = providerStore.getProvider(providerId);
    if (!existing && defaultModel) {
      const allProviders = providerStore.listProviders();
      existing = allProviders.find((p) => String(p.provider || "").toLowerCase() === providerId && p.default_model === defaultModel) || null;
    }
    const effectiveId = existing ? existing.id : providerId;
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
    let nextFreeModel = existing?.free_model;
    if (freeModelFlag !== undefined && freeModelFlag !== null && freeModelFlag !== "") {
      nextFreeModel = parseOptionalBooleanFlag(freeModelFlag, { defaultValue: null, allowBareTrue: true });
      if (nextFreeModel === null) {
        stderr.write(`--free-model deve essere 'true' oppure 'false'. Valore ricevuto: '${freeModelFlag}'\n`);
        return 1;
      }
    }
    const probe = await probeApiKeyProviderModel({ provider: { provider: providerId, endpoint_variant: endpointVariant }, apiKey, model: nextDefaultModel, fetchFn });
    if (!probe.ok) {
      stderr.write(`Test provider fallito per ${providerId}/${nextDefaultModel}: ${probe.status || "network"} ${probe.error || ""}\n`);
      return 1;
    }
    providerStore.saveProvider(effectiveId, {
      ...(existing || {}),
      access_token: apiKey,
      token_type: "api_key",
      scope: "api_key",
      provider: providerId,
      auth_type: "api_key",
      default_model: nextDefaultModel,
      endpoint_variant: endpointVariant,
      vision: nextVision,
      free_model: nextFreeModel,
    }, { name: existing?.name || providerInfo.displayName || providerId });

    const planSuffix = providerId === "qwen" ? `, plan: ${formatQwenPlanLabel(endpointVariant)}` : "";
    const visionSuffix = nextVision !== undefined ? `, vision: ${nextVision}` : "";
    const freeModelSuffix = nextFreeModel !== undefined ? `, free: ${nextFreeModel}` : "";
    stdout.write(`API key aggiornata per provider ${effectiveId} (default model: ${nextDefaultModel}${visionSuffix}${freeModelSuffix}${planSuffix}).\n`);
    return 0;
  }

  if (parsed.command === "provider:list") {
    const providers = providerStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato.\n");
      return 0;
    }
    const projectSettings = resolveClaudeProjectSettings(path.resolve(String(options.cwd || process.cwd())));
    const effectiveProviders = resolveEffectiveProviderList(providers, projectSettings.configuredModel);
    const creditCache = new Map();
    const priceCache = new Map();
    const codingCache = new Map();
    const providersWithCredit = await Promise.all(
      effectiveProviders.providers.map(async (provider) => ({
        ...provider,
        coding_info: await fetchProviderCodingInfo(provider, fetchFn, codingCache),
        credit_info: await fetchProviderCreditInfo(provider, fetchFn, creditCache),
        price_info: await fetchProviderPriceInfo(provider, fetchFn, priceCache),
      })),
    );
    if (effectiveProviders.projectOverrideActive) {
      stdout.write(`Provider effettivi per il progetto (override: ${effectiveProviders.configuredModel}):\n`);
    }
    stdout.write(`${formatProviderList(providersWithCredit, { stdout, env })}\n`);
    return 0;
  }

  if (parsed.command === "provider:test") {
    const providers = providerStore.listProviders();
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
    const providers = providerStore.listProviders();
    if (providers.length === 0) {
      stdout.write("Nessun provider configurato.\n");
      return 0;
    }
    stdout.write(`${formatProviderStatus(providers)}\n`);
    return 0;
  }

  if (parsed.command === "provider:usage") {
    try {
      const meteringSink = createJsonlMeteringSink({ filePath: paths.meteringFile });
      const allRecords = meteringSink.query({ filters: {}, limit: 1000, offset: 0, order: "desc" }).records;

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

      function filterByPeriod(records, from) {
        return records.filter((r) => r.timestamp >= from);
      }

      function computePeriodStats(records) {
        const byProvider = {};
        const byModel = {};
        let totalInput = 0;
        let totalOutput = 0;
        let totalRequests = 0;

        for (const r of records) {
          if (r.success === false) continue;
          totalRequests++;
          const input = Number(r.tokens_input || r.prompt_tokens || 0);
          const output = Number(r.tokens_output || r.completion_tokens || 0);
          totalInput += input;
          totalOutput += output;

          const provider = r.provider || "unknown";
          if (!byProvider[provider]) byProvider[provider] = { requests: 0, input: 0, output: 0 };
          byProvider[provider].requests++;
          byProvider[provider].input += input;
          byProvider[provider].output += output;

          const model = r.model_used || "unknown";
          if (!byModel[model]) byModel[model] = { requests: 0, input: 0, output: 0 };
          byModel[model].requests++;
          byModel[model].input += input;
          byModel[model].output += output;
        }

        return { totalRequests, totalInput, totalOutput, byProvider, byModel };
      }

      const todayRecords = filterByPeriod(allRecords, todayStart);
      const weekRecords = filterByPeriod(allRecords, weekStart);
      const monthRecords = filterByPeriod(allRecords, monthStart);

      const todayStats = computePeriodStats(todayRecords);
      const weekStats = computePeriodStats(weekRecords);
      const monthStats = computePeriodStats(monthRecords);

      function formatPeriodStats(label, stats) {
        const lines = [
          `\n${label}:`,
          `  Requests: ${stats.totalRequests} | Tokens: ${stats.totalInput + stats.totalOutput} (in: ${stats.totalInput}, out: ${stats.totalOutput})`,
        ];

        const providers = Object.entries(stats.byProvider).sort((a, b) => b[1].requests - a[1].requests);
        if (providers.length > 0) {
          lines.push(`  Per provider:`);
          for (const [provider, data] of providers) {
            lines.push(`    - ${provider}: ${data.requests} req, ${data.input + data.output} tokens (in: ${data.input}, out: ${data.output})`);
          }
        }

        const models = Object.entries(stats.byModel).sort((a, b) => b[1].requests - a[1].requests);
        if (models.length > 0) {
          lines.push(`  Per modello:`);
          for (const [model, data] of models.slice(0, 10)) {
            lines.push(`    - ${model}: ${data.requests} req, ${data.input + data.output} tokens`);
          }
          if (models.length > 10) {
            lines.push(`    ... e altri ${models.length - 10} modelli`);
          }
        }

        return lines.join("\n");
      }

      stdout.write("Consumo token per periodo:\n");
      stdout.write(formatPeriodStats("Oggi (dalle 00:00)", todayStats));
      stdout.write(formatPeriodStats("Ultimi 7 giorni", weekStats));
      stdout.write(formatPeriodStats("Ultimi 30 giorni", monthStats));
      stdout.write("\n");

      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "provider:order") {
    const providerId = String(parsed.args[0] || "").trim();
    const position = Number(parsed.args[1] || 0);
    if (!providerId || !Number.isFinite(position) || position <= 0) {
      stderr.write("Uso: llmproxy provider:order <id> <position>\n");
      return 1;
    }
    try {
      const providers = providerStore.moveProvider(providerId, position);
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
      const provider = providerStore.renameProvider(providerId, nextName);
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
    providerStore.clearProvider(providerId);
    stdout.write(`Provider rimosso: ${providerId}\n`);
    return 0;
  }

  if (parsed.command === "logout") {
    tokenStore.clear();
    stdout.write("Token Copilot rimosso.\n");
    return 0;
  }

  if (parsed.command === "stop") {
    try {
      return stopForegroundDevInstance({
        paths,
        stdout,
        stderr,
        execCommand: options.execCommand,
        killProcess: options.killProcess,
      });
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
  }

  if (parsed.command === "run") {
    const cleanupForegroundState = () => removeForegroundRunState(paths.foregroundRunPidFile);
    const { host, port } = await startServer({
      dataRoot: paths.dataRoot,
      packageRoot: paths.packageRoot,
      env,
      host: "127.0.0.1",
      port: 5045,
    });
    writeForegroundRunState(paths.foregroundRunPidFile, {
      pid: process.pid,
      host,
      port,
      startedAt: new Date().toISOString(),
    });
    process.once("exit", cleanupForegroundState);
    process.once("SIGTERM", cleanupForegroundState);
    process.once("SIGINT", cleanupForegroundState);
    stdout.write(`llmProxy in ascolto su http://${host}:${port}\n`);
    return new Promise(() => {});
  }

  if (parsed.command === "status") {
    const commandRunner = options.commandRunner || spawnSync;
    const managedStatus = getManagedServiceStatus({
      commandRunner,
      env,
      paths,
      targetPlatform,
      serviceManager,
    });
    const status = managedStatus.status;
    const providers = providerStore.listProviders();
    stdout.write(`Service manager: ${managedStatus.kind}\n`);
    stdout.write(`Service active: ${status.active ? "yes" : "no"}\n`);
    stdout.write(`Providers configurati: ${providers.length}\n`);
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
      const composeFile = String(env.LLMPROXY_DOCKER_COMPOSE_FILE || path.join(paths.packageRoot, "docker-compose.production.yml")).trim();
      const composeEnv = resolveServiceEnvironment({ env, paths, dockerComposeFile: composeFile });
      const spawnOptions = { env: { ...process.env, ...composeEnv } };
      stdout.write(`\nDocker containers (${path.basename(composeFile)}):\n`);
      const dockerCompose = resolveDockerComposeCommand(spawnSync, { spawnOptions });
      if (!dockerCompose.dockerAvailable) {
        stderr.write("Docker non disponibile nel PATH.\n");
      } else if (!dockerCompose.ok) {
        stderr.write("Docker Compose non disponibile (`docker compose` e `docker-compose` falliscono).\n");
      } else {
        const dockerResult = runDockerCompose(spawnSync, composeFile, ["ps", "--format", "table"], { invocation: dockerCompose, spawnOptions });
        if (dockerResult.status !== 0) {
          stderr.write(dockerResult.stderr || `Errore ${dockerCompose.label} ps.\n`);
        } else {
          stdout.write(dockerResult.stdout || "(nessun container trovato)\n");
        }
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

  if (parsed.command === "stats:reset") {
    try {
      const truncated = [];
      // 1) Metering records
      if (fs.existsSync(paths.meteringFile)) {
        fs.writeFileSync(paths.meteringFile, "", "utf8");
        truncated.push("metering");
      }
      if (truncated.length === 0) {
        stdout.write("Nessun file di statistiche trovato. Nessuna azione necessaria.\n");
      } else {
        stdout.write(`Statistiche azzerate: ${truncated.join(", ")}.\n`);
      }
      return 0;
    } catch (error) {
      stderr.write(`Errore: ${error.message}\n`);
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
    persistServiceEnvironmentConfig(paths.serviceConfigFile, serviceManagerOptions.environment);
    const commandRunner = options.commandRunner || spawnSync;
    const dockerRuntimeCheck = ensureDockerServiceRunning({
      commandRunner,
      env,
      paths,
      targetPlatform,
    });
    if (!dockerRuntimeCheck.ok) {
      stderr.write(`${dockerRuntimeCheck.error}\n`);
      return 1;
    }
    const proxyBaseUrl = getProxyBaseUrl({ env, dataRoot: paths.dataRoot });
    const healthResult = await waitForLocalProxyHealth({
      fetchFn,
      baseUrl: proxyBaseUrl,
      sleepFn: sleep,
    });
    if (!healthResult.ok) {
      stderr.write(`Health check fallito dopo l'avvio del servizio: ${healthResult.error}\n`);
      return 1;
    }
    stdout.write(`Servizio installato con ${serviceManager.kind}.\n`);
    stdout.write(`stdout: ${result.stdoutPath}\n`);
    stdout.write(`stderr: ${result.stderrPath}\n`);
    if (dockerRuntimeCheck.checked) {
      stdout.write(`Runtime Docker: ${dockerRuntimeCheck.restarted ? "container ricreato" : "container gia' attivo"}.\n`);
    }
    stdout.write(`Health check OK: ${proxyBaseUrl}/health\n`);
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
    const commandRunner = options.commandRunner || spawnSync;

    if (serviceManager.kind === "launchd" || serviceManager.kind === "windows") {
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
    persistServiceEnvironmentConfig(paths.serviceConfigFile, serviceManagerOptions.environment);

    const dockerRuntimeCheck = ensureDockerServiceRunning({
      commandRunner,
      env,
      paths,
      targetPlatform,
    });
    if (!dockerRuntimeCheck.ok) {
      stderr.write(`${dockerRuntimeCheck.error}\n`);
      return 1;
    }

    const proxyBaseUrl = getProxyBaseUrl({ env, dataRoot: paths.dataRoot });
    const healthResult = await waitForLocalProxyHealth({
      fetchFn,
      baseUrl: proxyBaseUrl,
      sleepFn: sleep,
    });
    if (!healthResult.ok) {
      stderr.write(`Health check fallito dopo il restart: ${healthResult.error}\n`);
      return 1;
    }

    stdout.write("Servizio riavviato.\n");
    if (dockerRuntimeCheck.checked) {
      stdout.write(`Runtime Docker: ${dockerRuntimeCheck.restarted ? "container ricreato" : "container gia' attivo"}.\n`);
    }
    stdout.write(`Health check OK: ${proxyBaseUrl}/health\n`);
    return 0;
  }

  if (parsed.command === "service:runtime") {
    try {
      const targetRuntime = normalizeServiceRuntimeTarget(parsed.args[0], targetPlatform);
      if (!targetRuntime) {
        throw new Error("Uso: llmproxy service:runtime <docker|native|launchd|systemd>");
      }

      const commandRunner = options.commandRunner || spawnSync;
      const runtimeProfile = normalizeRuntimeProfile(
        env.LLMPROXY_RUNTIME_PROFILE || env.LLMPROXY_ENV || env.NODE_ENV || "production",
      ) || "production";
      const targetEnv = {
        ...env,
        LLMPROXY_SERVICE_RUNTIME: targetRuntime,
        LLMPROXY_RUNTIME_PROFILE: runtimeProfile,
        LLMPROXY_ENV: runtimeProfile,
        NODE_ENV: runtimeProfile,
      };
      const targetOptions = resolveCliServiceManagerOptions({ env: targetEnv, paths, targetPlatform });
      const targetManager = targetRuntime === "native" && options.serviceManager
        ? options.serviceManager
        : createServiceManager(targetOptions);

      if (targetRuntime === "docker") {
        removeNativeServiceArtifacts({ targetPlatform, paths, env, managerOverride: serviceManager });
        removeDockerRuntime({ commandRunner, env: targetEnv, paths });
        persistServiceEnvironmentConfig(paths.serviceConfigFile, targetOptions.environment);
        const dockerRuntimeCheck = ensureDockerServiceRunning({
          commandRunner,
          env: targetEnv,
          paths,
          targetPlatform,
        });
        if (!dockerRuntimeCheck.ok) {
          stderr.write(`${dockerRuntimeCheck.error}\n`);
          return 1;
        }
      } else {
        removeDockerRuntime({ commandRunner, env: targetEnv, paths });
        const result = typeof targetManager.install === "function"
          ? targetManager.install()
          : targetManager.start();
        if (!result.ok) {
          stderr.write((result.stderr && String(result.stderr).trim()) || "Installazione servizio fallita.\n");
          return 1;
        }
        persistServiceEnvironmentConfig(paths.serviceConfigFile, targetOptions.environment);
      }

      const proxyBaseUrl = getProxyBaseUrl({ env: targetEnv, dataRoot: paths.dataRoot });
      const healthResult = await waitForLocalProxyHealth({
        fetchFn,
        baseUrl: proxyBaseUrl,
        sleepFn: sleep,
      });
      if (!healthResult.ok) {
        stderr.write(`Health check fallito dopo il cambio runtime: ${healthResult.error}\n`);
        return 1;
      }

      stdout.write(`Runtime attivo: ${targetRuntime}\n`);
      stdout.write(`Health check OK: ${proxyBaseUrl}/health\n`);
      return 0;
    } catch (error) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
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
  runSelfUpdateWindows,
  runSelfUninstall,
  runSelfUninstallWindows,
  buildPersistentInstallScript,
  runPersistentInstall,
  resolveServiceEntryFile,
  resolveServiceEnvironment,
  resolveCliServiceManagerOptions,
};
