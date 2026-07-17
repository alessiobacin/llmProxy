const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Dockerfile marks the runtime image as the global production service", () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");

  assert.match(dockerfile, /ENV PORT=7045 \\/);
  assert.match(dockerfile, /HOST=0\.0\.0\.0 \\/);
  assert.match(dockerfile, /NODE_ENV=production \\/);
  assert.match(dockerfile, /LLMPROXY_ENV=production \\/);
  assert.match(dockerfile, /LLMPROXY_GLOBAL_SERVICE=1/);
});
