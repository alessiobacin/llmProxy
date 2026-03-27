const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createTokenStore } = require("../lib/token-store");
const { pollForToken } = require("../lib/copilot-auth");

test("pollForToken persists access token after authorization completes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-auth-"));
  const tokenFile = path.join(tempRoot, "copilot-token.json");
  const store = createTokenStore({ filePath: tokenFile });

  const payloads = [
    { error: "authorization_pending" },
    { access_token: "token-123", token_type: "bearer", scope: "read:user" },
  ];

  const fetchFn = async () => ({
    ok: true,
    async json() {
      return payloads.shift();
    },
  });

  const result = await pollForToken("device-code-1", 0, {
    fetchFn,
    store,
    sleep: async () => {},
  });

  assert.equal(result.success, true);
  assert.equal(store.getAccessToken(), "token-123");
});