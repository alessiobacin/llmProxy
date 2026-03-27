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
    model: "claude-sonnet-4.5",
    stream: true,
  });

  const files = fs.readdirSync(root);
  assert.equal(files.length, 1);

  const content = fs.readFileSync(path.join(root, files[0]), "utf8");
  assert.match(content, /req_123/);
  assert.match(content, /project-alpha/);
  assert.match(content, /claude-sonnet-4.5/);
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