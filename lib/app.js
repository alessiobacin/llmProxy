const express = require("express");
const crypto = require("node:crypto");
const { createPaths, ensureRuntimeDirs } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createRequestLogger } = require("./logger");
const { detectProjectContext, resolveProjectMetadata, resolveClaudeProjectSettings } = require("./project-context");
const { createCopilotEndpointPreferences } = require("./copilot-endpoint-preferences");
const { createCopilotModelCatalogStore } = require("./copilot-models");
const {
  executeGatewayRequest,
  resolveProviderSelection,
  parseProviderModelAtLabel,
  IMPLEMENTED_API_KEY_PROVIDERS,
} = require("./gateway/services/llm-transport");
const { resolveSupportedModel, translateRequest } = require("./openai-translate");
const {
  parseHierarchyContext,
  validateHierarchyContextForBilling,
  parseMeteringContext,
  resolveTraceId,
  resolveMode,
  buildHierarchyContextRequiredError,
  buildHierarchyContextInvalidError,
  isAdmin,
} = require("./platform-context");
const { createJsonlMeteringSink, computeMeteringStats } = require("./metering");
const { createEventBusSink } = require("./event-bus");
const { createProviderRegistry } = require("./provider-registry");
const { createSendGridNotifier } = require("./sendgrid-notifier");
const { openAIRequestToAnthropic, anthropicResponseToOpenAI } = require("./openai-format");
const { resolveProxyHostPort, resolveRuntimeProfile, resolveServiceUrlForProfile } = require("./runtime-env");
const { assertGlobalServicePortAccess, reapConflictingPortListeners } = require("./port-guard");
const { createProviderReordering, buildDefaultProbeFn, DEFAULT_REORDERING_FILE } = require("./provider-reordering");
const path = require("node:path");


function createWritableBuffer() {
  let output = "";
  return {
    write(chunk) {
      output += String(chunk);
    },
    toString() {
      return output;
    },
  };
}

function jsonFromCliResult(cliResult, command) {
  const success = cliResult.exitCode === 0;
  const status = success ? 200 : 400;
  return {
    status,
    payload: {
      success,
      exitCode: cliResult.exitCode,
      command,
      data: {
        output: cliResult.stdout,
        error: cliResult.stderr,
      },
      timestamp: new Date().toISOString(),
    },
  };
}

