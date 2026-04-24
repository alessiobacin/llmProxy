const express = require("express");
const crypto = require("node:crypto");
const { createPaths, ensureRuntimeDirs } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createRequestLogger } = require("./logger");
const { detectProjectContext, resolveProjectMetadata, resolveClaudeProjectSettings } = require("./project-context");
const { createCopilotEndpointPreferences } = require("./copilot-endpoint-preferences");
const { createCopilotModelCatalogStore } = require("./copilot-models");
const { proxyAnthropicRequest } = require("./copilot-proxy");
const { resolveSupportedModel, translateRequest } = require("./openai-translate");

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
    const args = ["provider:add", providerId];
    if (providerName) args.push("--name", providerName);
    const result = await executeCliCommand(args);
    const response = jsonFromCliResult(result, `provider:add ${providerId}`);
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
    const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const projectContext = detectProjectContext(req);
    const projectMetadata = resolveProjectMetadata(projectContext.projectPath);
    const projectSettings = resolveClaudeProjectSettings(projectContext.projectPath);
    const incomingBody = req.body || {};
    const canonicalBody = projectSettings.configuredModel
      ? { ...incomingBody, model: projectSettings.configuredModel }
      : incomingBody;
    const translatedRequest = translateRequest(canonicalBody);
    const requestedModel = canonicalBody.model || translatedRequest.model || null;
    const modelPreference = projectSettings.configuredModel || translatedRequest.model;
    const effectiveModel = resolveSupportedModel(modelPreference, undefined, modelCatalogStore.list());
    logger.logIncomingRequest({
      requestId,
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
      projectName: projectMetadata.projectName,
      configuredModel: projectSettings.configuredModel,
      tokenStore,
      logger,
      fetchFn,
      endpointPreferences,
      availableModels: modelCatalogStore.list(),
    });
  });

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