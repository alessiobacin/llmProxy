"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("proxy does not inject Claude Code task-status instructions", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "app.js"), "utf8");
  assert.doesNotMatch(source, /TASK_STATUS_SYSTEM_TEXT/);
  assert.doesNotMatch(source, /Task completato/);
});

test("intent info line controls only prompt annotation", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "lib", "app.js"), "utf8");
  const proxySource = fs.readFileSync(path.join(__dirname, "..", "lib", "copilot-proxy.js"), "utf8");
  assert.match(appSource, /LLMPROXY_INTENT_INFO_LINE/);
  assert.match(proxySource, /header \+= ` \\| Intent: \$\{intentCount\}`/);
  assert.doesNotMatch(proxySource, /LLMPROXY_INTENT_INFO_LINE/);
});
