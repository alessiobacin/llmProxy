const express = require("express");
const crypto = require("node:crypto");
const { createPaths, ensureRuntimeDirs } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createRequestLogger } = require("./logger");
const { detectProjectContext, resolveProjectMetadata, resolveClaudeProjectSettings } = require("./project-context");
const { createCopilotEndpointPreferences } = require("./copilot-endpoint-preferences");
const { createCopilotModelCatalogStore } = require("./copilot-models");
const { proxyAnthropicRequest, API_KEY_PROVIDER_CONFIGS } = require("./copilot-proxy");
const { resolveSupportedModel, translateRequest } = require("./openai-translate");
const {
  parseHierarchyContext,
  validateHierarchyContextForBilling,
  parseMeteringContext,
  resolveTraceId,
  resolveMode,
  buildHierarchyContextRequiredError,
  buildHierarchyContextInvalidError,
} = require("./platform-context");
const { createNoopMeteringSink } = require("./metering");
const { createProviderRegistry, SUPPORTED_PROVIDERS } = require("./provider-registry");
const { openAIRequestToAnthropic, anthropicResponseToOpenAI } = require("./openai-format");

const IMPLEMENTED_API_KEY_PROVIDERS = new Set(Object.keys(API_KEY_PROVIDER_CONFIGS));

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
  const meteringSink = options.meteringSink || createNoopMeteringSink();
  const mode = options.mode || resolveMode(process.env);
  const providerRegistry = options.providerRegistry || createProviderRegistry({
    filePath: paths.providerRegistryFile,
    secret: process.env.LLMPROXY_SECRET || null,
  });
  const endpointPreferences = createCopilotEndpointPreferences({ filePath: paths.endpointPreferencesFile });
  const modelCatalogStore = createCopilotModelCatalogStore({ filePath: paths.modelCatalogFile });
  const fetchFn = options.fetchFn || fetch;
  const serviceManager = options.serviceManager;

  const app = express();
  app.use(express.json({ limit: "50mb" }));

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

  app.get("/health", (_req, res) => {
    res.json({ ok: true, authenticated: !!tokenStore.getAccessToken() });
  });

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
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    if (model) args.push("--model", model);
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, `provider:add ${providerId}`);
    res.status(response.status).json(response.payload);
  });

  app.post("/api/providers/:id/api-key", async (req, res) => {
    const providerId = String(req.params.id || "").trim();
    const providerName = String(req.body?.name || providerId).trim();
    const apiKey = String(req.body?.apiKey || req.body?.api_key || "").trim();
    const model = String(req.body?.model || req.body?.default_model || req.body?.defaultModel || "").trim();
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    if (apiKey) args.push("--api-key", apiKey);
    if (model) args.push("--model", model);
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

  app.post("/v1/messages", async (req, res) => {
    return handleMessages(req, res, { route: "/v1/messages", enforceHierarchy: false, format: "anthropic" });
  });

  app.post("/v1/llm/messages", async (req, res) => {
    return handleMessages(req, res, { route: "/v1/llm/messages", enforceHierarchy: true, format: "anthropic" });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    return handleOpenAIChat(req, res, { route: "/v1/chat/completions", enforceHierarchy: false });
  });

  app.post("/v1/llm/chat/completions", async (req, res) => {
    return handleOpenAIChat(req, res, { route: "/v1/llm/chat/completions", enforceHierarchy: true });
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
      const roles = Array.isArray(hctx.roles) ? hctx.roles.map((r) => String(r).toLowerCase()) : [];
      const allowed = roles.includes("admin") || roles.includes("owner");
      if (!allowed) {
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
    const providerSelection = resolveProviderSelection({ requestedProvider, hierarchyContext, traceId });
    if (providerSelection.error) {
      return res.status(providerSelection.error.status).json({ error: providerSelection.error.body });
    }

    const projectContext = detectProjectContext(req);
    const projectMetadata = resolveProjectMetadata(projectContext.projectPath);
    const projectSettings = resolveClaudeProjectSettings(projectContext.projectPath);
    const modelOverride = projectSettings.configuredModel || incomingBody.model || providerSelection.defaultModel;
    const canonicalBody = modelOverride
      ? { ...incomingBody, model: modelOverride }
      : incomingBody;
    delete canonicalBody.provider;
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
      stream: canonicalBody.stream,
    });

    await proxyAnthropicRequest({
      anthropicBody: canonicalBody,
      req,
      res,
      requestId,
      traceId,
      hierarchyContext,
      meteringContext,
      meteringSink,
      provider: requestedProvider === "auto" ? "auto" : providerSelection.provider,
      projectName: projectMetadata.projectName,
      configuredModel: projectSettings.configuredModel,
      tokenStore,
      logger,
      fetchFn,
      endpointPreferences,
      availableModels: modelCatalogStore.list(),
    });
  }

  function resolveProviderSelection({ requestedProvider, hierarchyContext, traceId }) {
    if (requestedProvider && requestedProvider !== "auto" && !SUPPORTED_PROVIDERS.includes(requestedProvider)) {
      const localProvider = tokenStore.getProvider ? tokenStore.getProvider(requestedProvider) : null;
      if (!localProvider) {
        return { error: { status: 400, body: { code: "UNSUPPORTED_PROVIDER", message: `unknown provider: ${requestedProvider}`, trace_id: traceId } } };
      }
      return { provider: requestedProvider, defaultModel: localProvider.default_model || null, source: "local" };
    }
    const resolved = providerRegistry.resolve(hierarchyContext, requestedProvider);
    if (resolved) {
      if (resolved.provider !== "copilot" && !IMPLEMENTED_API_KEY_PROVIDERS.has(resolved.provider)) {
        return { error: { status: 501, body: { code: "PROVIDER_NOT_IMPLEMENTED", message: `provider adapter not implemented yet: ${resolved.provider}`, trace_id: traceId } } };
      }
      return { provider: resolved.provider, defaultModel: resolved.default_model || null, source: "registry" };
    }
    if (requestedProvider && requestedProvider !== "auto" && requestedProvider !== "copilot" && !IMPLEMENTED_API_KEY_PROVIDERS.has(requestedProvider)) {
      return { error: { status: 501, body: { code: "PROVIDER_NOT_IMPLEMENTED", message: `provider adapter not implemented yet: ${requestedProvider}`, trace_id: traceId } } };
    }
    return { provider: requestedProvider && requestedProvider !== "auto" ? requestedProvider : "copilot", defaultModel: null, source: "default" };
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

  return app;
}

function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 3015);
  const host = String(options.host || process.env.HOST || "127.0.0.1");
  const app = createApp(options);
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => resolve({ app, server, port, host }));
  });
}

module.exports = {
  createApp,
  startServer,
};
