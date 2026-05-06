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
const { probeApiKeyProviderModel } = require("./copilot-proxy");
const { loadRuntimeEnv } = require("./runtime-env");

const KNOWN_PROVIDERS = {
  copilot: { auth: "oauth", displayName: "GitHub Copilot" },
  openrouter: { auth: "api_key", displayName: "OpenRouter" },
  "z.ai": { auth: "api_key", displayName: "Z.AI" },
  zai: { auth: "api_key", displayName: "Z.AI" },
  kimi: { auth: "api_key", displayName: "Kimi (Moonshot)" },
  openai: { auth: "api_key", displayName: "OpenAI" },
  anthropic: { auth: "api_key", displayName: "Anthropic" },
  deepseek: { auth: "api_key", displayName: "DeepSeek" },
  groq: { auth: "api_key", displayName: "Groq" },
  mistral: { auth: "api_key", displayName: "Mistral" },
  xai: { auth: "api_key", displayName: "xAI" },
  perplexity: { auth: "api_key", displayName: "Perplexity" },
  together: { auth: "api_key", displayName: "Together" },
  fireworks: { auth: "api_key", displayName: "Fireworks" },
};

const RELEASE_NOTES = {
  "0.2.54": [
    "Rete provider: retry automatico su errori transienti di socket chiuso (es. 'The socket connection was closed unexpectedly').",
    "Maggiore resilienza: ridotti i falsi 502 su disconnessioni brevi upstream.",
  ],
  "0.2.53": [
    "Update output: stampa il changelog della versione installata.",
    "Self-update: se rileva il container Docker persistente in esecuzione, esegue rebuild+recreate (docker compose up -d --build llmproxy).",
    "Event Bus (modulo 48): pubblicazione evento llmproxy.call.completed per ogni richiesta LLM.",
  ],
  "0.2.52": [
    "Event Bus (modulo 48): pubblicazione evento llmproxy.call.completed per ogni richiesta LLM.",
    "Nuovo sink Event Bus configurabile con EVENTBUS_URL (5048 dev, 6048 staging, 7048 prod).",
  ],
};

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
  llmproxy logs [--follow]                 legge i log recenti; usa --follow per seguire il flusso in tempo reale

Servizio persistente:
  llmproxy service:start                   installa e avvia il servizio utente persistente; usalo per avere il proxy attivo dopo il reboot
  llmproxy service:stop                    ferma il servizio persistente
  llmproxy service:restart                 riavvia il servizio persistente dopo modifiche o update

Provider Copilot:
  llmproxy provider:add <id> [--name <name>] [--api-key <key>] aggiunge un provider noto (Copilot via login; gli altri via API key)
  llmproxy provider:key <id> --api-key <key> aggiorna/imposta la API key per provider API-key (openrouter, kimi, z.ai, ...)
  llmproxy provider:list                   elenca i provider configurati nell'ordine di fallback
  llmproxy provider:status                 mostra quale provider e' attivo in questo momento
  llmproxy provider:order <id> <position>  cambia la priorita' di fallback di un provider
  llmproxy provider:rename <id> <name>     rinomina un provider per distinguerlo meglio
  llmproxy provider:remove <id>            rimuove un provider configurato

Provider noti:
  copilot, openrouter, z.ai (zai), kimi, openai, anthropic, deepseek, groq, mistral, xai, perplexity, together, fireworks

Modelli e Claude Code:
  llmproxy models:list                     mostra i modelli disponibili in forma numerata; usalo prima di configurare Claude
  llmproxy model:set <model>               aggiorna il modello del progetto con un valore grezzo (es. deepseek:deepseek-v4-flash)
  llmproxy test                            esegue un test rapido di inferenza contro il proxy locale
  llmproxy claude:setup [--model <indice>] scrive .claude/settings.json per usare llmproxy come backend locale

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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function formatProviderList(providers) {
  return providers.map((provider, index) => `${index + 1}. ${provider.id} (${provider.name})`).join("\n");
}

function formatProviderStatus(providers) {
  const activeProviderId = providers[0]?.id || "none";
  const lines = [`Active provider: ${activeProviderId}`];
  providers.forEach((provider, index) => {
    const activeSuffix = index === 0 ? " [active]" : "";
    const defaultModel = provider.default_model || (provider.provider === "copilot" ? DEFAULT_COPILOT_MODEL : "");
    const state = provider.access_token && (provider.provider === "copilot" || defaultModel) ? "configured" : "incomplete";
    const modelSuffix = defaultModel ? ` model=${defaultModel}` : " model=missing";
    lines.push(`${index + 1}. ${provider.id} (${provider.name})${activeSuffix} provider=${provider.provider || "copilot"} auth=${provider.auth_type || "oauth"} state=${state}${modelSuffix}`);
  });
  return lines.join("\n");
}

