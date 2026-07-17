const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("production compose file includes safe fallback bind mounts for local runs", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "docker-compose.production.yml"), "utf8");

  assert.match(compose, /\$\{LLMPROXY_HOME:-\$\{HOME:-\/tmp\}\/Library\/Application Support\/llmProxy\}:/);
  assert.match(compose, /\$\{LLMPROXY_HOST_PROJECTS_ROOT:-\$\{HOME:-\/tmp\}\}:\$\{LLMPROXY_HOST_PROJECTS_ROOT:-\$\{HOME:-\/tmp\}\}:ro/);
});
