const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRequestLogger } = require("../lib/logger");

test("request logger writes audit entries with request and project metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-logs-"));
  const logger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-03-26T10:00:00.000Z").getTime(),
  });

  logger.logIncomingRequest({
    requestId: "req_123",
    projectPath: "/Users/example/project-alpha",
    projectPathSource: "header",
    projectName: "yt-monitor",
    projectNameSource: "package.json",
    requestedModel: "glm-5",
    effectiveModel: "claude-sonnet-4.5",
    stream: true,
  });

  logger.logProviderResult({
    requestId: "req_123",
    provider: "default",
    endpoint: "chat",
    success: true,
    status: 200,
    requestedModel: "glm-5",
    effectiveModel: "claude-sonnet-4.5",
    actualModel: "claude-sonnet-4.5",
    projectName: "yt-monitor",
  });

  const files = fs.readdirSync(root);
  assert.equal(files.length, 1);

  const content = fs.readFileSync(path.join(root, files[0]), "utf8");
  assert.match(content, /req_123/);
  assert.match(content, /yt-monitor/);
  assert.match(content, /glm-5/);
  assert.match(content, /claude-sonnet-4.5/);
  assert.match(content, /provider_result/);
  assert.match(content, /"provider":"default"/);
});

test("request logger rotates JSONL logs when they exceed the configured size", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-logs-rotate-"));
  const logger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    maxBytes: 180,
    maxArchivedFiles: 2,
    nowFn: () => new Date("2026-03-26T10:00:00.000Z").getTime(),
  });

  for (let index = 0; index < 6; index += 1) {
    logger.logIncomingRequest({
      requestId: `req_${index}`,
      projectPath: `/Users/example/project-${index}`,
      projectPathSource: "header",
      model: "claude-sonnet-4.5",
      stream: true,
    });
  }

  const files = fs.readdirSync(root).sort();
  assert.deepEqual(files, [
    "requests-2026-03-26.jsonl",
    "requests-2026-03-26.jsonl.1",
    "requests-2026-03-26.jsonl.2",
  ]);

  const archivedContent = fs.readFileSync(path.join(root, "requests-2026-03-26.jsonl.1"), "utf8");
  const currentContent = fs.readFileSync(path.join(root, "requests-2026-03-26.jsonl"), "utf8");
  assert.match(archivedContent, /request_in/);
  assert.match(currentContent, /req_5/);
});

test("request logger persists tool truncation metadata on provider attempts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-logs-tools-"));
  const logger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-03-26T10:00:00.000Z").getTime(),
  });

  logger.logProviderAttempt({
    requestId: "req_tools",
    provider: "default",
    endpoint: "chat",
    requestedModel: "gpt-5.4",
    effectiveModel: "gpt-5.4",
    toolAdjustment: {
      kind: "copilot_tools_truncated",
      originalToolCount: 132,
      effectiveToolCount: 128,
      droppedToolCount: 4,
      toolChoiceAdjusted: false,
    },
  });

  const files = fs.readdirSync(root);
  assert.equal(files.length, 1);

  const entries = fs.readFileSync(path.join(root, files[0]), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "provider_attempt");
  assert.deepEqual(entries[0].toolAdjustment, {
    kind: "copilot_tools_truncated",
    originalToolCount: 132,
    effectiveToolCount: 128,
    droppedToolCount: 4,
    toolChoiceAdjusted: false,
  });
});

