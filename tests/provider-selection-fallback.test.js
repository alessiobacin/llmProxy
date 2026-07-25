"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert");
const { resolveProviderSelection } = require("../lib/ts-build/gateway/services/llm-transport");
const { createProviderRegistry } = require("../lib/ts-build/gateway/providers/provider-registry");

// Mock token store with opencode-alessio as first provider
function createMockTokenStore(providers = [], order = null) {
  return {
    listProviders: () => providers,
    getProvider: (id) => providers.find((p) => p.id === id || p.provider === id) || null,
    getProviderOrder: () => order || providers.map((p) => p.id),
  };
}

// Mock provider registry (empty)
function createEmptyRegistry() {
  const entries = [];
  return createProviderRegistry({
    persistence: {
      read: () => ({ entries }),
      write: () => {},
    },
    secret: null,
  });
}

describe("Provider Selection — Token Store Fallback", () => {
  test("when registry is empty, should use first provider from token store", () => {
    const tokenStoreProviders = [
      {
        id: "opencode-alessio",
        provider: "opencode",
        name: "opencode-alessio",
        access_token: "tok-opencode-alessio",
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
      {
        id: "qwen",
        provider: "qwen",
        name: "qwen",
        access_token: "tok-qwen",
        default_model: "qwen3.7-plus",
        disabled: false,
      },
    ];

    const tokenStore = createMockTokenStore(tokenStoreProviders);
    const providerRegistry = createEmptyRegistry();

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore,
      providerRegistry,
    });

    // Should select opencode-alessio (first in token store order)
    assert.ok(result.providerCandidates, "providerCandidates should exist");
    assert.equal(result.providerCandidates.length > 0, true, "should have at least one candidate");
    assert.equal(result.providerCandidates[0].provider, "opencode", "first provider should be opencode");
    assert.equal(result.providerCandidates[0].default_model, "deepseek-v4-flash-free", "model should be deepseek-v4-flash-free");
  });

  test("when registry has entries, should use registry (not token store)", () => {
    const entries = [
      {
        provider: "qwen",
        scope_type: "master",
        scope_id: "*",
        default_model: "qwen3.7-plus",
        priority: 100,
        credentials: { api_key: "tok-qwen" },
        metadata: {},
      },
    ];

    const providerRegistry = createProviderRegistry({
      persistence: {
        read: () => ({ entries }),
        write: () => {},
      },
      secret: null,
    });

    const tokenStoreProviders = [
      {
        id: "opencode-alessio",
        provider: "opencode",
        name: "opencode-alessio",
        access_token: "tok-opencode-alessio",
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
    ];

    const tokenStore = createMockTokenStore(tokenStoreProviders);

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore,
      providerRegistry,
    });

    // Should select qwen from registry (not opencode from token store)
    assert.ok(result.providerCandidates, "providerCandidates should exist");
    assert.equal(result.providerCandidates[0].provider, "qwen", "should use registry provider");
    assert.equal(result.providerCandidates[0].default_model, "qwen3.7-plus", "model should be from registry");
  });

  test("token store providers should maintain insertion order", () => {
    const tokenStoreProviders = [
      {
        id: "first-provider",
        provider: "opencode",
        name: "first",
        access_token: "tok-first",
        default_model: "model-first",
        disabled: false,
      },
      {
        id: "second-provider",
        provider: "qwen",
        name: "second",
        access_token: "tok-second",
        default_model: "model-second",
        disabled: false,
      },
    ];

    const tokenStore = createMockTokenStore(tokenStoreProviders);
    const providerRegistry = createEmptyRegistry();

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore,
      providerRegistry,
    });

    // Should select first provider (opencode)
    assert.equal(result.providerCandidates[0].provider, "opencode", "first provider should be selected");
    assert.equal(result.providerCandidates[0].default_model, "model-first", "first model should be selected");
  });
});

