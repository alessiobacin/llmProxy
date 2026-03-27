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

  const app = express();
  app.use(express.json({ limit: "50mb" }));

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

  app.post("/v1/messages", async (req, res) => {
    const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const projectContext = detectProjectContext(req);
    const projectMetadata = resolveProjectMetadata(projectContext.projectPath);
    const projectSettings = resolveClaudeProjectSettings(projectContext.projectPath);
    const translatedRequest = translateRequest(req.body || {});
    const requestedModel = req.body?.model || translatedRequest.model || null;
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
      stream: req.body?.stream,
    });

    await proxyAnthropicRequest({
      anthropicBody: req.body || {},
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