const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveProviderSelection } = require("../lib/gateway/services/llm-transport");

test("resolveProviderSelection preserves proxy settings for local providers", () => {
  const selection = resolveProviderSelection({
    requestedProvider: "opencode",
    hierarchyContext: null,
    traceId: "trace-local",
    tokenStore: {
      getProvider(id) {
        if (id !== "opencode") return null;
        return {
          id: "opencode",
          name: "OpenCode",
          provider: "opencode",
          access_token: "sk-test",
          auth_type: "api_key",
          token_type: "api_key",
          scope: "api_key",
          default_model: "deepseek-v4-flash",
          proxy_url: "http://135.181.79.118:7064",
          proxy_api_key: "secret",
        };
      },
    },
    providerRegistry: {
      resolveCandidates() {
        return [];
      },
    },
  });

  assert.equal(selection.source, "local");
  assert.equal(selection.providerCandidates?.[0]?.proxy_url, "http://135.181.79.118:7064");
  assert.equal(selection.providerCandidates?.[0]?.proxy_api_key, "secret");
});

test("resolveProviderSelection preserves proxy settings for registry-backed providers", () => {
  const selection = resolveProviderSelection({
    requestedProvider: "auto",
    hierarchyContext: null,
    traceId: "trace-registry",
    tokenStore: {},
    providerRegistry: {
      resolveCandidates() {
        return [{
          id: "opencode-work",
          provider: "opencode",
          default_model: "deepseek-v4-flash",
          credentials: { api_key: "sk-test" },
          metadata: {
            name: "OpenCode Work",
            auth_type: "api_key",
            token_type: "api_key",
            scope: "api_key",
            proxy_url: "http://135.181.79.118:7064",
            proxy_api_key: "secret",
          },
        }];
      },
    },
  });

  assert.equal(selection.source, "registry");
  assert.equal(selection.providerCandidates?.[0]?.proxy_url, "http://135.181.79.118:7064");
  assert.equal(selection.providerCandidates?.[0]?.proxy_api_key, "secret");
});

test("resolveProviderSelection honors explicit requestedModel hint for local providers", () => {
  const selection = resolveProviderSelection({
    requestedProvider: "opencode-bacin",
    requestedModel: "deepseek-v4-flash-free",
    hierarchyContext: null,
    traceId: "trace-hint",
    tokenStore: {
      getProvider(id) {
        if (id !== "opencode-bacin") return null;
        return {
          id: "opencode-bacin",
          name: "opencode-bacin",
          provider: "opencode",
          access_token: "sk-test",
          auth_type: "api_key",
          token_type: "api_key",
          scope: "api_key",
          default_model: "deepseek-v4-flash",
        };
      },
    },
    providerRegistry: {
      resolveCandidates() {
        return [];
      },
    },
  });

  assert.equal(selection.source, "local");
  assert.equal(selection.provider, "opencode-bacin");
  assert.equal(selection.defaultModel, "deepseek-v4-flash-free");
});

test("parseProviderModelAtLabel extracts provider from model@provider syntax", () => {
  const { parseProviderModelAtLabel } = require("../lib/gateway/services/llm-transport");
  assert.deepEqual(parseProviderModelAtLabel("deepseek-v4-flash-free@opencode-bacin"), {
    model: "deepseek-v4-flash-free",
    provider: "opencode-bacin",
  });
  assert.deepEqual(parseProviderModelAtLabel("claude-opus-4-7"), { model: "claude-opus-4-7", provider: null });
  assert.deepEqual(parseProviderModelAtLabel("plain"), { model: "plain", provider: null });
  // model label starting with @ should still be treated as @provider
  assert.deepEqual(parseProviderModelAtLabel("@opencode-bacin"), { model: "", provider: "opencode-bacin" });
});
