const express = require("express");
const crypto = require("node:crypto");
const { createPaths, ensureRuntimeDirs } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createRequestLogger } = require("./logger");
const { detectProjectContext, resolveProjectMetadata, resolveClaudeProjectSettings } = require("./project-context");
const { createCopilotEndpointPreferences } = require("./copilot-endpoint-preferences");
const { createCopilotModelCatalogStore } = require("./copilot-models");
const { createAvailabilityCache } = require("./smart-router-cache");
const { createSmartRouterStore } = require("./smart-router-store");
const { analyzeRequest, routeRequest, classifyWithLLM } = require("./smart-router");
const {
  executeGatewayRequest,
  resolveProviderSelection,
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
const { createNoopMeteringSink, createJsonlMeteringSink, computeMeteringStats } = require("./metering");
const { createEventBusSink } = require("./event-bus");
const { createProviderRegistry } = require("./provider-registry");
const { openAIRequestToAnthropic, anthropicResponseToOpenAI } = require("./openai-format");
const { resolveProxyHostPort } = require("./runtime-env");
const { assertGlobalServicePortAccess, reapConflictingPortListeners } = require("./port-guard");


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

function createApp(options = {}) {
  const paths = createPaths({ dataRoot: options.dataRoot, packageRoot: options.packageRoot });
  ensureRuntimeDirs(paths);

  const tokenStore = options.tokenStore || createTokenStore({ filePath: paths.tokenFile });
  const logger = options.logger || createRequestLogger({
    logsDir: paths.logsDir,
    retentionDays: Number(process.env.LLMPROXY_LOG_RETENTION_DAYS || 7),
    maxBytes: Number(process.env.LLMPROXY_LOG_MAX_BYTES || 5 * 1024 * 1024),
    maxArchivedFiles: Number(process.env.LLMPROXY_LOG_MAX_FILES || 5),
  });
  const mode = options.mode || resolveMode(process.env);
  // Default sink in platform mode is "dblayer" (falls back to jsonl if db-layer is unreachable).
  const meteringSinkMode = process.env.LLMPROXY_METERING_SINK ||
    (mode === "platform" ? "dblayer" : "noop");
  let meteringSink = options.meteringSink;
  if (!meteringSink) {
    if (meteringSinkMode === "dblayer") {
      // Local JSONL sink used as automatic fallback when db-layer is unreachable
      const localFallback = createJsonlMeteringSink({ filePath: paths.meteringFile });
      const { createDbLayerSink } = require("./metering-dblayer");
      meteringSink = createDbLayerSink({
        url: process.env.DBLAYER_URL,   // auto-resolved from LLMPROXY_ENV if not set
        fallbackSink: localFallback,
        fetchFn: options.fetchFn || fetch,
      });
    } else if (meteringSinkMode === "jsonl") {
      meteringSink = createJsonlMeteringSink({ filePath: paths.meteringFile });
    } else {
      meteringSink = createNoopMeteringSink();
    }
  }
  const eventBusSink = options.eventBusSink || createEventBusSink({
    url: process.env.EVENTBUS_URL,
    fetchFn: options.fetchFn || fetch,
  });
  const providerRegistry = options.providerRegistry || createProviderRegistry({
    filePath: paths.providerRegistryFile,
    secret: process.env.LLMPROXY_SECRET || null,
  });
  const endpointPreferences = createCopilotEndpointPreferences({ filePath: paths.endpointPreferencesFile });
  const modelCatalogStore = createCopilotModelCatalogStore({ filePath: paths.modelCatalogFile });
  const smartRouterStore = options.smartRouterStore || createSmartRouterStore({
    filePath: paths.smartRouterFile,
  });
  const availabilityCache = options.availabilityCache || createAvailabilityCache({});
  const fetchFn = options.fetchFn || fetch;
  const serviceManager = options.serviceManager;

  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // Inject a Warning header on every response when the db-layer sink is
  // configured but currently unreachable. Clients can detect this condition
  // and surface the information to operators.
  app.use((_req, res, next) => {
    if (meteringSink && typeof meteringSink.isAvailable === "function") {
      const origWriteHead = res.writeHead.bind(res);
      res.writeHead = function (statusCode, statusMessageOrHeaders, headers) {
        if (!meteringSink.isAvailable()) {
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
    });

    return {
      exitCode,
      stdout: stdout.toString().trim(),
      stderr: stderr.toString().trim(),
    };
  }

  // Health endpoint — available in all modes
  app.get("/health", (_req, res) => {
    res.json({ ok: true, authenticated: !!tokenStore.getAccessToken() });
  });

  // =============================================================================
  // Standalone-only route surface (not registered in platform mode)
  // Local auth, CLI/REST control plane, and backward-compat gateway routes.
  // These are not part of the canonical V11 Module 45 gateway boundary.
  // =============================================================================

  if (mode !== "platform") {

  app.get("/auth/status", (_req, res) => {
    res.json({ authenticated: !!tokenStore.getAccessToken() });
  });

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
    const result = await executeCliCommand(["login"]);
    const response = jsonFromCliResult(result, "login");
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

  app.post("/api/providers/:id/login", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const providerName = String(req.body?.name || providerId).trim();
    const model = String(req.body?.model || req.body?.default_model || req.body?.defaultModel || "").trim();
    const plan = String(req.body?.plan || "").trim();
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    if (model) args.push("--model", model);
    if (plan) args.push("--plan", plan);
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
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    if (apiKey) args.push("--api-key", apiKey);
    if (model) args.push("--model", model);
    if (plan) args.push("--plan", plan);
    args.push("--vision", vision);
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, `provider:add ${providerId} --api-key`);
    res.status(response.status).json(response.payload);
  });

  app.get("/api/providers", async (_req, res) => {
    const result = await executeCliCommand(["provider:list"]);
    const response = jsonFromCliResult(result, "provider:list");
    res.status(response.status).json(response.payload);
  });

  app.get("/api/providers/status", async (_req, res) => {
    const result = await executeCliCommand(["provider:status"]);
    const response = jsonFromCliResult(result, "provider:status");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/order", async (req, res) => {
    const providerId = String(req.body?.id || "").trim();
    const position = String(req.body?.position || "").trim();
    const result = await executeCliCommand(["provider:order", providerId, position]);
    const response = jsonFromCliResult(result, "provider:order");
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/:id/rename", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const nextName = String(req.body?.name || "").trim();
    const result = await executeCliCommand(["provider:rename", providerId, nextName]);
    const response = jsonFromCliResult(result, `provider:rename ${providerId}`);
    res.status(response.status).json(response.payload);
  });

  app.delete("/api/providers/:id", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const result = await executeCliCommand(["provider:remove", providerId]);
    const response = jsonFromCliResult(result, `provider:remove ${providerId}`);
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
      authenticated: !!tokenStore.getAccessToken(),
      providers: typeof tokenStore.list === "function"
        ? tokenStore.list().map((p) => p.id)
        : [],
      manifest_version: "v8",
    });
  });

  function isProxyModelLabel(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "llmproxy" || normalized === "proxy-local";
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
    const requestedProvider = incomingBody.provider ? String(incomingBody.provider) : "auto";
    const providerSelection = resolveProviderSelection({
      requestedProvider,
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
    const projectSettings = resolveClaudeProjectSettings(projectContext.projectPath);
    const incomingModel = String(incomingBody.model || "").trim();
    const requestedModelInput = projectSettings.configuredModel
      ? incomingModel
      : isProxyModelLabel(incomingModel)
        ? ""
        : incomingModel;
    const requestShortAnswer = parseBooleanLike(incomingBody.shortAnswer);
    const shortAnswer = requestShortAnswer == null ? projectSettings.shortAnswer === true : requestShortAnswer;
    const modelOverride = projectSettings.configuredModel || requestedModelInput || providerSelection.defaultModel;
    const canonicalBody = { ...incomingBody };
    if (modelOverride) {
      canonicalBody.model = modelOverride;
    } else if (!requestedModelInput && incomingModel) {
      delete canonicalBody.model;
    }
    if (shortAnswer) {
      canonicalBody.system = appendSystemInstruction(canonicalBody.system, SHORT_ANSWER_SYSTEM_TEXT);
    }
    delete canonicalBody.provider;
    delete canonicalBody.shortAnswer;

    let smartRouteInfo = null;
    if (projectSettings.smartRoute && isProxyModelLabel(incomingModel) && !projectSettings.configuredModel) {
      try {
        const activeProviders = await availabilityCache.getActiveProviders(providerRegistry, async (entry) => {
          return { active: true, error: null, models: entry.default_model ? [entry.default_model] : [] };
        });
        const analysis = analyzeRequest(canonicalBody);
        let finalAnalysis = analysis;

        if (projectSettings.smartRoute === "llm" || projectSettings.smartRoute === "hybrid") {
          if (smartRouterStore.isConfigured()) {
            const routerConfig = smartRouterStore.getConfig();
            const llmResult = await classifyWithLLM(canonicalBody, routerConfig, fetchFn);
            if (llmResult) {
              finalAnalysis = { ...analysis, ...llmResult, recommendedTier: llmResult.complexity === "complex" ? "premium" : llmResult.complexity === "simple" ? "economy" : "standard" };
            }
          } else {
            smartRouteInfo = { alertMessage: "LLM classifier disabled (classifier not configured, using rules-based)" };
          }
        }

        const decision = routeRequest(finalAnalysis, activeProviders.providers, projectSettings.smartPreference);
        if (decision) {
          canonicalBody.model = decision.model;
          smartRouteInfo = {
            ...smartRouteInfo,
            tier: decision.tier,
            method: projectSettings.smartRoute === "rules" ? "rules" : smartRouterStore.isConfigured() ? "hybrid" : "rules",
            model: decision.model,
            provider: decision.provider,
          };
        }
      } catch {
        // Smart routing failure must not block the request
      }
    }

    const translatedRequest = translateRequest(canonicalBody);
    const requestedModel = canonicalBody.model || translatedRequest.model || null;
    const modelPreference = projectSettings.configuredModel || translatedRequest.model;
    const effectiveModel = resolveSupportedModel(modelPreference, undefined, modelCatalogStore.list());
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
      requestedModel,
      effectiveModel,
      smartRoute: smartRouteInfo,
      stream: canonicalBody.stream,
    });

    await executeGatewayRequest({
      anthropicBody: canonicalBody,
      req,
      res,
      requestId,
      traceId,
      hierarchyContext,
      meteringContext,
      meteringSink,
      eventBusSink,
      provider: requestedProvider === "auto" ? "auto" : providerSelection.provider,
      projectName: projectMetadata.projectName,
      configuredModel: projectSettings.configuredModel,
      tokenStore,
      logger,
      fetchFn,
      endpointPreferences,
      availableModels: modelCatalogStore.list(),
      smartRouteInfo,
    });
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
    if (mode !== "platform" || typeof meteringSink.query !== "function") {
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
      const result = await Promise.resolve(meteringSink.query({ filters: params.filters, limit: params.limit, offset: params.offset, order: params.order }));
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
    if (mode !== "platform" || typeof meteringSink.query !== "function") {
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
      if (typeof meteringSink.computeStats === "function") {
        // Use efficient server-side aggregation when available (MongoDB sink)
        statsResult = await Promise.resolve(meteringSink.computeStats(params.filters));
      } else {
        // Fallback: load all matching records into memory and compute in JS (JSONL sink)
        const result = await Promise.resolve(meteringSink.query({ filters: params.filters, limit: 1_000_000, offset: 0, order: "asc" }));
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
  const binding = resolveProxyHostPort({
    env: process.env,
    dataRoot: options.dataRoot,
    host: options.host,
    port: options.port,
  });
  const port = Number(binding.port);
  const host = binding.host;
  assertGlobalServicePortAccess({ port, env: process.env });
  if (String(process.env.LLMPROXY_GLOBAL_SERVICE || "").trim() === "1") {
    const cleanupResult = reapConflictingPortListeners({
      port,
      allowedPids: [process.pid],
    });
    if (!cleanupResult.ok) {
      return Promise.reject(new Error(cleanupResult.error));
    }
  }
  const app = createApp(options);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ app, server, port, host }));
    server.on("error", reject);
  });
}

module.exports = {
  createApp,
  startServer,
};
