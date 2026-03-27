const test = require("node:test");
const assert = require("node:assert/strict");

const { detectProjectContext } = require("../lib/project-context");

test("detectProjectContext prefers explicit header project path", () => {
  const result = detectProjectContext({
    headers: { "x-project-path": "/tmp/workspace-a" },
    body: {
      metadata: { project_path: "/tmp/workspace-b" },
      system: "Primary working directory: /tmp/workspace-c",
    },
  });

  assert.equal(result.projectPath, "/tmp/workspace-a");
  assert.equal(result.source, "header");
});

test("detectProjectContext extracts path from system prompt when headers are missing", () => {
  const result = detectProjectContext({
    headers: {},
    body: {
      system: [
        {
          type: "text",
          text: "Primary working directory: /Users/example/project-alpha\nOther info",
        },
      ],
    },
  });

  assert.equal(result.projectPath, "/Users/example/project-alpha");
  assert.equal(result.source, "system");
});