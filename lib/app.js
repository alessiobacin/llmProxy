const express = require("express");
const crypto = require("node:crypto");
const { createPaths, ensureRuntimeDirs } = require("./paths");
const { createTokenStore } = require("./token-store");
const { createRequestLogger } = require("./logger");
const { detectProjectContext } = require("./project-context");
const { createCopilotEndpointPreferences } = require("./copilot-endpoint-preferences");
const { createCopilotModelCatalogStore } = require("./copilot-models");
const { proxyAnthropicRequest } = require("./copilot-proxy");

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
    logger.logIncomingRequest({
      requestId,
      projectPath: projectContext.projectPath,
      projectPathSource: projectContext.source,
      model: req.body?.model,
      stream: req.body?.stream,
    });

    await proxyAnthropicRequest({
      anthropicBody: req.body || {},
      req,
      res,
      requestId,
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
  const port = Number(options.port || process.env.PORT || 4141);
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