const SHORT_ANSWER_SYSTEM_TEXT = "Respond as briefly as possible. Prefer the minimum useful answer, ideally 1-3 short sentences or a very short bullet list. Skip preambles, repetition, and extra explanation unless explicitly requested.";
function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function appendSystemInstruction(system, instruction) {
  const text = String(instruction || "").trim();
  if (!text) return system;

  if (typeof system === "string") {
    return system.includes(text) ? system : `${text}\n\n${system}`.trim();
  }

  if (Array.isArray(system)) {
    const hasInstruction = system.some((block) => block?.type === "text" && String(block.text || "").includes(text));
    if (hasInstruction) return system;
    return [{ type: "text", text }, ...system];
  }

  return text;
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

function buildStaticAnthropicMessage(text, model = "llmproxy/system") {
  return {
    id: `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function sendAnthropicSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendStaticAnthropicMessage(res, text, options = {}) {
  const stream = options.stream === true;
  const model = String(options.model || "llmproxy/system").trim() || "llmproxy/system";
  const message = buildStaticAnthropicMessage(text, model);

  if (!stream) {
    res.json(message);
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  sendAnthropicSseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      content: [],
      model: message.model,
      stop_reason: null,
      stop_sequence: null,
      usage: message.usage,
    },
  });
  sendAnthropicSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sendAnthropicSseEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  sendAnthropicSseEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  sendAnthropicSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: message.usage,
  });
  sendAnthropicSseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function createApp(options = {}) {
  const paths = createPaths({ dataRoot: options.dataRoot, packageRoot: options.packageRoot });
  ensureRuntimeDirs(paths);
  const runtimeEnv = options.env || process.env;

  const tokenStore = options.tokenStore || createTokenStore({ filePath: paths.tokenFile, secret: runtimeEnv.LLMPROXY_SECRET || null });
  const logger = options.logger || createRequestLogger({
    logsDir: paths.logsDir,
    retentionDays: Number(runtimeEnv.LLMPROXY_LOG_RETENTION_DAYS || 7),
    maxBytes: Number(runtimeEnv.LLMPROXY_LOG_MAX_BYTES || 5 * 1024 * 1024),
    maxArchivedFiles: Number(runtimeEnv.LLMPROXY_LOG_MAX_FILES || 5),
  });
  const mode = options.mode || resolveMode(runtimeEnv);
  const sendgridNotifier = createSendGridNotifier({
    apiKey: runtimeEnv.LLMPROXY_SENDGRID_API_KEY || runtimeEnv.SENDGRID_API_KEY,
    fromEmail: runtimeEnv.LLMPROXY_SENDGRID_FROM_EMAIL || runtimeEnv.SENDGRID_FROM_EMAIL,
    toEmail: runtimeEnv.LLMPROXY_SENDGRID_TO_EMAIL || runtimeEnv.SENDGRID_TO_EMAIL,
    messageTypes: Object.prototype.hasOwnProperty.call(runtimeEnv, "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE")
      ? runtimeEnv.LLMPROXY_SENDGRID_TO_MESSAGE_TYPE
      : Object.prototype.hasOwnProperty.call(runtimeEnv, "SENDGRID_TO_MESSAGE_TYPE")
        ? runtimeEnv.SENDGRID_TO_MESSAGE_TYPE
        : undefined,
  });
  const runtimeProfile = resolveRuntimeProfile({ env: runtimeEnv, packageRoot: paths.packageRoot });
  const dbLayerUrl = String(runtimeEnv.DBLAYER_URL || (runtimeProfile === "production"
    ? "http://localhost:7001"
    : runtimeProfile === "staging"
      ? "http://localhost:6001"
      : "http://localhost:5001")).trim();
  const eventBusUrl = resolveServiceUrlForProfile(
    String(runtimeEnv.EVENTBUS_URL || (runtimeProfile === "production"
      ? "http://localhost:7048"
      : runtimeProfile === "staging"
        ? "http://localhost:6048"
        : "http://localhost:5048")).trim(),
    runtimeProfile === "production" ? "7048" : runtimeProfile === "staging" ? "6048" : "5048",
  );
  const mongoConnectionString = String(runtimeEnv.LLMPROXY_MONGODB_CONNECTION_STRING || "").trim();
  let meteringSink = options.meteringSink;
  if (!meteringSink) {
    if (mode === "platform") {
      const localFallback = createJsonlMeteringSink({ filePath: paths.meteringFile });
      const { createDbLayerSink } = require("./metering-dblayer");
      meteringSink = createDbLayerSink({
        url: dbLayerUrl,
        fallbackSink: localFallback,
        fetchFn: options.fetchFn || fetch,
        notifier: sendgridNotifier,
      });
    } else if (mongoConnectionString) {
      const { createMongoMeteringSink } = require("./metering-db");
      meteringSink = createMongoMeteringSink({
        uri: mongoConnectionString,
        collectionName: "llmproxy_metering",
      });
    } else {
      meteringSink = createJsonlMeteringSink({ filePath: paths.meteringFile });
    }
  }
  const eventBusSink = options.eventBusSink || createEventBusSink({
    url: mode === "platform" ? eventBusUrl : "",
    fetchFn: options.fetchFn || fetch,
    notifier: sendgridNotifier,
  });
  const providerRegistry = options.providerRegistry || createProviderRegistry({
    filePath: paths.providerRegistryFile,
    secret: runtimeEnv.LLMPROXY_SECRET || null,
  });
  const endpointPreferences = createCopilotEndpointPreferences({ filePath: paths.endpointPreferencesFile });
  const modelCatalogStore = createCopilotModelCatalogStore({ filePath: paths.modelCatalogFile });
  const fetchFn = options.fetchFn || fetch;
  const serviceManager = options.serviceManager;
  const configuredProjectRoots = String(runtimeEnv.LLMPROXY_PROJECT_ROOTS || process.cwd())
    .split(path.delimiter)
    .map((root) => path.resolve(root.trim()))
    .filter(Boolean);
  const resolveRequestProjectPath = (value) => {
    const requested = String(value || "").trim();
    const projectPath = path.resolve(requested || process.cwd());
    if (runtimeProfile !== "production") return projectPath;
    const allowed = configuredProjectRoots.some((root) => projectPath === root || projectPath.startsWith(`${root}${path.sep}`));
    return allowed ? projectPath : null;
  };

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  app.use(express.json({ limit: "50mb" }));

  // Inbound API-key gate: protects llmproxy when exposed beyond loopback.
  // Production fails closed when the key is missing; health/logout stay open.
  const inboundApiKey = String(runtimeEnv.LLMPROXY_API_KEY || "").trim();
  const requiresInboundApiKey = Boolean(inboundApiKey) || runtimeProfile === "production";
  if (requiresInboundApiKey) {
    const PUBLIC_PATHS = new Set(["/health", "/auth/logout", "/v1/llm/health", "/v1/models"]);
    app.use((req, res, next) => {
      // /v1/models (+ single-model lookup) stays public per OpenAI convention:
      // client apps fetch the model catalog without credentials.
      const isPublicPath = PUBLIC_PATHS.has(req.path) || req.path.startsWith("/v1/models/");
      if (isPublicPath) return next();
      if (!inboundApiKey) {
        return res.status(503).json({ error: "SERVICE_MISCONFIGURED", message: "LLMPROXY_API_KEY non configurata." });
      }
      const bearer = String(req.headers.authorization || req.headers.Authorization || "").trim();
      const headerKey = String(req.headers["x-api-key"] || req.headers["X-API-Key"] || "").trim();
      const provided = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : headerKey;
      if (provided && provided === inboundApiKey) return next();
      return res.status(401).json({ error: "UNAUTHORIZED", message: "API key mancante o non valida." });
    });
  }

  // Mutable sink references for hot-reload
  const sinkRefs = { meteringSink, eventBusSink, sendgridNotifier };
  app.locals.sinkRefs = sinkRefs;

  app.locals.reconfigureSinks = function (envOverrides = {}) {
    if ("DBLAYER_URL" in envOverrides) {
      const newUrl = String(envOverrides.DBLAYER_URL || "").trim();
      sinkRefs.meteringSink.close().catch(() => {});
      if (mode === "platform" && newUrl) {
        const localFallback = createJsonlMeteringSink({ filePath: paths.meteringFile });
        const { createDbLayerSink } = require("./metering-dblayer");
        sinkRefs.meteringSink = createDbLayerSink({
          url: newUrl,
          fallbackSink: localFallback,
          fetchFn,
          notifier: sinkRefs.sendgridNotifier,
        });
      } else if (mode !== "platform" && mongoConnectionString) {
        const { createMongoMeteringSink } = require("./metering-db");
        sinkRefs.meteringSink = createMongoMeteringSink({
          uri: mongoConnectionString,
          collectionName: "llmproxy_metering",
        });
      } else {
        sinkRefs.meteringSink = createJsonlMeteringSink({ filePath: paths.meteringFile });
      }
    }
    if ("EVENTBUS_URL" in envOverrides) {
      const newUrl = String(envOverrides.EVENTBUS_URL || "").trim();
      sinkRefs.eventBusSink.close().catch(() => {});
      sinkRefs.eventBusSink = createEventBusSink({
        url: mode === "platform" ? newUrl : "",
        fetchFn,
        notifier: sinkRefs.sendgridNotifier,
      });
    }
    if ("LLMPROXY_SENDGRID_API_KEY" in envOverrides || "LLMPROXY_SENDGRID_FROM_EMAIL" in envOverrides || "LLMPROXY_SENDGRID_TO_EMAIL" in envOverrides || "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE" in envOverrides) {
      sinkRefs.sendgridNotifier.reconfigure({
        apiKey: envOverrides.LLMPROXY_SENDGRID_API_KEY,
        fromEmail: envOverrides.LLMPROXY_SENDGRID_FROM_EMAIL,
        toEmail: envOverrides.LLMPROXY_SENDGRID_TO_EMAIL,
        messageTypes: envOverrides.LLMPROXY_SENDGRID_TO_MESSAGE_TYPE,
      });
    }
  };

  function hasConfiguredProviders() {
    if (typeof tokenStore.getAccessToken === "function" && tokenStore.getAccessToken()) {
      return true;
    }
    if (providerRegistry && typeof providerRegistry.list === "function") {
      return providerRegistry.list({}).length > 0;
    }
    return false;
  }

  function listConfiguredProviderIds() {
    const localProviders = typeof tokenStore.listProviders === "function" ? tokenStore.listProviders() : [];
    if (localProviders.length > 0) {
      return localProviders.map((provider) => provider.id);
    }
    if (providerRegistry && typeof providerRegistry.list === "function") {
      return providerRegistry.list({}).map((entry) => entry.id);
    }
    return [];
  }

  // Inject a Warning header on every response when the db-layer sink is
  // configured but currently unreachable. Clients can detect this condition
  // and surface the information to operators.
  app.use((_req, res, next) => {
    if (sinkRefs.meteringSink && typeof sinkRefs.meteringSink.isAvailable === "function") {
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = function (statusCode, statusMessageOrHeaders, headers) {
        if (!sinkRefs.meteringSink.isAvailable()) {
          res.setHeader(
            "Warning",
            '199 llmproxy "db-layer not responding, metering stored locally"',
          );
        }
        return origWriteHead(statusCode, statusMessageOrHeaders, headers);
      };
    }
    next();
  });

  async function executeCliCommand(command, options = {}) {
    const { runCli } = require("./cli");
    const stdout = createWritableBuffer();
    const stderr = createWritableBuffer();
    const argv = ["node", "llmproxy", ...command];
    const exitCode = await runCli(argv, {
      stdout,
      stderr,
      fetchFn,
      dataRoot: paths.dataRoot,
      packageRoot: paths.packageRoot,
      tokenStore,
      serviceManager,
      modelCatalogStore,
      cwd: options.cwd,
      preferLocalExecution: true,
    });

    return {
      exitCode,
      stdout: stdout.toString().trim(),
      stderr: stderr.toString().trim(),
    };
  }

  // Health endpoint — available in all modes
  app.get("/health", (_req, res) => {
    res.json({ ok: true, authenticated: hasConfiguredProviders() });
  });

  app.get("/auth/status", (_req, res) => {
    res.json({ authenticated: hasConfiguredProviders() });
  });

  // =============================================================================
  // Standalone-only route surface (not registered in platform mode)
  // Local auth, CLI/REST control plane, and backward-compat gateway routes.
  // These are not part of the canonical V11 Module 45 gateway boundary.
  // =============================================================================

  if (mode !== "platform") {

  app.post("/auth/logout", (_req, res) => {
    tokenStore.clear();
    res.json({ ok: true });
  });

  app.get("/api/version", async (_req, res) => {
    const result = await executeCliCommand(["version"]);
    const response = jsonFromCliResult(result, "version");
    response.payload.data.version = result.stdout;
    res.status(response.status).json(response.payload);
  });

  app.get("/api/help", async (req, res) => {
    const command = String(req.query.command || "").trim();
    const args = command ? ["help", command] : ["help"];
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, command ? `help ${command}` : "help");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/setup", async (_req, res) => {
    const result = await executeCliCommand(["setup"]);
    const response = jsonFromCliResult(result, "setup");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/auth/login", async (_req, res) => {
    const result = await executeCliCommand(["provider:add", "copilot"]);
    const response = jsonFromCliResult(result, "provider:add copilot");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/auth/logout", async (_req, res) => {
    const result = await executeCliCommand(["logout"]);
    const response = jsonFromCliResult(result, "logout");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/service/status", async (_req, res) => {
    const result = await executeCliCommand(["status"]);
    const response = jsonFromCliResult(result, "status");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/service/start", async (_req, res) => {
    const result = await executeCliCommand(["service:start"]);
    const response = jsonFromCliResult(result, "service:start");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/service/stop", async (_req, res) => {
    const result = await executeCliCommand(["service:stop"]);
    const response = jsonFromCliResult(result, "service:stop");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/service/restart", async (_req, res) => {
    const result = await executeCliCommand(["service:restart"]);
    const response = jsonFromCliResult(result, "service:restart");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/service/runtime", async (req, res) => {
    const runtime = String(req.body?.runtime || "").trim();
    const result = await executeCliCommand(["service:runtime", runtime]);
    const response = jsonFromCliResult(result, `service:runtime ${runtime}`);
    res.status(response.status).json(response.payload);
  });

  app.get("/api/logs", async (req, res) => {
    if (String(req.query.follow || "") === "true") {
      return res.status(400).json({
        success: false,
        exitCode: 1,
        command: "logs --follow",
        data: {
          output: "",
          error: "`logs --follow` non e' supportato in polling JSON. Usa l'endpoint SSE dedicato quando disponibile.",
        },
        timestamp: new Date().toISOString(),
      });
    }

    const result = await executeCliCommand(["logs"]);
    const response = jsonFromCliResult(result, "logs");
    return res.status(response.status).json(response.payload);
  });

  app.get("/api/logs/stream", async (req, res) => {
    const rawInterval = Number(req.query.intervalMs || 1000);
    const intervalMs = Number.isFinite(rawInterval) ? Math.max(200, rawInterval) : 1000;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let lastPayloadKey = "";
    let closed = false;

    const writeSseEvent = (eventName, payload) => {
      if (closed) return;
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const streamLogs = async () => {
      try {
        const result = await executeCliCommand(["logs"]);
        const payloadKey = `${result.stdout}\n---\n${result.stderr}`;
        if (payloadKey !== lastPayloadKey) {
          lastPayloadKey = payloadKey;
          writeSseEvent("log", {
            output: result.stdout,
            error: result.stderr,
            exitCode: result.exitCode,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        writeSseEvent("error", {
          message: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    };

    writeSseEvent("ready", { intervalMs, timestamp: new Date().toISOString() });
    await streamLogs();

    const timer = setInterval(() => {
      streamLogs();
    }, intervalMs);

    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });

  app.get("/api/models", async (_req, res) => {
    const result = await executeCliCommand(["models:list"]);
    const response = jsonFromCliResult(result, "models:list");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/release-notes", async (req, res) => {
    const args = ["release-notes"];
    if (req.query.version) args.push("--version", String(req.query.version).trim());
    if (req.query.locale) args.push("--locale", String(req.query.locale).trim());
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, "release-notes");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/test", async (_req, res) => {
    const result = await executeCliCommand(["test"]);
    const response = jsonFromCliResult(result, "test");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/claude/setup", async (req, res) => {
    const model = String(req.body?.model || "").trim();
    const projectPath = String(req.body?.projectPath || req.headers["x-project-path"] || "").trim();
    const args = ["claude:setup"];
    if (model) {
      args.push("--model", model);
    }

    const result = await executeCliCommand(args, {
      cwd: projectPath || process.cwd(),
    });

    const response = jsonFromCliResult(result, "claude:setup");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/pi/setup", async (req, res) => {
    const projectPath = String(req.body?.projectPath || req.headers["x-project-path"] || "").trim();
    const result = await executeCliCommand(["pi:setup"], {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, "pi:setup");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/vscode/chat/setup", async (req, res) => {
    const projectPath = String(req.body?.projectPath || req.headers["x-project-path"] || "").trim();
    const result = await executeCliCommand(["vscode-chat:setup"], {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, "vscode-chat:setup");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/vscode/claude/setup", async (req, res) => {
    const model = String(req.body?.model || "").trim();
    const projectPath = String(req.body?.projectPath || req.headers["x-project-path"] || "").trim();
    const args = ["vscode-claude:setup"];
    if (model) args.push("--model", model);
    const result = await executeCliCommand(args, {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, "vscode-claude:setup");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/model/set", async (req, res) => {
    const model = String(req.body?.model || "").trim();
    const projectPath = String(req.body?.projectPath || req.headers["x-project-path"] || "").trim();
    const result = await executeCliCommand(["model:set", model], {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, "model:set");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/:id/login", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const providerName = String(req.body?.name || providerId).trim();
    const model = String(req.body?.model || req.body?.default_model || req.body?.defaultModel || "").trim();
    const plan = String(req.body?.plan || "").trim();
    const freeModel = req.body?.freeModel ?? req.body?.free_model;
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    if (model) args.push("--model", model);
    if (plan) args.push("--plan", plan);
    if (freeModel !== undefined) args.push("--free-model", String(freeModel));
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, `provider:add ${providerId}`);
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/:id/api-key", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const providerName = String(req.body?.name || providerId).trim();
    const apiKey = String(req.body?.apiKey || req.body?.api_key || "").trim();
    const model = String(req.body?.model || req.body?.default_model || req.body?.defaultModel || "").trim();
    const plan = String(req.body?.plan || "").trim();
    const vision = req.body?.vision !== undefined ? String(req.body.vision) : "true";
    const freeModel = req.body?.freeModel ?? req.body?.free_model;
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    if (apiKey) args.push("--api-key", apiKey);
    if (model) args.push("--model", model);
    if (plan) args.push("--plan", plan);
    args.push("--vision", vision);
    if (freeModel !== undefined) args.push("--free-model", String(freeModel));
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, `provider:add ${providerId} --api-key`);
    res.status(response.status).json(response.payload);
  });

  app.get("/api/providers", async (_req, res) => {
    const projectPath = String(_req.query.projectPath || _req.headers["x-project-path"] || "").trim();
    const result = await executeCliCommand(["provider:list"], {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, "provider:list");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/providers/available", async (_req, res) => {
    const result = await executeCliCommand(["provider:available"]);
    const response = jsonFromCliResult(result, "provider:available");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/providers/status", async (_req, res) => {
    const result = await executeCliCommand(["provider:status"]);
    const response = jsonFromCliResult(result, "provider:status");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/providers/usage", async (_req, res) => {
    const result = await executeCliCommand(["provider:usage"]);
    const response = jsonFromCliResult(result, "provider:usage");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/order", async (req, res) => {
    const providerId = String(req.body?.id || "").trim();
    const position = String(req.body?.position || "").trim();
    const result = await executeCliCommand(["provider:order", providerId, position]);
    const response = jsonFromCliResult(result, "provider:order");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/reorder", async (_req, res) => {
    const result = await executeCliCommand(["provider:reorder"]);
    const response = jsonFromCliResult(result, "provider:reorder");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/:id/rename", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const nextName = String(req.body?.name || "").trim();
    const result = await executeCliCommand(["provider:rename", providerId, nextName]);
    const response = jsonFromCliResult(result, `provider:rename ${providerId}`);
    res.status(response.status).json(response.payload);
  });

  app.patch("/api/providers/:id", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const patch = (req.body?.patch && typeof req.body.patch === "object") ? req.body.patch : {};
    const args = ["provider:update", providerId];
    if (patch.vision !== undefined) args.push("--vision", String(patch.vision));
    if (patch.free_model !== undefined) args.push("--free-model", String(patch.free_model));
    if (patch.name) args.push("--name", String(patch.name));
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, `provider:update ${providerId}`);
    res.status(response.status).json(response.payload);
  });

  app.delete("/api/providers/:id", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const result = await executeCliCommand(["provider:remove", providerId]);
    if (result.exitCode !== 0 && /Provider non trovato/i.test(result.stderr)) {
      return res.status(404).json({
        success: false,
        exitCode: result.exitCode,
        command: `provider:remove ${providerId}`,
        data: {
          output: result.stdout || "",
          error: result.stderr || "",
        },
        timestamp: new Date().toISOString(),
      });
    }
    const response = jsonFromCliResult(result, `provider:remove ${providerId}`);
    res.status(response.status).json(response.payload);
  });

  app.get("/api/stats", async (_req, res) => {
    const result = await executeCliCommand(["stats"]);
    const response = jsonFromCliResult(result, "stats");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/config", async (req, res) => {
    const scope = String(req.query.scope || "").trim();
    const projectPath = resolveRequestProjectPath(req.query.projectPath || req.headers["x-project-path"]);
    if (!projectPath) return res.status(403).json({ error: "PROJECT_PATH_NOT_ALLOWED" });
    const args = ["config:list"];
    if (scope === "project") args.push("--project");
    if (scope === "global") args.push("--scope", "global");
    if (scope === "service") args.push("--service");
    const result = await executeCliCommand(args, {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, "config:list");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/config/:key", async (req, res) => {
    const scope = String(req.query.scope || "").trim();
    const projectPath = resolveRequestProjectPath(req.query.projectPath || req.headers["x-project-path"]);
    if (!projectPath) return res.status(403).json({ error: "PROJECT_PATH_NOT_ALLOWED" });
    const args = ["config:get", String(req.params.key || "").trim()];
    if (scope === "project") args.push("--project");
    if (scope === "global") args.push("--scope", "global");
    if (scope === "service") args.push("--service");
    const result = await executeCliCommand(args, {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, `config:get ${req.params.key}`);
    res.status(response.status).json(response.payload);
  });

  app.post("/api/config/:key", async (req, res) => {
    const key = String(req.params.key || "").trim();
    const value = String(req.body?.value ?? "");
    const scope = String(req.body?.scope || "").trim();
    const projectPath = resolveRequestProjectPath(req.body?.projectPath || req.headers["x-project-path"]);
    if (!projectPath) return res.status(403).json({ error: "PROJECT_PATH_NOT_ALLOWED" });

    const { getConfigSpec, setScopeValue } = require("./configuration");
    const spec = getConfigSpec(key);

    if (!spec) {
      return res.status(400).json({
        success: false,
        exitCode: 1,
        command: `config:set ${key}`,
        data: { output: "", error: `Variabile non supportata: ${key}` },
        timestamp: new Date().toISOString(),
      });
    }

    // Write to disk using the configuration module
    const effectiveScope = scope || spec.scope;
    let writeResult;
    try {
      writeResult = setScopeValue({
        key,
        value: value || "",
        scope: effectiveScope,
        cwd: projectPath || process.cwd(),
        serviceConfigFile: paths.serviceConfigFile,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        exitCode: 1,
        command: `config:set ${key}`,
        data: { output: "", error: err.message },
        timestamp: new Date().toISOString(),
      });
    }

    // Hot-reload sinks for eligible variables
    if (spec.hotReloadable && !spec.restartRequired) {
      if (["DBLAYER_URL", "EVENTBUS_URL", "LLMPROXY_SENDGRID_API_KEY", "LLMPROXY_SENDGRID_FROM_EMAIL", "LLMPROXY_SENDGRID_TO_EMAIL", "LLMPROXY_SENDGRID_TO_MESSAGE_TYPE"].includes(key)) {
        app.locals.reconfigureSinks({ [key]: value });
      }
      return res.json({
        success: true,
        exitCode: 0,
        command: `config:set ${key}`,
        data: { output: `Configurazione aggiornata: ${writeResult.scope}.${key}=${writeResult.value}`, error: "" },
        restarting: false,
        timestamp: new Date().toISOString(),
      });
    }

    // Variables requiring restart
    if (spec.restartRequired) {
      // Send response BEFORE restart kills the process
      res.json({
        success: true,
        exitCode: 0,
        command: `config:set ${key}`,
        data: { output: `Configurazione aggiornata: ${writeResult.scope}.${key}=${writeResult.value}`, error: "" },
        restarting: true,
        message: `La variabile ${key} richiede il riavvio del servizio. Riavvio in corso...`,
        timestamp: new Date().toISOString(),
      });

      setTimeout(() => {
        executeCliCommand(["service:restart"]).catch(() => {});
      }, 200);
      return;
    }

    return res.json({
      success: true,
      exitCode: 0,
      command: `config:set ${key}`,
      data: { output: `Configurazione aggiornata: ${writeResult.scope}.${key}=${writeResult.value}`, error: "" },
      restarting: false,
      timestamp: new Date().toISOString(),
    });
  });

  app.delete("/api/config/:key", async (req, res) => {
    const scope = String(req.body?.scope || req.query.scope || "").trim();
    const projectPath = resolveRequestProjectPath(req.body?.projectPath || req.query.projectPath || req.headers["x-project-path"]);
    if (!projectPath) return res.status(403).json({ error: "PROJECT_PATH_NOT_ALLOWED" });
    const args = ["config:unset", String(req.params.key || "").trim()];
    if (scope === "project") args.push("--project");
    if (scope === "global") args.push("--scope", "global");
    if (scope === "service") args.push("--service");
    const result = await executeCliCommand(args, {
      cwd: projectPath || process.cwd(),
    });
    const response = jsonFromCliResult(result, `config:unset ${req.params.key}`);
    res.status(response.status).json(response.payload);
  });

  app.post("/api/update", async (_req, res) => {
    const result = await executeCliCommand(["update"]);
    const response = jsonFromCliResult(result, "update");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/uninstall", async (_req, res) => {
    const result = await executeCliCommand(["uninstall"]);
    const response = jsonFromCliResult(result, "uninstall");
    res.status(response.status).json(response.payload);
  });

  } // end standalone-only route surface

  // =============================================================================
  // Backward-compatible gateway routes (available in all modes)
  // =============================================================================

  registerLegacyGatewayRoutes(app, {
    handleMessages,
    handleOpenAIChat,
  });

  // =============================================================================
  // Canonical V11 gateway routes — Module 45 boundary
  // =============================================================================

  registerCanonicalGatewayRoutes(app, {
    handleMessages,
    handleOpenAIChat,
  });

  app.get("/v1/llm/providers", (req, res) => {
    const filter = {
      scope_type: req.query.scope_type ? String(req.query.scope_type) : undefined,
      scope_id: req.query.scope_id ? String(req.query.scope_id) : undefined,
      provider: req.query.provider ? String(req.query.provider) : undefined,
    };
    res.json({ entries: providerRegistry.list(filter) });
  });

  app.post("/v1/llm/providers", (req, res) => {
    const traceId = resolveTraceId(req);
    const hctx = parseHierarchyContext(req);
    if (mode === "platform" && !hctx) {
      return res.status(400).json(buildHierarchyContextRequiredError(traceId));
    }
    if (mode === "platform") {
      if (!isAdmin(hctx)) {
        return res.status(403).json({
          error: { code: "AUTH_REQUIRED", message: "admin or owner role required to register providers", trace_id: traceId },
        });
      }
    }
    try {
      const entry = providerRegistry.upsert(req.body || {});
      return res.status(201).json(entry);
    } catch (err) {
      const code = String(err.message || "INVALID_PROVIDER_ENTRY").split(":")[0];
      return res.status(400).json({ error: { code, message: err.message, trace_id: traceId } });
    }
  });

  app.delete("/v1/llm/providers/:id", (req, res) => {
    const traceId = resolveTraceId(req);
    const hctx = parseHierarchyContext(req);
    if (mode === "platform" && !hctx) {
      return res.status(400).json(buildHierarchyContextRequiredError(traceId));
    }
    const removed = providerRegistry.remove(String(req.params.id));
    if (!removed) return res.status(404).json({ error: { code: "NOT_FOUND", message: "provider entry not found", trace_id: traceId } });
    return res.status(204).end();
  });

  app.get("/v1/llm/health", (_req, res) => {
    res.json({
      ok: true,
      mode,
      authenticated: hasConfiguredProviders(),
      providers: listConfiguredProviderIds(),
      manifest_version: "v11",
    });
  });

  // =============================================================================
  // OpenAI-compatible model listing (for client model selectors)
  // =============================================================================

  function buildOpenAIModelEntry(provider, requestedId) {
    const providerId = String(provider.provider || provider.id || "unknown").trim().toLowerCase();
    const modelName = String(provider.default_model || "").trim();
    return {
      id: requestedId || `${providerId}:${modelName}`,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: providerId,
    };
  }

  app.get("/v1/models", (_req, res) => {
    const providers = typeof tokenStore.listProviders === "function" ? tokenStore.listProviders() : [];
    const seen = new Set();
    const data = [];
    for (const provider of providers) {
      const modelName = String(provider.default_model || "").trim();
      const providerId = String(provider.provider || provider.id || "unknown").trim().toLowerCase();
      const modelId = `${providerId}:${modelName}`;
      if (!modelName || seen.has(modelId)) continue;
      seen.add(modelId);
      data.push(buildOpenAIModelEntry(provider));
    }
    res.json({ object: "list", data });
  });

  app.get("/v1/models/:modelId", (req, res) => {
    const providers = typeof tokenStore.listProviders === "function" ? tokenStore.listProviders() : [];
    const modelId = String(req.params.modelId || "").trim();
    if (!modelId) return res.status(400).json({ error: { message: "modelId is required" } });
    const separator = modelId.indexOf(":");
    const requestedProvider = separator > 0 ? modelId.slice(0, separator).toLowerCase() : null;
    const requestedModel = separator > 0 ? modelId.slice(separator + 1) : modelId;
    for (const provider of providers) {
      const providerId = String(provider.provider || provider.id || "unknown").trim().toLowerCase();
      if (String(provider.default_model || "").trim() === requestedModel
        && (!requestedProvider || requestedProvider === providerId)) {
        return res.json(buildOpenAIModelEntry(provider, modelId));
      }
    }
    res.status(404).json({ error: { message: `model '${modelId}' not found` } });
  });

  function isProxyModelLabel(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "llmproxy"
      || normalized === "llm-proxy"
      || normalized === "proxy-local";
  }

  async function handleMessages(req, res, opts) {
    const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const traceId = resolveTraceId(req);
    const hierarchyContext = parseHierarchyContext(req);
    const meteringContext = parseMeteringContext(req);

    if (opts.enforceHierarchy && !hierarchyContext) {
      return res.status(400).json(buildHierarchyContextRequiredError(traceId));
    }
    if (opts.enforceHierarchy) {
      const validation = validateHierarchyContextForBilling(hierarchyContext);
      if (!validation.valid) {
        return res.status(400).json(buildHierarchyContextInvalidError(traceId, validation));
      }
    }

    const incomingBody = req.body || {};
    const requestedProviderInput = incomingBody.provider ? String(incomingBody.provider) : "auto";
    const modelAtLabel = parseProviderModelAtLabel(incomingBody.model);
    const explicitProviderFromModel = modelAtLabel.provider;
    const requestedProvider = explicitProviderFromModel || requestedProviderInput;
    const requestedModelHint = explicitProviderFromModel && modelAtLabel.model ? modelAtLabel.model : null;
    const providerSelection = resolveProviderSelection({
      requestedProvider,
      requestedModel: requestedModelHint,
      hierarchyContext,
      traceId,
      tokenStore,
      providerRegistry,
    });
    if (providerSelection.error) {
      return res.status(providerSelection.error.status).json({ error: providerSelection.error.body });
    }

    const projectContext = detectProjectContext(req);
    const projectMetadata = resolveProjectMetadata(projectContext.projectPath);
    const projectSettings = resolveClaudeProjectSettings(projectContext.projectPath, { env: runtimeEnv });
    if (projectContext.projectPath) {
      sinkRefs.sendgridNotifier.reconfigure({
        apiKey: projectSettings.sendgridApiKey,
        fromEmail: projectSettings.sendgridFromEmail,
        toEmail: projectSettings.sendgridToEmail,
        messageTypes: projectSettings.sendgridToMessageType,
      });
    }
    if (projectContext.projectPath && projectSettings.llmStatsApiKey === "") {
      return sendStaticAnthropicMessage(res, LLM_STATS_API_KEY_REQUIRED_MESSAGE, {
        stream: incomingBody.stream === true,
        model: String(incomingBody.model || "llmproxy/system").trim() || "llmproxy/system",
      });
    }
    const incomingModel = String(incomingBody.model || "").trim();
    const proxyControlsModel = projectSettings.proxyControlsModel === true;
    const requestedModelInput = isProxyModelLabel(incomingModel) ? "" : incomingModel;
    const effectiveRequestedModelInput = projectSettings.configuredModel || proxyControlsModel
      ? ""
      : requestedModelInput;
    const requestShortAnswer = parseBooleanLike(incomingBody.shortAnswer);
    const shortAnswer = requestShortAnswer == null ? Number(projectSettings.shortAnswer || 0) > 0 : requestShortAnswer;
    const modelOverride = projectSettings.configuredModel || effectiveRequestedModelInput || providerSelection.defaultModel;
    const canonicalBody = { ...incomingBody };
    if (modelOverride) {
      canonicalBody.model = modelOverride;
    } else if (!effectiveRequestedModelInput && incomingModel) {
      delete canonicalBody.model;
    }
    if (shortAnswer) {
      canonicalBody.system = appendSystemInstruction(canonicalBody.system, SHORT_ANSWER_SYSTEM_TEXT);
    }
    // Inject the optional intent annotation only when explicitly enabled.
    const intentInfoLine = String(runtimeEnv.LLMPROXY_INTENT_INFO_LINE || "0").trim();
    if (intentInfoLine !== "1" && Number(runtimeEnv.LLMPROXY_INTENT_ESCALATION || 0) > 0) {
      const { buildIntentPrompt } = require("./intent-escalation");
      canonicalBody.system = appendSystemInstruction(canonicalBody.system, buildIntentPrompt());
    }
    delete canonicalBody.provider;
    delete canonicalBody.shortAnswer;

    const translatedRequest = translateRequest(canonicalBody);
    const requestedModel = canonicalBody.model || translatedRequest.model || null;
    const modelPreference = projectSettings.configuredModel || translatedRequest.model;
    const effectiveModel = resolveSupportedModel(modelPreference, undefined, modelCatalogStore.list());

    // Intent escalation: extract intent from user message, track, potentially override model
    if (Number(runtimeEnv.LLMPROXY_INTENT_ESCALATION || 0) > 0 && tokenStore && canonicalBody.messages) {
      try {
        const { IntentTracker, extractLastUserMessage } = require("./intent-escalation");
        const userMessage = extractLastUserMessage(canonicalBody.messages);
        if (userMessage) {
          const escalationTracker = new IntentTracker({ env: runtimeEnv, tokenStore, fetchFn });
          const { intent, continuation } = await escalationTracker.extractIntent(
            userMessage,
            { messages: canonicalBody.messages, tokenStore, fetchFn },
          );
          const escalationResult = escalationTracker.track(
            intent,
            canonicalBody.model || effectiveModel || modelPreference,
            tokenStore.listProviders(),
            continuation,
            userMessage,
          );
          req.__intentInfo = { intent, count: escalationResult.count };
          if (escalationResult.escalationModel) {
            const originalModel = canonicalBody.model || effectiveModel || modelPreference || "unknown";
            canonicalBody.model = escalationResult.escalationModel;
            req.__escalatedFrom = { originalModel, escalatedModel: escalationResult.escalationModel };
          }
        }
      } catch (_escalationError) {
        // Best effort: don't fail the request if escalation logic errors
      }
    }

    logger.logIncomingRequest({
      requestId,
      traceId,
      mode,
      route: opts.route,
      hierarchyContext,
      meteringContext,
      provider: providerSelection.provider,
      providerSource: providerSelection.source,
      projectPath: projectContext.projectPath,
      projectPathSource: projectContext.source,
      projectName: projectMetadata.projectName,
      projectNameSource: projectMetadata.projectNameSource,
      configuredModel: projectSettings.configuredModel,
      inlineMetering: projectSettings.inlineMetering,
      inlineInferenceInfo: projectSettings.inlineInferenceInfo,
      requestedModel,
      effectiveModel,
      stream: canonicalBody.stream,
    });

    try {
      await executeGatewayRequest({
        anthropicBody: canonicalBody,
        req,
        res,
        requestId,
        traceId,
        hierarchyContext,
        meteringContext,
        meteringSink: sinkRefs.meteringSink,
        eventBusSink: sinkRefs.eventBusSink,
        provider: requestedProvider === "auto" ? "auto" : providerSelection.provider,
        projectName: projectMetadata.projectName,
        configuredModel: projectSettings.configuredModel,
        inlineMetering: projectSettings.inlineMetering,
        inlineInferenceInfo: projectSettings.inlineInferenceInfo,
        creditInline: projectSettings.creditInline,
        providerCandidates: providerSelection.providerCandidates || null,
        tokenStore,
        logger,
        fetchFn,
        endpointPreferences,
        availableModels: modelCatalogStore.list(),
        proxyRegistryFile: paths.proxyRegistryFile,
      });
    } catch (error) {
      await Promise.resolve(sinkRefs.sendgridNotifier.notifyProviderError({
        provider: providerSelection.provider,
        model: modelOverride || requestedModel || providerSelection.defaultModel,
        reason: error?.message || String(error || ""),
        requestId,
        projectPath: projectContext.projectPath,
      })).catch(() => {});
      throw error;
    }
  }

  async function handleOpenAIChat(req, res, opts) {
    const traceId = resolveTraceId(req);
    const hierarchyContext = parseHierarchyContext(req);
    if (opts.enforceHierarchy && !hierarchyContext) {
      return res.status(400).json(buildHierarchyContextRequiredError(traceId));
    }
    if (opts.enforceHierarchy) {
      const validation = validateHierarchyContextForBilling(hierarchyContext);
      if (!validation.valid) {
        return res.status(400).json(buildHierarchyContextInvalidError(traceId, validation));
      }
    }
    const openAiBody = req.body || {};
    if (openAiBody.stream) {
      return res.status(501).json({ error: { code: "STREAM_NOT_IMPLEMENTED", message: "streaming for /v1/chat/completions is not yet supported", trace_id: traceId } });
    }
    const anthropicBody = openAIRequestToAnthropic(openAiBody);
    if (openAiBody.provider) anthropicBody.provider = openAiBody.provider;
    if (openAiBody.shortAnswer !== undefined) anthropicBody.shortAnswer = openAiBody.shortAnswer;
    const captureRes = createOpenAICaptureResponse(res, traceId);
    req.body = anthropicBody;
    await handleMessages(req, captureRes, { route: opts.route, enforceHierarchy: false, format: "openai" });
  }

  function createOpenAICaptureResponse(realRes, traceId) {
    return {
      _status: 200,
      _headers: {},
      status(code) { this._status = code; return this; },
      setHeader(k, v) { this._headers[k] = v; },
      getHeader(k) { return this._headers[k]; },
      json(payload) {
        if (this._status >= 400) {
          realRes.status(this._status).json(payload);
          return realRes;
        }
        const openai = anthropicResponseToOpenAI(payload);
        realRes.status(this._status).json(openai);
        return realRes;
      },
      end() { realRes.end(); },
      write() { realRes.status(501).json({ error: { code: "STREAM_NOT_IMPLEMENTED", message: "streaming for /v1/chat/completions is not yet supported", trace_id: traceId } }); },
    };
  }

  // ---------------------------------------------------------------------------
  // Metering query endpoints (platform mode only)
  // ---------------------------------------------------------------------------

  /**
   * Parse and validate the shared query parameters used by both metering endpoints.
   * Returns { filters, limit, offset, order } on success, or null and writes a 400 response.
   */
  function parseMeteringQueryParams(req, res) {
    const q = req.query;

    // Numeric pagination
    const rawLimit = q.limit !== undefined ? Number(q.limit) : 100;
    const rawOffset = q.offset !== undefined ? Number(q.offset) : 0;
    if (!Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
      res.status(400).json({ error: { code: "INVALID_PARAM", message: "limit must be an integer between 1 and 1000" } });
      return null;
    }
    if (!Number.isFinite(rawOffset) || rawOffset < 0) {
      res.status(400).json({ error: { code: "INVALID_PARAM", message: "offset must be a non-negative integer" } });
      return null;
    }

    const order = q.order === "asc" ? "asc" : "desc";

    // ISO date range
    const from = q.from ? String(q.from) : undefined;
    const to = q.to ? String(q.to) : undefined;
    if (from && isNaN(Date.parse(from))) {
      res.status(400).json({ error: { code: "INVALID_PARAM", message: "from must be a valid ISO 8601 date string" } });
      return null;
    }
    if (to && isNaN(Date.parse(to))) {
      res.status(400).json({ error: { code: "INVALID_PARAM", message: "to must be a valid ISO 8601 date string" } });
      return null;
    }

    // Boolean success filter
    let success;
    if (q.success !== undefined) {
      if (q.success === "true") success = true;
      else if (q.success === "false") success = false;
      else {
        res.status(400).json({ error: { code: "INVALID_PARAM", message: "success must be 'true' or 'false'" } });
        return null;
      }
    }

    const filters = {};
    if (from) filters.from = from;
    if (to) filters.to = to;
    if (success !== undefined) filters.success = success;

    const STRING_QUERY_KEYS = [
      "project_id", "tenant_id", "client_id", "master_company",
      "scope_type", "scope_id",
      "user_id", "master_user_id", "tenant_user_id", "client_user_id", "project_user_id",
      "provider", "request_id",
    ];
    for (const key of STRING_QUERY_KEYS) {
      if (q[key] !== undefined) filters[key] = String(q[key]);
    }

    return { filters, limit: rawLimit, offset: rawOffset, order };
  }

  /**
   * GET /v1/llm/metering
   *
   * Returns a paginated list of raw metering records.
   * Available only in platform mode (meteringSink !== noop / has a query method).
   *
   * Query parameters:
   *   limit        integer 1–1000  (default 100)
   *   offset       integer ≥ 0     (default 0)
   *   order        "desc" | "asc"  (default "desc" — newest first)
   *   from         ISO 8601 date   filter records with timestamp ≥ from
   *   to           ISO 8601 date   filter records with timestamp ≤ to
   *   success      "true"|"false"  filter by success flag
   *   project_id   string          exact-match filter
   *   tenant_id    string          exact-match filter
   *   client_id    string          exact-match filter
   *   master_company string        exact-match filter
   *   scope_type   string          exact-match filter
   *   scope_id     string          exact-match filter
   *   provider     string          exact-match filter
   *   user_id / master_user_id / tenant_user_id / client_user_id / project_user_id
   *                string          exact-match filters
   *   request_id   string          exact-match filter
   *
   * Response 200:
   *   { records: MeteringRecord[], total: number, limit: number, offset: number, order: string }
   */
  app.get("/v1/llm/metering", async (req, res) => {
    if (mode !== "platform" || typeof sinkRefs.meteringSink.query !== "function") {
      return res.status(404).json({
        error: {
          code: "NOT_AVAILABLE",
          message: "metering query is only available in platform mode",
        },
      });
    }

    const params = parseMeteringQueryParams(req, res);
    if (!params) return; // 400 already sent

    try {
      const result = await Promise.resolve(sinkRefs.meteringSink.query({ filters: params.filters, limit: params.limit, offset: params.offset, order: params.order }));
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: { code: "METERING_READ_ERROR", message: err.message } });
    }
  });

  /**
   * GET /v1/llm/metering/stats
   *
   * Returns aggregate statistics computed over the filtered record set.
   * Accepts the same filter query parameters as GET /v1/llm/metering
   * (limit/offset/order are ignored — stats are computed over the full filtered set).
   *
   * Response 200:
   *   {
   *     total_requests, success_count, error_count,
   *     total_tokens_input, total_tokens_output, total_tokens,
   *     avg_tokens_input, avg_tokens_output,
   *     avg_duration_ms, p50_duration_ms, p95_duration_ms,
   *     earliest_timestamp, latest_timestamp,
   *     by_provider:   { [provider]: { requests, tokens_input, tokens_output } },
   *     by_scope_type: { [scope_type]: { requests, tokens_input, tokens_output } },
   *     by_project_id: { [project_id]: { requests, tokens_input, tokens_output } }
   *   }
   */
  app.get("/v1/llm/metering/stats", async (req, res) => {
    if (mode !== "platform" || typeof sinkRefs.meteringSink.query !== "function") {
      return res.status(404).json({
        error: {
          code: "NOT_AVAILABLE",
          message: "metering query is only available in platform mode",
        },
      });
    }

    const params = parseMeteringQueryParams(req, res);
    if (!params) return; // 400 already sent

    try {
      let statsResult;
      if (typeof sinkRefs.meteringSink.computeStats === "function") {
        // Use efficient server-side aggregation when available (MongoDB sink)
        statsResult = await Promise.resolve(sinkRefs.meteringSink.computeStats(params.filters));
      } else {
        // Fallback: load all matching records into memory and compute in JS (JSONL sink)
        const result = await Promise.resolve(sinkRefs.meteringSink.query({ filters: params.filters, limit: 1_000_000, offset: 0, order: "asc" }));
        statsResult = { ...computeMeteringStats(result.records), filtered_total: result.total };
      }
      return res.json(statsResult);
    } catch (err) {
      return res.status(500).json({ error: { code: "METERING_READ_ERROR", message: err.message } });
    }
  });

  return app;
}

function registerLegacyGatewayRoutes(app, handlers) {
  app.post("/v1/messages", async (req, res) => {
    return handlers.handleMessages(req, res, { route: "/v1/messages", enforceHierarchy: false, format: "anthropic" });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    return handlers.handleOpenAIChat(req, res, { route: "/v1/chat/completions", enforceHierarchy: false });
  });
}

function registerCanonicalGatewayRoutes(app, handlers) {
  app.post("/v1/llm/messages", async (req, res) => {
    return handlers.handleMessages(req, res, { route: "/v1/llm/messages", enforceHierarchy: true, format: "anthropic" });
  });

  app.post("/v1/llm/chat/completions", async (req, res) => {
    return handlers.handleOpenAIChat(req, res, { route: "/v1/llm/chat/completions", enforceHierarchy: true });
  });
}

function startServer(options = {}) {
  const runtimeEnv = options.env || process.env;
  const binding = resolveProxyHostPort({
    env: runtimeEnv,
    dataRoot: options.dataRoot,
    host: options.host,
    port: options.port,
  });
  const port = Number(binding.port);
  const host = binding.host;
  assertGlobalServicePortAccess({ port, env: runtimeEnv });
  if (String(runtimeEnv.LLMPROXY_GLOBAL_SERVICE || "").trim() === "1") {
    const cleanupResult = reapConflictingPortListeners({
      port,
      allowedPids: [process.pid],
    });
    if (!cleanupResult.ok) {
      return Promise.reject(new Error(cleanupResult.error));
    }
  }
  const app = createApp({ ...options, env: runtimeEnv });
  if (options.tokenStore) {
    try {
      const reordering = createProviderReordering({
        filePath: path.join(options.dataRoot || paths?.dataRoot || require("./paths").createPaths().dataRoot, DEFAULT_REORDERING_FILE),
        tokenStore: options.tokenStore,
        fetchFn: options.fetchFn || fetch,
        probeFn: buildDefaultProbeFn(),
      });
      reordering.start(null, runtimeEnv);
      options.tokenStore.__llmproxyProviderReordering = reordering;
    } catch {
      // best effort: automatic reordering is non-critical
    }
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ app, server, port, host }));
    server.on("error", reject);

    const cleanupSinks = async () => {
      const refs = app.locals.sinkRefs;
      if (refs) {
        await Promise.all([
          refs.meteringSink?.close?.() ?? Promise.resolve(),
          refs.eventBusSink?.close?.() ?? Promise.resolve(),
        ]).catch(() => {});
      }
    };

    const gracefulShutdown = async () => {
      await cleanupSinks();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    };

    process.once("SIGTERM", gracefulShutdown);
    process.once("SIGINT", gracefulShutdown);
  });
}

module.exports = {
  createApp,
  startServer,
};
