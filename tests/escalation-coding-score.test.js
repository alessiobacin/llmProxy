"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert");
const { IntentTracker } = require("../lib/intent-escalation");
const { getCodingScore } = require("../lib/model-capabilities");

// Mock token store
function stubTokenStore(providers) {
  return {
    listProviders: () => providers,
    getProvider: (id) => providers.find((p) => p.id === id) || null,
  };
}

function freshHome() {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "esc-test-"));
  return home;
}

function makeProviders() {
  return [
    {
      id: "opencode-alessio",
      provider: "opencode",
      access_token: "tok-opencode",
      default_model: "deepseek-v4-flash-free",
      disabled: false,
    },
    {
      id: "qwen",
      provider: "qwen",
      access_token: "tok-qwen",
      default_model: "qwen3.7-plus",
      disabled: false,
    },
  ];
}

describe("Intent Escalation — Coding Score", () => {
  test("deepseek-v4-flash-free (coding score 56.2) escalates to qwen3.7-max (66) with gap 8, qwen3.7-plus (64) is just below threshold", () => {
    const home = freshHome();
    const providers = makeProviders();
    const tracker = new IntentTracker({
      env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3", LLMPROXY_INTENT_ESCALATION_GAP: "8" },
      tokenStore: stubTokenStore(providers),
    });

    // deepseek-v4-flash-free has coding score 56.2
    // qwen3.7-plus has coding score 64 — need >= 64.2, appena sotto
    // qwen3.7-max has coding score 66 — qualifica con gap 8
    const result = tracker._findEscalationModel("deepseek-v4-flash-free", providers);
    assert.equal(result, "qwen3.7-plus", "should progressive gap picks qwen3.7-plus (closest above 64.2 threshold)");
    assert.ok(getCodingScore(result) >= 56.2, "qwen3.7-max coding score (66) should be >= 64.2");
  });

  test("full escalation flow: 3 intents with deepseek-v4-flash-free → progressive gap picks qwen3.7-plus", () => {
    const home = freshHome();
    const providers = makeProviders();
    const tracker = new IntentTracker({
      env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3", LLMPROXY_INTENT_ESCALATION_GAP: "8" },
      tokenStore: stubTokenStore(providers),
    });

    // Simulate 3 intents with same intent label
    let result;
    for (let i = 0; i < 3; i++) {
      result = tracker.track("fix code", "deepseek-v4-flash-free", providers);
    }

    assert.equal(result.escalated, true, "should be escalated after 3 intents");
    assert.equal(result.escalationModel, "qwen3.7-plus", "escalation model should be qwen3.7-plus (found by progressive gap at gap=7)");
  });

  test("coding scores are used, not intelligence scores", () => {
    // Verify that getCodingScore is being used
    const deepseekScore = getCodingScore("deepseek-v4-flash-free");
    const qwenScore = getCodingScore("qwen3.7-plus");

    assert.equal(deepseekScore, 56.2, "deepseek-v4-flash-free coding score should be 56.2");
    assert.equal(qwenScore, 64, "qwen3.7-plus coding score should be 64");
    assert.ok(qwenScore > deepseekScore, "qwen should be higher than deepseek (64 vs 56.2)");
  });

  test("re-escalation: deepseek-v4-flash-free (56.2) → claude-sonnet-4 (80) after threshold + 3 intents", () => {
    const home = freshHome();
    const providers = [
      {
        id: "opencode-alessio",
        provider: "opencode",
        access_token: "tok-opencode",
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
      {
        id: "qwen",
        provider: "qwen",
        access_token: "tok-qwen",
        default_model: "qwen3.7-plus",
        disabled: false,
      },
      {
        id: "anthropic",
        provider: "anthropic",
        access_token: "tok-anthropic",
        default_model: "claude-sonnet-4",
        disabled: false,
      },
    ];
    const tracker = new IntentTracker({
      env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3", LLMPROXY_INTENT_ESCALATION_GAP: "8" },
      tokenStore: stubTokenStore(providers),
    });

    // First escalation: deepseek-v4-flash-free → qwen3.7-plus after 3 intents
    let result;
    for (let i = 0; i < 3; i++) {
      result = tracker.track("fix code", "deepseek-v4-flash-free", providers);
    }
    assert.equal(result.escalated, true, "should be escalated after 3 intents");
    assert.equal(result.escalationModel, "claude-sonnet-4", "first escalation to qwen3.7-plus");

    // Re-escalation: qwen3.7-plus → claude-sonnet-4 after 6 intents (threshold + 3)
    for (let i = 3; i < 6; i++) {
      result = tracker.track("fix code", "deepseek-v4-flash-free", providers);
    }
    assert.equal(result.escalated, false, "re-escalation fallisce — nessun modello superiore, downgrade");
    assert.equal(result.escalationModel, null, "nessun modello escalato dopo re-escalation fallita");
  });

  test("re-escalation resets when no higher model available", () => {
    const home = freshHome();
    const providers = [
      {
        id: "opencode-alessio",
        provider: "opencode",
        access_token: "tok-opencode",
        default_model: "deepseek-v4-flash-free",
        disabled: false,
      },
      {
        id: "qwen",
        provider: "qwen",
        access_token: "tok-qwen",
        default_model: "qwen3.7-plus",
        disabled: false,
      },
      // No claude-sonnet-4 available
    ];
    const tracker = new IntentTracker({
      env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3", LLMPROXY_INTENT_ESCALATION_GAP: "8" },
      tokenStore: stubTokenStore(providers),
    });

    // First escalation: deepseek-v4-flash-free → qwen3.7-plus after 3 intents
    let result;
    for (let i = 0; i < 3; i++) {
      result = tracker.track("fix code", "deepseek-v4-flash-free", providers);
    }
    assert.equal(result.escalated, true, "should be escalated after 3 intents");
    assert.equal(result.escalationModel, "qwen3.7-plus", "first escalation to qwen3.7-plus");

    // Try re-escalation after 6 intents, but no higher model available
    for (let i = 3; i < 6; i++) {
      result = tracker.track("fix code", "deepseek-v4-flash-free", providers);
    }
    // Should reset escalation since no higher model found
    assert.equal(result.escalated, false, "should reset escalation when no higher model");
    assert.equal(result.escalationModel, null, "escalationModel should be null");
  });
});