describe("Provider Selection — Registry Order (user-defined priority)", () => {
  test("fallback should sort providers by registry.order, not insertion order", () => {
    // Providers inserted in wrong order (qwen first), but user order is opencode-alessio first
    const tokenStoreProviders = [
      {
        id: "qwen",
        provider: "qwen",
        name: "qwen",
        access_token: "tok-qwen",
        default_model: "qwen3.7-plus",
        disabled: false,
      },
      {
        id: "opencode-alessio",
        provider: "opencode",
        name: "opencode-alessio",
        access_token: "tok-opencode-alessio",
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
      {
        id: "opencode-bacin",
        provider: "opencode",
        name: "opencode-bacin",
        access_token: "tok-opencode-bacin",
        default_model: "bacin-model",
        disabled: false,
      },
    ];

    // User-defined order: opencode-alessio first
    const userOrder = ["opencode-alessio", "opencode-bacin", "qwen"];

    const tokenStore = createMockTokenStore(tokenStoreProviders, userOrder);
    const providerRegistry = createEmptyRegistry();

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore,
      providerRegistry,
    });

    assert.equal(result.source, "token-store", "should use token-store fallback");
    assert.ok(result.providerCandidates, "providerCandidates should exist");
    assert.equal(result.providerCandidates[0].id, "opencode-alessio", "first candidate should be opencode-alessio");
    assert.equal(result.providerCandidates[1].id, "opencode-bacin", "second candidate should be opencode-bacin");
    assert.equal(result.providerCandidates[2].id, "qwen", "third candidate should be qwen");
  });

  test("fallback should handle providers not in order array (append at end)", () => {
    const tokenStoreProviders = [
      {
        id: "kimi",
        provider: "kimi",
        name: "kimi",
        access_token: "tok-kimi",
        default_model: "kimi-model",
        disabled: false,
      },
      {
        id: "vercel-ai-gateway",
        provider: "vercel",
        name: "vercel-ai-gateway",
        access_token: "tok-vercel",
        default_model: "vercel-model",
        disabled: false,
      },
      {
        id: "opencode-alessio",
        provider: "opencode",
        name: "opencode-alessio",
        access_token: "tok-opencode-alessio",
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
      {
        id: "qwen",
        provider: "qwen",
        name: "qwen",
        access_token: "tok-qwen",
        default_model: "qwen3.7-plus",
        disabled: false,
      },
      {
        id: "opencode-bacin",
        provider: "opencode",
        name: "opencode-bacin",
        access_token: "tok-opencode-bacin",
        default_model: "bacin-model",
        disabled: false,
      },
    ];

    // User order includes opencode-seo-newbiz which is NOT in providers
    const userOrder = ["opencode-alessio", "opencode-bacin", "opencode-seo-newbiz", "vercel-ai-gateway", "kimi", "qwen"];

    const tokenStore = createMockTokenStore(tokenStoreProviders, userOrder);
    const providerRegistry = createEmptyRegistry();

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore,
      providerRegistry,
    });

    assert.equal(result.source, "token-store", "should use token-store fallback");
    const ids = result.providerCandidates.map((c) => c.id);
    // opencode-seo-newbiz is in order but not in providers → skipped
    // Remaining should be sorted by their position in order array
    assert.equal(ids[0], "opencode-alessio", "first should be opencode-alessio");
    assert.equal(ids[1], "opencode-bacin", "second should be opencode-bacin");
    assert.equal(ids[2], "vercel-ai-gateway", "third should be vercel-ai-gateway");
    assert.equal(ids[3], "kimi", "fourth should be kimi");
    assert.equal(ids[4], "qwen", "fifth should be qwen");
  });

  test("fallback should work without getProviderOrder (backward compatibility)", () => {
    // Simulate a token store without getProviderOrder
    const mockTokenStore = {
      listProviders: () => [
        { id: "qwen", provider: "qwen", access_token: "tok-qwen", default_model: "qwen-model" },
        { id: "opencode-alessio", provider: "opencode", access_token: "tok-alessio", default_model: "deepseek" },
      ],
      getProvider: (id) => (id === "qwen" ? { id: "qwen", provider: "qwen", access_token: "tok-qwen" } : null),
    };

    const providerRegistry = createEmptyRegistry();

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore: mockTokenStore,
      providerRegistry,
    });

    assert.equal(result.source, "token-store", "should use token-store fallback");
    // Without order info, falls back to listProviders() order (first is qwen)
    assert.equal(result.providerCandidates[0].id, "qwen", "first candidate should be qwen (insertion order)");
  });

  test("disabled providers should be excluded from fallback candidates", () => {
    const tokenStoreProviders = [
      {
        id: "opencode-alessio",
        provider: "opencode",
        name: "opencode-alessio",
        access_token: "", // no token = disabled
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
      {
        id: "qwen",
        provider: "qwen",
        name: "qwen",
        access_token: "tok-qwen",
        default_model: "qwen3.7-plus",
        disabled: false,
      },
    ];

    const userOrder = ["opencode-alessio", "qwen"];
    const tokenStore = createMockTokenStore(tokenStoreProviders, userOrder);
    const providerRegistry = createEmptyRegistry();

    const result = resolveProviderSelection({
      requestedProvider: null,
      requestedModel: null,
      hierarchyContext: {},
      traceId: "test-trace",
      tokenStore,
      providerRegistry,
    });

    assert.equal(result.source, "token-store", "should use token-store fallback");
    // opencode-alessio has no token → filtered out, qwen should be first
    assert.equal(result.providerCandidates[0].id, "qwen", "qwen should be first (opencode-alessio filtered)");
  });
});
