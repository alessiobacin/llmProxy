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

function parseArgs(argv) {
  const tokens = Array.isArray(argv) ? argv.slice(2) : [];
  const args = [];
  const flags = {};

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

function printHelp(stdout = process.stdout) {
  stdout.write(`llmProxy CLI

Comandi principali:
  llmproxy help                            mostra questa guida con cosa fa ogni comando, quando usarlo e come invocarlo
  llmproxy setup                           verifica il runtime locale, il data root e il service manager selezionato
  llmproxy version                         mostra la versione corrente della CLI installata
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
  llmproxy provider:add <id> [--name <name>] aggiunge un account Copilot secondario per fallback
  llmproxy provider:list                   elenca i provider configurati nell'ordine di fallback
  llmproxy provider:status                 mostra quale provider e' attivo in questo momento
  llmproxy provider:order <id> <position>  cambia la priorita' di fallback di un provider
  llmproxy provider:rename <id> <name>     rinomina un provider per distinguerlo meglio
  llmproxy provider:remove <id>            rimuove un provider configurato

Modelli e Claude Code:
  llmproxy models:list                     mostra i modelli disponibili in forma numerata; usalo prima di configurare Claude
  llmproxy claude:setup [--model <indice>] scrive .claude/settings.json per usare llmproxy come backend locale

Quando usare cosa:
  1. Prima installazione: setup -> login -> models:list -> claude:setup
  2. Uso come servizio: service:start -> status -> logs
  3. Multi-account: provider:add -> provider:list -> provider:order
  4. Aggiornamento CLI: update
  5. Rimozione completa: uninstall
`);
}

function readPackageVersion(packageRoot) {
  const packageFile = path.join(packageRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  return String(pkg.version || "0.0.0");
}

function formatProviderList(providers) {
  return providers.map((provider, index) => `${index + 1}. ${provider.id} (${provider.name})`).join("\n");
}

function formatProviderStatus(providers) {
  const activeProviderId = providers[0]?.id || "none";
  const lines = [`Active provider: ${activeProviderId}`];
  providers.forEach((provider, index) => {
    const activeSuffix = index === 0 ? " [active]" : "";
    lines.push(`${index + 1}. ${provider.id} (${provider.name})${activeSuffix}`);
  });
  return lines.join("\n");
}

function formatModelList(models) {
  return models.map((model, index) => `${index + 1}. ${model}`).join("\n");
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
    'npm install -g "$package_file"',
    'pnpm remove -g llmproxy >/dev/null 2>&1 || true',
    'pnpm_root=$(pnpm root -g 2>/dev/null || true)',
    'if [ -n "$pnpm_root" ]; then',
    '  pnpm_home=$(dirname "$(dirname "$pnpm_root")")',
    '  rm -f "$pnpm_home/bin/llmproxy"',
    'fi',
    'npm_prefix=$(npm prefix -g)',
    'new_bin="$npm_prefix/bin/llmproxy"',
    '[ -x "$new_bin" ]',
    'for installed_bin in $existing_bins; do',
    '  if [ -n "$installed_bin" ] && [ "$installed_bin" != "$new_bin" ]; then',
    '    rm -f "$installed_bin"',
    '  fi',
    'done',
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
    '  rm -f "$pnpm_home/bin/llmproxy"',
    'fi',
  ].join("\n");
  return commandRunner("sh", ["-c", script], { encoding: "utf8" });
}

function getProxyBaseUrl(env = process.env) {
  const host = String(env.HOST || "127.0.0.1");
  const port = String(env.PORT || 4141);
  return `http://${host}:${port}`;
}

function configureClaudeSettings(options = {}) {
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const settingsDir = path.join(cwd, ".claude");
  const settingsFile = path.join(settingsDir, "settings.json");
  const defaultModel = resolveDefaultModel(options.model, options.availableModels);
  let existingConfig = {};

  if (fs.existsSync(settingsFile)) {
    existingConfig = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  }

  const proxyEnv = {
    ANTHROPIC_AUTH_TOKEN: "proxy-local",
    ANTHROPIC_BASE_URL: getProxyBaseUrl(env),
    ANTHROPIC_DEFAULT_MODEL: defaultModel,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };

  const nextConfig = {
    ...existingConfig,
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
  const env = options.env || process.env;
  const parsed = parseArgs(argv || process.argv);
  const paths = createPaths({ dataRoot: options.dataRoot, packageRoot: options.packageRoot, env, homeDir: options.homeDir, platform: options.platform || process.platform });
  ensureRuntimeDirs(paths);
  const tokenStore = options.tokenStore || createTokenStore({ filePath: paths.tokenFile });
  const modelCatalogStore = options.modelCatalogStore || createCopilotModelCatalogStore({ filePath: paths.modelCatalogFile });
  const serviceManager = options.serviceManager || createServiceManager({
    platform: options.platform || process.platform,
    packageRoot: paths.packageRoot,
    entryFile: path.join(paths.packageRoot, "server.js"),
    serviceFile: process.platform === "darwin" ? paths.launchAgentFile : paths.systemdUnitFile,
    stdoutPath: paths.stdoutLogFile,
    stderrPath: paths.stderrLogFile,
    environment: {
      PORT: String(env.PORT || 4141),
      HOST: String(env.HOST || "127.0.0.1"),
      LLMPROXY_HOME: paths.dataRoot,
    },
  });

  if (parsed.command === "help") {
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
        stdout.write(`Versione corrente: ${String(versionMatch[1]).trim()}\n`);
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
    const providerId = String(parsed.args[0] || "").trim();
    const providerName = String(parsed.flags.name || providerId || "").trim();
    if (!providerId) {
      stderr.write("Provider id richiesto. Uso: llmproxy provider:add <id> [--name <name>]\n");
      return 1;
    }

    const deviceData = await startDeviceFlow({ fetchFn });
    stdout.write(`Apri ${deviceData.verification_uri} e inserisci il codice ${deviceData.user_code}\n`);
    const result = await pollForToken(deviceData.device_code, deviceData.interval || 5, {
      fetchFn,
      sleep,
      store: {
        save(data) {
          return tokenStore.saveProvider(providerId, data, { name: providerName || providerId });
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
    }
    if (status.stdout) stdout.write(`${status.stdout}\n`);
    if (!status.ok && status.stderr) stderr.write(`${status.stderr}\n`);
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
    serviceManager.install();
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
  formatModelList,
  formatProviderList,
  formatProviderStatus,
  getProxyBaseUrl,
  resolveDefaultModel,
  runSelfUpdate,
};