function formatModelList(models) {
  return models.map((model, index) => `${index + 1}. ${model}`).join("\n");
}

function formatReleaseNotes(version) {
  const notes = RELEASE_NOTES[String(version || "").trim()] || [];
  if (!notes.length) return "";
  const lines = [`Changelog ${version}:`];
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

function runSelfUpdate(commandRunner = spawnSync, repo = "alessiobacin/llmProxy") {
  const script = [
    "set -e",
    "tmpdir=$(mktemp -d)",
    "cleanup() { rm -rf \"$tmpdir\"; }",
    "trap cleanup EXIT",
    "existing_bins=$(which -a llmproxy 2>/dev/null | awk '!seen[$0]++')",
    `gh repo clone ${repo} \"$tmpdir/repo\" -- --depth=1 >/dev/null`,
    'cd "$tmpdir/repo"',
    'pnpm pack --pack-destination "$tmpdir" >/dev/null',
    'package_file=$(find "$tmpdir" -maxdepth 1 -name "*.tgz" -print | head -n 1)',
    '[ -n "$package_file" ]',
    'if ! npm install -g "$package_file"; then',
    '  if command -v sudo >/dev/null 2>&1; then',
    '    sudo npm install -g "$package_file"',
    '  else',
    '    exit 1',
    '  fi',
    'fi',
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy" >/dev/null 2>&1 || true',
    'fi',
    'npm_prefix=$(npm prefix -g)',
    'new_bin="$npm_prefix/bin/llmproxy"',
    '[ -x "$new_bin" ]',
    'for installed_bin in $existing_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$new_bin" ]; then',
    '    rm -f "$installed_bin" >/dev/null 2>&1 || true',
    '  fi',
    'done',
    '"$new_bin" service:restart >/dev/null',
    'docker_compose_file="$npm_prefix/lib/node_modules/llmproxy/docker-compose.production.yml"',
    'if command -v docker >/dev/null 2>&1 && [ -f "$docker_compose_file" ]; then',
    '  if docker compose -f "$docker_compose_file" ps --services --status running 2>/dev/null | grep -qx "llmproxy"; then',
    '    docker compose -f "$docker_compose_file" up -d --build llmproxy >/dev/null || true',
    '  fi',
    'fi',
    'version_output=$("$new_bin" version)',
    'printf "__LLMPROXY_VERSION__=%s\\n" "$version_output"',
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
    'for installed_bin in $existing_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$global_bin" ]; then',
    '    rm -f "$installed_bin"',
    '  fi',
    'done',
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

function getProxyBaseUrl(env = process.env) {
  const host = String(env.HOST || "127.0.0.1");
  const port = String(env.PORT || 7045);
  return `http://${host}:${port}`;
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

  const proxyEnv = {
    ANTHROPIC_AUTH_TOKEN: "proxy-local",
    ANTHROPIC_BASE_URL: getProxyBaseUrl(env),
    ANTHROPIC_DEFAULT_MODEL: selectedModel,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };

  const nextConfig = {
    ...existingConfig,
    model: selectedModel,
    env: {
      ...(existingConfig.env && typeof existingConfig.env === "object" ? existingConfig.env : {}),
      ...proxyEnv,
    },
  };

  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  stdout.write(`Configurazione Claude scritta in ${settingsFile}\n`);
  stdout.write(`ANTHROPIC_BASE_URL: ${proxyEnv.ANTHROPIC_BASE_URL}\n`);
  stdout.write(`Default model: ${proxyEnv.ANTHROPIC_DEFAULT_MODEL}\n`);
  return 0;
}

function configureClaudeSettings(options = {}) {
  const defaultModel = resolveDefaultModel(options.model, options.availableModels);
  return writeClaudeSettings({
    cwd: options.cwd,
    env: options.env,
    stdout: options.stdout,
    model: defaultModel,
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
  const dockerComposeFile = path.join(paths.packageRoot, "docker-compose.production.yml");
  const serviceManager = options.serviceManager || createServiceManager({
    platform: targetPlatform,
    packageRoot: paths.packageRoot,
    entryFile: path.join(paths.packageRoot, "lib", "service", "docker-launchd-entry.js"),
    serviceFile: targetPlatform === "darwin" ? paths.launchAgentFile : paths.systemdUnitFile,
    stdoutPath: paths.stdoutLogFile,
    stderrPath: paths.stderrLogFile,
    environment: {
      PORT: "7045",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      LLMPROXY_ENV: "production",
      LLMPROXY_HOME: paths.dataRoot,
      LLMPROXY_MODE: "platform",
      LLMPROXY_METERING_SINK: "dblayer",
      DBLAYER_URL: "http://localhost:7046",
      LLMPROXY_LOG_RETENTION_DAYS: "30",
      LLMPROXY_DOCKER_COMPOSE_FILE: dockerComposeFile,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });

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
    const targets = providers.length > 0
      ? providers
      : [{ id: "auto", name: "auto", provider: "copilot", default_model: DEFAULT_COPILOT_MODEL }];
    let failures = 0;

    for (const provider of targets) {
      const model = provider.default_model || (String(provider.provider || "copilot") === "copilot" ? DEFAULT_COPILOT_MODEL : "");
      if (!model) {
        stdout.write(`${provider.id}: skipped (default model mancante)\n`);
        failures += 1;
        continue;
      }

      try {
      const response = await fetchFn(`${getProxyBaseUrl(env)}/v1/messages`, {
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
      });

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

      if (!assistantText) {
          stdout.write(`${provider.id}: fail risposta vuota (${model})\n`);
          failures += 1;
          continue;
      }

        stdout.write(`${provider.id}: ok (${model}) ${assistantText}\n`);
      } catch (error) {
        stdout.write(`${provider.id}: fail ${error.message} (${model})\n`);
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
      return configureClaudeSettings({ cwd: options.cwd, env, stdout, model: parsed.flags.model, availableModels: models });
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
    const result = runSelfUpdate(options.commandRunner);
    if (result?.status === 0) {
      const rawStdout = String(result.stdout || "");
      const versionMatch = rawStdout.match(/^__LLMPROXY_VERSION__=(.+)$/m);
      const visibleStdout = rawStdout
        .replace(/^__LLMPROXY_VERSION__=.+$/m, "")
        .trim();
      stdout.write("Aggiornamento completato.\n");
      if (visibleStdout) stdout.write(`${visibleStdout}\n`);
      if (versionMatch?.[1]) {
        const currentVersion = String(versionMatch[1]).trim();
        stdout.write(`Versione corrente: ${currentVersion}\n`);
        const releaseNotes = formatReleaseNotes(currentVersion);
        if (releaseNotes) stdout.write(`${releaseNotes}\n`);
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
    if (!providerId) {
      stderr.write("Provider id richiesto. Uso: llmproxy provider:add <id> [--name <name>] [--api-key <key>] [--model <model>]\n");
      return 1;
    }

    const providerInfo = getKnownProvider(providerId);
    if (!providerInfo.auth) {
      stderr.write(`Provider non supportato: ${providerId}. Esempi: copilot, openrouter, kimi, z.ai\n`);
      return 1;
    }

    if (providerInfo.auth === "api_key") {
      if (!apiKey) {
        stderr.write(`Il provider ${providerId} richiede --api-key. Uso: llmproxy provider:add ${providerId} --api-key <key> --model <model> [--name <name>]\n`);
        return 1;
      }
      if (!defaultModel) {
        stderr.write(`Il provider ${providerId} richiede --model per salvare e verificare il modello di default.\n`);
        return 1;
      }
      const probe = await probeApiKeyProviderModel({ provider: providerId, apiKey, model: defaultModel, fetchFn });
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
      }, { name: providerName || providerId });
      stdout.write(`Provider configurato con API key: ${providerId} (default model: ${defaultModel}).\n`);
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
    if (!providerId || !apiKey) {
      stderr.write("Uso: llmproxy provider:key <id> --api-key <key>\n");
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
    const nextDefaultModel = defaultModel || existing?.default_model || "";
    if (!nextDefaultModel) {
      stderr.write(`Il provider ${providerId} non ha un modello di default salvato. Usa --model <model>.\n`);
      return 1;
    }
    const probe = await probeApiKeyProviderModel({ provider: providerId, apiKey, model: nextDefaultModel, fetchFn });
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
    }, { name: existing?.name || providerInfo.displayName || providerId });

    stdout.write(`API key aggiornata per provider ${providerId} (default model: ${nextDefaultModel}).\n`);
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
    const { host, port } = await startServer({ dataRoot: paths.dataRoot, packageRoot: paths.packageRoot });
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
    serviceManager.stop();
    serviceManager.start();
    stdout.write("Servizio riavviato.\n");
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
  formatModelList,
  formatProviderList,
  formatProviderStatus,
  getProxyBaseUrl,
  resolveDefaultModel,
  runSelfUpdate,
  buildPersistentInstallScript,
  runPersistentInstall,
};
