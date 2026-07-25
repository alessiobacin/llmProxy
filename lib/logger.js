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

/**
 * Standalone prune function: removes log files older than retentionDays.
 * Extracted from the closure so it can run on a timer instead of on every write.
 */
function pruneOldLogs(logsDir, retentionDays, nowFn) {
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

function createRequestLogger(options = {}) {
  const logsDir = path.resolve(String(options.logsDir || "logs"));
  const retentionDays = Number(options.retentionDays || 7);
  const maxBytes = Number(options.maxBytes || 5 * 1024 * 1024);
  const maxArchivedFiles = Number(options.maxArchivedFiles || 5);
  const nowFn = options.nowFn || Date.now;
  let writeWarningEmitted = false;

  // Hourly timer for log pruning (instead of pruning on every write)
  function runPrune() {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
      pruneOldLogs(logsDir, retentionDays, nowFn);
    } catch {
      // best effort
    }
  }
  runPrune();
  const pruneTimer = setInterval(runPrune, 3600000);
  pruneTimer.unref();

  function warnWriteFailure(error) {
    if (writeWarningEmitted) return;
    writeWarningEmitted = true;
    const message = error instanceof Error ? error.message : String(error || "unknown logger error");
    try {
      console.error(`[llmproxy logger] disabling request JSONL writes: ${message}`);
    } catch {
      // best effort only
    }
  }

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
    try {
      ensureDir();
      const filePath = path.join(logsDir, getLogFileName(new Date(nowFn())));
      const serializedEntry = `${JSON.stringify(entry)}\n`;
      rotateIfNeeded(filePath, serializedEntry);
      fs.appendFileSync(filePath, serializedEntry, "utf8");
    } catch (error) {
      warnWriteFailure(error);
    }
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

  function logRequestSummary(data) {
    write({
      ts: new Date(nowFn()).toISOString(),
      event: "request_summary",
      requestId: data.requestId,
      traceId: data.traceId || null,
      project: data.projectName || null,
      projectName: data.projectName || null,
      configuredModel: data.configuredModel || null,
      requestedModel: data.requestedModel || null,
      success: !!data.success,
      finalProvider: data.finalProvider || null,
      finalModel: data.finalModel || null,
      finalStatus: typeof data.finalStatus === "number" ? data.finalStatus : null,
      promptTokens: typeof data.promptTokens === "number" ? data.promptTokens : null,
      completionTokens: typeof data.completionTokens === "number" ? data.completionTokens : null,
      totalTokens: typeof data.totalTokens === "number"
        ? data.totalTokens
        : ((Number(data.promptTokens || 0) + Number(data.completionTokens || 0)) || null),
      attemptCount: Array.isArray(data.providerAttempts) ? data.providerAttempts.length : 0,
      providerSequence: Array.isArray(data.providerAttempts)
        ? data.providerAttempts.map((attempt) => ({
            provider: attempt.provider || null,
            endpoint: attempt.endpoint || null,
            status: typeof attempt.status === "number" ? attempt.status : null,
            success: attempt.success === true,
            effective_model: attempt.effective_model || null,
            actual_model: attempt.actual_model || null,
          }))
        : [],
    });
  }

  function getUsageTotals(filtersOrAt = new Date(nowFn()), maybeAt = new Date(nowFn())) {
    try {
      ensureDir();
    } catch {
      return { todayTokens: 0, weekTokens: 0 };
    }
    const usingFilters = filtersOrAt && typeof filtersOrAt === "object" && !(filtersOrAt instanceof Date);
    const filters = usingFilters ? filtersOrAt : {};
    const at = usingFilters ? maybeAt : filtersOrAt;
    const providerFilter = filters?.provider ? String(filters.provider) : null;
    const modelFilter = filters?.model ? String(filters.model) : null;
    const target = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    const dayStart = new Date(target.getTime());
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart.getTime());
    const daysSinceMonday = (weekStart.getDay() + 6) % 7;
    weekStart.setDate(weekStart.getDate() - daysSinceMonday);

    let todayTokens = 0;
    let weekTokens = 0;

    let files = [];
    try {
      files = fs.readdirSync(logsDir);
    } catch {
      return { todayTokens: 0, weekTokens: 0 };
    }

    for (const file of files) {
      if (!/^requests-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(file)) continue;
      const filePath = path.join(logsDir, file);
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.event !== "request_summary" || entry?.success !== true) continue;
        if (providerFilter && String(entry?.finalProvider || "") !== providerFilter) continue;
        if (modelFilter && String(entry?.finalModel || "") !== modelFilter) continue;
        const ts = entry?.ts ? new Date(entry.ts) : null;
        if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) continue;
        const totalTokens = Number.isFinite(Number(entry.totalTokens))
          ? Number(entry.totalTokens)
          : Number(entry.promptTokens || 0) + Number(entry.completionTokens || 0);
        if (!Number.isFinite(totalTokens) || totalTokens <= 0) continue;
        if (ts >= dayStart) todayTokens += totalTokens;
        if (ts >= weekStart) weekTokens += totalTokens;
      }
    }

    return { todayTokens, weekTokens };
  }

  function getModelBreakdownTotals(at = new Date(nowFn())) {
    const breakdown = { today: {}, week: {} };
    try {
      ensureDir();
    } catch {
      return breakdown;
    }
    const target = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    const dayStart = new Date(target.getTime());
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart.getTime());
    const daysSinceMonday = (weekStart.getDay() + 6) % 7;
    weekStart.setDate(weekStart.getDate() - daysSinceMonday);

    let files = [];
    try {
      files = fs.readdirSync(logsDir);
    } catch {
      return breakdown;
    }

    for (const file of files) {
      if (!/^requests-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(file)) continue;
      const filePath = path.join(logsDir, file);
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry?.event !== "request_summary" || entry?.success !== true) continue;
        const model = String(entry?.finalModel || "unknown").trim();
        if (!model) continue;
        const ts = entry?.ts ? new Date(entry.ts) : null;
        if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) continue;
        const inputTokens = Number.isFinite(Number(entry.promptTokens)) ? Number(entry.promptTokens) : 0;
        const outputTokens = Number.isFinite(Number(entry.completionTokens)) ? Number(entry.completionTokens) : 0;
        if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) continue;
        if (ts >= dayStart) {
          breakdown.today[model] = breakdown.today[model] || { inputTokens: 0, outputTokens: 0 };
          breakdown.today[model].inputTokens += inputTokens;
          breakdown.today[model].outputTokens += outputTokens;
        }
        if (ts >= weekStart) {
          breakdown.week[model] = breakdown.week[model] || { inputTokens: 0, outputTokens: 0 };
          breakdown.week[model].inputTokens += inputTokens;
          breakdown.week[model].outputTokens += outputTokens;
        }
      }
    }

    return breakdown;
  }

  return {
    logsDir,
    logIncomingRequest,
    logProviderAttempt,
    logProviderResult,
    logRequestSummary,
    getUsageTotals,
    getModelBreakdownTotals,
    close() {
      clearInterval(pruneTimer);
    },
  };
}

module.exports = {
  createRequestLogger,
};