test("request logger writes a request summary with provider sequence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-logs-summary-"));
  const logger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-06-10T10:00:00.000Z").getTime(),
  });

  logger.logRequestSummary({
    requestId: "req_summary",
    traceId: "trace_summary",
    projectName: "webapp",
    requestedModel: "claude-sonnet-4.5",
    success: false,
    finalProvider: "backup",
    finalModel: "gpt-4.1",
    finalStatus: 429,
    promptTokens: 11,
    completionTokens: 5,
    providerAttempts: [
      { provider: "default", endpoint: "responses", status: 429, success: false, effective_model: "gpt-5.4", actual_model: null },
      { provider: "kimi", endpoint: "chat", status: 400, success: false, effective_model: "kimi-k2.5", actual_model: null },
      { provider: "backup", endpoint: "chat", status: 429, success: false, effective_model: "gpt-4.1", actual_model: null },
    ],
  });

  const files = fs.readdirSync(root);
  assert.equal(files.length, 1);

  const entries = fs.readFileSync(path.join(root, files[0]), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "request_summary");
  assert.equal(entries[0].attemptCount, 3);
  assert.equal(entries[0].finalProvider, "backup");
  assert.equal(entries[0].promptTokens, 11);
  assert.equal(entries[0].completionTokens, 5);
  assert.equal(entries[0].totalTokens, 16);
  assert.equal(entries[0].providerSequence[0].provider, "default");
  assert.equal(entries[0].providerSequence[1].provider, "kimi");
  assert.equal(entries[0].providerSequence[2].provider, "backup");
});

test("request logger computes today and week token totals from successful summaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-logs-totals-"));
  const logger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-06-10T10:00:00.000Z").getTime(),
  });

  logger.logRequestSummary({
    requestId: "req_today",
    success: true,
    finalProvider: "kimi",
    finalModel: "kimi-k2.5",
    finalStatus: 200,
    promptTokens: 10,
    completionTokens: 5,
    providerAttempts: [],
  });

  const mondayLogger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-06-08T08:00:00.000Z").getTime(),
  });
  mondayLogger.logRequestSummary({
    requestId: "req_monday",
    success: true,
    finalProvider: "openai",
    finalModel: "gpt-4.1",
    finalStatus: 200,
    promptTokens: 4,
    completionTokens: 3,
    providerAttempts: [],
  });

  const sundayLogger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-06-07T08:00:00.000Z").getTime(),
  });
  sundayLogger.logRequestSummary({
    requestId: "req_sunday",
    success: true,
    finalProvider: "backup",
    finalModel: "gpt-4.1",
    finalStatus: 200,
    promptTokens: 20,
    completionTokens: 2,
    providerAttempts: [],
  });

  const totals = logger.getUsageTotals(new Date("2026-06-10T10:00:00.000Z"));
  assert.deepEqual(totals, {
    todayTokens: 15,
    weekTokens: 22,
  });
  assert.deepEqual(logger.getUsageTotals({ provider: "kimi" }, new Date("2026-06-10T10:00:00.000Z")), {
    todayTokens: 15,
    weekTokens: 15,
  });
  assert.deepEqual(logger.getUsageTotals({ provider: "openai" }, new Date("2026-06-10T10:00:00.000Z")), {
    todayTokens: 0,
    weekTokens: 7,
  });
  assert.deepEqual(logger.getUsageTotals({ model: "gpt-4.1" }, new Date("2026-06-10T10:00:00.000Z")), {
    todayTokens: 0,
    weekTokens: 7,
  });
});

test("request logger does not throw when request JSONL is not writable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-logs-eacces-"));
  const logger = createRequestLogger({
    logsDir: root,
    retentionDays: 7,
    nowFn: () => new Date("2026-07-06T10:00:00.000Z").getTime(),
  });
  const originalAppendFileSync = fs.appendFileSync;
  let warningCount = 0;
  const originalConsoleError = console.error;

  fs.appendFileSync = () => {
    const error = new Error("EACCES: permission denied");
    error.code = "EACCES";
    throw error;
  };
  console.error = () => {
    warningCount += 1;
  };

  try {
    assert.doesNotThrow(() => {
      logger.logIncomingRequest({
        requestId: "req_eacces",
        requestedModel: "gpt-5.4",
      });
      logger.logProviderAttempt({
        requestId: "req_eacces",
        provider: "openrouter",
        endpoint: "chat",
      });
    });
    assert.equal(warningCount, 1);
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    console.error = originalConsoleError;
  }
});
