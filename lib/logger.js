const fs = require("node:fs");
const path = require("node:path");

function getLogFileName(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `requests-${year}-${month}-${day}.jsonl`;
}

function getArchivedLogFileName(fileName, index) {
  return `${fileName}.${index}`;
}

function createRequestLogger(options = {}) {
  const logsDir = path.resolve(String(options.logsDir || "logs"));
  const retentionDays = Number(options.retentionDays || 7);
  const maxBytes = Number(options.maxBytes || 5 * 1024 * 1024);
  const maxArchivedFiles = Number(options.maxArchivedFiles || 5);
  const nowFn = options.nowFn || Date.now;

  function ensureDir() {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  function pruneOldLogs() {
    ensureDir();
    const cutoff = new Date(nowFn());
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    cutoff.setUTCHours(0, 0, 0, 0);

    for (const file of fs.readdirSync(logsDir)) {
      const match = file.match(/^requests-(\d{4})-(\d{2})-(\d{2})\.jsonl(?:\.\d+)?$/);
      if (!match) continue;
      const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      if (date < cutoff) {
        fs.rmSync(path.join(logsDir, file), { force: true });
      }
    }
  }

  function rotateIfNeeded(filePath, nextEntry) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    if (!fs.existsSync(filePath)) return;

    const currentSize = fs.statSync(filePath).size;
    const nextSize = Buffer.byteLength(nextEntry, "utf8");
    if (currentSize + nextSize <= maxBytes) return;

    const fileName = path.basename(filePath);
    const archivedLimit = Number.isFinite(maxArchivedFiles) && maxArchivedFiles > 0 ? Math.floor(maxArchivedFiles) : 0;

    if (archivedLimit > 0) {
      const lastArchivedPath = path.join(logsDir, getArchivedLogFileName(fileName, archivedLimit));
      fs.rmSync(lastArchivedPath, { force: true });

      for (let index = archivedLimit - 1; index >= 1; index -= 1) {
        const sourcePath = path.join(logsDir, getArchivedLogFileName(fileName, index));
        const targetPath = path.join(logsDir, getArchivedLogFileName(fileName, index + 1));
        if (fs.existsSync(sourcePath)) {
          fs.renameSync(sourcePath, targetPath);
        }
      }

      fs.renameSync(filePath, path.join(logsDir, getArchivedLogFileName(fileName, 1)));
      return;
    }

    fs.rmSync(filePath, { force: true });
  }

  function write(entry) {
    ensureDir();
    pruneOldLogs();
    const filePath = path.join(logsDir, getLogFileName(new Date(nowFn())));
    const serializedEntry = `${JSON.stringify(entry)}\n`;
    rotateIfNeeded(filePath, serializedEntry);
    fs.appendFileSync(filePath, serializedEntry, "utf8");
  }

  function logIncomingRequest(data) {
    write({
      ts: new Date(nowFn()).toISOString(),
      event: "request_in",
      requestId: data.requestId,
      traceId: data.traceId || null,
      mode: data.mode || null,
      route: data.route || null,
      hierarchyContext: data.hierarchyContext || null,
      meteringContext: data.meteringContext || null,
      projectPath: data.projectPath || null,
      projectPathSource: data.projectPathSource || "unknown",
      project: data.projectName || (data.projectPath ? path.basename(data.projectPath) : null),
      projectName: data.projectName || null,
      projectNameSource: data.projectNameSource || "unknown",
      configuredModel: data.configuredModel || null,
      model: data.effectiveModel || data.requestedModel || "unknown",
      requestedModel: data.requestedModel || null,
      effectiveModel: data.effectiveModel || null,
      stream: !!data.stream,
    });
  }

  function logProviderAttempt(data) {
    write({
      ts: new Date(nowFn()).toISOString(),
      event: "provider_attempt",
      requestId: data.requestId,
      project: data.projectName || null,
      projectName: data.projectName || null,
      configuredModel: data.configuredModel || null,
      provider: data.provider,
      endpoint: data.endpoint,
      model: data.effectiveModel || data.requestedModel || "unknown",
      requestedModel: data.requestedModel || null,
      effectiveModel: data.effectiveModel || null,
      toolAdjustment: data.toolAdjustment || null,
    });
  }

  function logProviderResult(data) {
    write({
      ts: new Date(nowFn()).toISOString(),
      event: "provider_result",
      requestId: data.requestId,
      project: data.projectName || null,
      projectName: data.projectName || null,
      configuredModel: data.configuredModel || null,
      provider: data.provider,
      endpoint: data.endpoint,
      success: !!data.success,
      status: data.status ?? null,
      durationMs: data.durationMs ?? null,
      model: data.actualModel || data.effectiveModel || data.requestedModel || "unknown",
      requestedModel: data.requestedModel || null,
      effectiveModel: data.effectiveModel || null,
      actualModel: data.actualModel || null,
      error: data.error ? String(data.error) : null,
    });
  }

  return {
    logsDir,
    logIncomingRequest,
    logProviderAttempt,
    logProviderResult,
  };
}

module.exports = {
  createRequestLogger,
};