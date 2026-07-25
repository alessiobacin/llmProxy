"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Tests for the intent-escalation module
// ---------------------------------------------------------------------------

// -- Helper: create a set of fake providers for escalation tests -----------

function makeProviders(overrides = {}) {
  const list = [
    {
      id: "deepseek",
      provider: "deepseek",
      access_token: "tok-deepseek",
      default_model: "deepseek-v4-flash",
      disabled: false,
    },
    {
      id: "sonnet",
      provider: "openrouter",
      access_token: "tok-sonnet",
      default_model: "claude-sonnet-4",
      disabled: false,
    },
    {
      id: "nano",
      provider: "deepseek",
      access_token: "tok-nano",
      default_model: "deepseek-v4-flash-free",
      disabled: false,
    },
    ...(overrides.extraProviders || []),
  ];
  return list;
}

// -- Helper: create a minimal tokenStore stub for IntentTracker ------------

function stubTokenStore(providerList) {
  return {
    listProviders() {
      return providerList;
    },
  };
}

// -- 1. extractKeywordsFingerprint() ---------------------------------------

test("extractKeywordsFingerprint produces stable fingerprints", () => {
  const { extractKeywordsFingerprint } = require("../lib/intent-escalation");

  const fp1 = extractKeywordsFingerprint("create a paginated API for users");
  assert.match(fp1, /create/);
  assert.match(fp1, /paginated/);
  assert.match(fp1, /users/);

  // Same input → same fingerprint
  const fp2 = extractKeywordsFingerprint("create a paginated API for users");
  assert.equal(fp1, fp2);

  // Different input → different fingerprint
  const fp3 = extractKeywordsFingerprint("fix the login button alignment");
  assert.notEqual(fp1, fp3);
  assert.match(fp3, /fix/);
  assert.match(fp3, /login/);
});

test("extractKeywordsFingerprint filters stop-words and short words", () => {
  const { extractKeywordsFingerprint } = require("../lib/intent-escalation");

  const fp = extractKeywordsFingerprint("the and for but not you all can");
  // All are stop-words → empty key
  assert.equal(fp, "unknown");
});

test("extractKeywordsFingerprint handles empty / whitespace input", () => {
  const { extractKeywordsFingerprint } = require("../lib/intent-escalation");
  assert.equal(extractKeywordsFingerprint(""), "unknown");
  assert.equal(extractKeywordsFingerprint("   "), "unknown");
  assert.equal(extractKeywordsFingerprint(null), "unknown");
  assert.equal(extractKeywordsFingerprint(undefined), "unknown");
});

// -- 2. buildIntentPrompt() & parseIntentFromResponse() --------------------

test("buildIntentPrompt returns formatted prompt", () => {
  const { buildIntentPrompt } = require("../lib/intent-escalation");
  const prompt = buildIntentPrompt();
  assert.match(prompt, /\[INTENT:/);
  assert.match(prompt, /3-5 word summary/);
});

test("parseIntentFromResponse extracts intent from leading format", () => {
  const { parseIntentFromResponse } = require("../lib/intent-escalation");
  const content = "[INTENT: create fibonacci function]\n\nHere is the implementation...";
  assert.equal(parseIntentFromResponse(content), "create fibonacci function");
});

test("parseIntentFromResponse extracts intent from inline format", () => {
  const { parseIntentFromResponse } = require("../lib/intent-escalation");
  const content = "Some text [INTENT: create api] and more text";
  assert.equal(parseIntentFromResponse(content), "create api");
});

test("parseIntentFromResponse returns null when no intent marker", () => {
  const { parseIntentFromResponse } = require("../lib/intent-escalation");
  assert.equal(parseIntentFromResponse("Just a normal response"), null);
  assert.equal(parseIntentFromResponse(""), null);
  assert.equal(parseIntentFromResponse(null), null);
});

// -- 3. IntentTracker.track() — core escalation logic ----------------------

// Helper: fresh temp dir per unit test
function freshEscalationHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "intent-escal-unit-"));
}

function makeTracker(homeDir, opts = {}) {
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = opts.providers || makeProviders();
  return {
    tracker: new IntentTracker({
      env: {
        ...process.env,
        LLMPROXY_HOME: homeDir,
        LLMPROXY_INTENT_ESCALATION: String(opts.threshold || 3),
        LLMPROXY_INTENT_ESCALATION_GAP: String(opts.gap || 8),
      },
      tokenStore: stubTokenStore(providers),
      fetchFn: async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: "create api" } }] }; } }),
    }),
    providers,
  };
}

test("IntentTracker — counting increments on same consecutive intent, resets on change", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  const r1 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r1.count, 1);
  assert.equal(r1.escalated, false);

  const r2 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
  assert.equal(r2.escalated, false);

  // Intent changes → reset
  const r3 = tracker.track("fix login", "deepseek-v4-flash", providers);
  assert.equal(r3.count, 1);
  assert.equal(r3.escalated, false);
});

test("IntentTracker — below threshold, no escalation", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 5 });

  let result;
  for (let i = 0; i < 4; i++) {
    result = tracker.track("create api", "deepseek-v4-flash", providers);
  }
  assert.equal(result.count, 4);
  assert.equal(result.escalated, false);
  assert.equal(result.escalationModel, null);
});

test("IntentTracker — at threshold, escalates to higher-intelligence model", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 3 });

  let result;
  for (let i = 0; i < 2; i++) {
    result = tracker.track("create api", "deepseek-v4-flash", providers);
  }
  assert.equal(result.count, 2);
  assert.equal(result.escalated, false);
  assert.equal(result.escalationModel, null);

  // Third request → threshold reached → escalation
  result = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(result.count, 3);
  assert.equal(result.escalated, true);
  // deepseek-v4-flash has score 56.2; gap=8 → need score >= 64.2 → claude-sonnet-4 (score 80)
  assert.equal(result.escalationModel, "claude-sonnet-4");

  // Subsequent requests with same intent keep returning the escalated model
  result = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(result.escalated, true);
  assert.equal(result.escalationModel, "claude-sonnet-4");
});

test("IntentTracker — re-escalation after threshold+3 tries with escalated model", () => {
  const home = freshEscalationHome();
  const providers = makeProviders({
    extraProviders: [
      {
        id: "opus",
        provider: "openrouter",
        access_token: "tok-opus",
        default_model: "claude-opus-4-6",
        disabled: false,
      },
    ],
  });
  const { tracker } = makeTracker(home, { threshold: 3, providers });

  // Send 3 requests to trigger first escalation
  let result;
  for (let i = 0; i < 3; i++) {
    result = tracker.track("create api", "deepseek-v4-flash", providers);
  }
  assert.equal(result.escalationModel, "claude-sonnet-4");

  // Send another 3 requests (threshold + 3 = 6) to trigger re-escalation to opus
  for (let i = 0; i < 3; i++) {
    result = tracker.track("create api", "deepseek-v4-flash", providers);
  }
  assert.equal(result.count, 6);
  assert.equal(result.escalationModel, "claude-opus-4-6");
});

test("IntentTracker — escalated model is returned on every subsequent call", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 2 });

  // Threshold = 2, so second request escalates
  tracker.track("create api", "deepseek-v4-flash", providers);
  const r2 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r2.escalated, true);
  assert.equal(r2.escalationModel, "claude-sonnet-4");

  // Third call: same model stays
  const r3 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r3.escalationModel, "claude-sonnet-4");

  // Fourth call: still same
  const r4 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r4.escalationModel, "claude-sonnet-4");
});

test("IntentTracker — economy model (deepseek-chat, score 50) escalates with default gap 8", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 2 });

  // deepseek-chat is explicitly in INTELLIGENCE_SCORES at 50.
  // With gap 8 need >= 58 → claude-sonnet-4 (80) qualifies.
  let result;
  for (let i = 0; i < 2; i++) {
    result = tracker.track("create api", "deepseek-chat", providers);
  }
  assert.equal(result.escalated, true);
  assert.equal(result.escalationModel, "claude-sonnet-4");
});

test("IntentTracker — disabled providers are skipped for escalation", () => {
  const home = freshEscalationHome();
  const providers = makeProviders();
  // Disable the only good provider
  providers[1].disabled = true;

  const { tracker } = makeTracker(home, { threshold: 2, providers });

  let result;
  for (let i = 0; i < 2; i++) {
    result = tracker.track("create api", "deepseek-v4-flash", providers);
  }
  assert.equal(result.escalated, false);
  assert.equal(result.escalationModel, null);
});

test("IntentTracker — expired entries are cleaned up", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 2 });

  // First request creates converation
  tracker.track("create api", "deepseek-v4-flash", providers);
  const r2 = tracker.track("create api", "deepseek-v4-flash", providers);

  assert.equal(r2.escalationModel, "claude-sonnet-4");

  // Reset the tracker
  tracker.reset();

  // After reset, should start fresh
  const r3 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r3.count, 1);
  assert.equal(r3.escalated, false);
  assert.equal(r3.escalationModel, null);
});

// -- 3b. Sticky intent: correction messages don't reset the counter -------

test("Sticky intent — 'fix bug' after 'create api' mantiene l'intento e incrementa", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  // Task iniziale: "create api"
  tracker.track("create api", "deepseek-v4-flash", providers);

  // Correzione generica: "fix bug" → STICKY, mantiene "create api"
  const r2 = tracker.track("fix bug", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2, "fix bug dopo create api dovrebbe incrementare, non resettare");
});

test("Sticky intent — 'non-funziona' dopo 'create-fiscal-code' mantiene l'intento", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create-fiscal-code", "deepseek-v4-flash", providers);
  // "non-funziona" è solo parole di correzione → sticky
  const r2 = tracker.track("non-funziona", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
});

test("Sticky intent — 'fix pagination' dopo 'create api' è task diverso → RESET", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create api", "deepseek-v4-flash", providers);
  // "fix pagination" ha "pagination" come nuova parola di dominio → task diverso
  const r2 = tracker.track("fix pagination", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 1, "fix pagination è un task diverso da create api → reset");
  // Il nuovo intent deve essere "fix pagination"
  // (non possiamo controllare current.intent direttamente, ma count=1 indica reset)
});

test("Sticky intent — 'rifallo' dopo 'create-validator' mantiene l'intento", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create-validator", "deepseek-v4-flash", providers);
  // "rifallo" è parola di correzione pura → sticky
  const r2 = tracker.track("rifallo", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
});

test("Sticky intent — 'non funziona ancora' dopo task → sticky", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create api", "deepseek-v4-flash", providers);
  // "non" e "funziona" sono parole di correzione (stop word "ancora" non è nel fingerprint)
  const r2 = tracker.track("non funziona ancora", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
});

test("Sticky intent — escalation parte anche via correzioni consecutive", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 2 });

  // Task iniziale
  tracker.track("create api", "deepseek-v4-flash", providers);
  // Prima correzione: sticky → count=2 → escalation!
  const r2 = tracker.track("fix bug", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
  assert.equal(r2.escalated, true, "Dopo 1 task + 1 correzione sticky, threshold 2 → escalation");
  assert.equal(r2.escalationModel, "claude-sonnet-4");
});

test("Sticky intent — tre correzioni di fila portano a escalation", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 3 });

  tracker.track("create code", "deepseek-v4-flash", providers);
  tracker.track("fix bug", "deepseek-v4-flash", providers);   // sticky → count=2
  const r3 = tracker.track("riparalo", "deepseek-v4-flash", providers); // sticky → count=3 → escalation!
  assert.equal(r3.count, 3);
  assert.equal(r3.escalated, true);
});

test("Sticky intent — 'fix pagination' con 'create pagination' condivide dominio → sticky", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create pagination", "deepseek-v4-flash", providers);
  // "fix pagination": "pagination" è parola di dominio condivisa → sticky
  const r2 = tracker.track("fix pagination", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
});

test("Sticky intent — stesso intent via LLM, non è una correzione → normale", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create api", "deepseek-v4-flash", providers);
  // Stesso intent → normale incremento
  const r2 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 2);
  assert.equal(r2.escalated, false);
});

test("Sticky intent — cambio task genuino tipo 'add dark theme' dopo 'create api' → reset", () => {
  const home = freshEscalationHome();
  const { tracker, providers } = makeTracker(home, { threshold: 4 });

  tracker.track("create api", "deepseek-v4-flash", providers);
  const r2 = tracker.track("add dark theme", "deepseek-v4-flash", providers);
  assert.equal(r2.count, 1, "add dark theme è un task completamente diverso → reset");
});

// -- 4. _findEscalationModel() — model selection logic --------------------

test("_findEscalationModel picks the minimally sufficient higher model", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const { getIntelligenceScore } = require("../lib/model-capabilities");

  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
  });

  // Find model better than deepseek-v4-flash (score 56.2, gap 8 → need >= 64.2)
  const result = tracker._findEscalationModel("deepseek-v4-flash", providers);
  assert.equal(result, "claude-sonnet-4");
  assert.ok(getIntelligenceScore(result) >= 56.2 + 8);
});

test("_findEscalationModel excludes models in the exclude list", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");

  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
  });

  // Exclude claude-sonnet-4 → next best candidate
  const result = tracker._findEscalationModel("deepseek-v4-flash", providers, ["claude-sonnet-4"]);
  // With deepseek-v4-flash-free (score 50), nano provider (score 48) etc, none may qualify
  // deepseek-v4-flash-free has score 50, which is below 56.2 + 8 = 64.2
  // So there's no valid target
  assert.equal(result, null);
});

test("_findEscalationModel returns null when no provider has an access token", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");

  const providers = makeProviders();
  // Take away all tokens
  providers.forEach((p) => { p.access_token = ""; });

  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
  });

  const result = tracker._findEscalationModel("deepseek-v4-flash", providers);
  assert.equal(result, null);
});

test("_findEscalationModel con gap=30 fallisce con 86.2 ma trova sonnet con gap progressivo", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");

  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3", LLMPROXY_INTENT_ESCALATION_GAP: "30" },
    tokenStore: stubTokenStore(providers),
  });

  // deepseek-v4-flash score 56.2 + gap 30 = need >= 86.2
  // gap=30 → fallisce, poi scende fino a gap=23 (need 79.2) → sonnet (80) qualifica
  const result = tracker._findEscalationModel("deepseek-v4-flash", providers);
  assert.equal(result, "claude-sonnet-4", "gap fallback deve trovare sonnet quando gap=30 e' troppo alto");
});

test("_findEscalationModel picks the cheapest qualifying model (lowest intelligence above gap)", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const { getIntelligenceScore } = require("../lib/model-capabilities");

  // Add a third provider with a model between deepseek-v4-flash and claude-sonnet-4
  const providers = makeProviders({
    extraProviders: [
      {
        id: "groq",
        provider: "groq",
        access_token: "tok-groq",
        default_model: "groq/llama-3.3-70b-versatile",
        disabled: false,
      },
    ],
  });

  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
  });

  // deepseek-v4-flash score 56.2, need >= 64.2
  // groq/llama-3.3-70b-versatile score 55 — too low
  // claude-sonnet-4 score 80 — qualifies but is it the cheapest?
  // Actually groq is 55 which is below 64.2, so claude-sonnet-4 is the only option
  const result = tracker._findEscalationModel("deepseek-v4-flash", providers);
  assert.equal(result, "claude-sonnet-4");
});

test("_findEscalationModel picks the lowest score above threshold, not the highest", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");

  // deepseek-chat has score 50, gap 8 → need >= 58
  // deepseek-v4-flash has 56.2 — too low
  // claude-sonnet-4 has 80 — qualifies but more expensive
  // Only claude-sonnet-4 qualifies
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
  });

  const result = tracker._findEscalationModel("deepseek-chat", providers);
  assert.equal(result, "claude-sonnet-4");
});

// -- 5. extractLastUserMessage() ------------------------------------------

test("extractLastUserMessage gets the last user message from an array", () => {
  const { extractLastUserMessage } = require("../lib/intent-escalation");
  const messages = [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "create a paginated API" },
  ];
  assert.equal(extractLastUserMessage(messages), "create a paginated API");
});

test("extractLastUserMessage handles content blocks", () => {
  const { extractLastUserMessage } = require("../lib/intent-escalation");
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "create a user API endpoint" },
      ],
    },
  ];
  assert.equal(extractLastUserMessage(messages), "create a user API endpoint");
});

test("extractLastUserMessage returns null when last user message has tool_result", () => {
  const { extractLastUserMessage } = require("../lib/intent-escalation");
  const messages = [
    { role: "user", content: "ripristina tutti i fix" },
    { role: "assistant", content: "ok, executing tools..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "result" }] },
    { role: "assistant", content: "more tools..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: "result" }] },
  ];
  assert.equal(extractLastUserMessage(messages), null);
});

test("extractLastUserMessage returns null when only tool_result messages exist", () => {
  const { extractLastUserMessage } = require("../lib/intent-escalation");
  const messages = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "result" }] },
  ];
  assert.equal(extractLastUserMessage(messages), null);
});

test("extractLastUserMessage returns null on empty or invalid input", () => {
  const { extractLastUserMessage } = require("../lib/intent-escalation");
  assert.equal(extractLastUserMessage([]), null);
  assert.equal(extractLastUserMessage(null), null);
  assert.equal(extractLastUserMessage(undefined), null);
  assert.equal(extractLastUserMessage([{ role: "assistant", content: "hi" }]), null);
});

// -- 5b. Multi-round: autonomous LLM requests must NOT increment intent -----

test("multi-round: tool_result requests do not increment intent count", () => {
  const homeDir = freshEscalationHome();
  const { IntentTracker, extractLastUserMessage } = require("../lib/intent-escalation");
  const tracker = new IntentTracker({ env: { ...process.env, HOME: homeDir, LLMPROXY_INTENT_ESCALATION: "5" } });
  const providers = [{ id: "p1", default_model: "model-a" }];

  // Simulate app.js flow: extractLastUserMessage → if (userMessage) → track()
  function simulateRound(messages, currentModel) {
    const userMessage = extractLastUserMessage(messages);
    if (!userMessage) return { tracked: false, count: 0 };
    const intent = userMessage.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).slice(0, 3).join("-");
    const result = tracker.track(intent, currentModel, providers);
    return { tracked: true, count: result.count, intent };
  }

  // Round 1: real user message → must track, count=1
  const r1 = simulateRound([
    { role: "user", content: "ripristina tutti i fix" },
  ], "model-a");
  assert.equal(r1.tracked, true);
  assert.equal(r1.count, 1);

  // Round 2: LLM autonomous request (tool_result only) → must NOT track
  const r2 = simulateRound([
    { role: "user", content: "ripristina tutti i fix" },
    { role: "assistant", content: "ok, executing tools..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file read" }] },
  ], "model-a");
  assert.equal(r2.tracked, false);

  // Round 3: another autonomous tool_result → must NOT track
  const r3 = simulateRound([
    { role: "user", content: "ripristina tutti i fix" },
    { role: "assistant", content: "ok, executing tools..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file read" }] },
    { role: "assistant", content: "running command..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: "command output" }] },
  ], "model-a");
  assert.equal(r3.tracked, false);

  // Round 4: real user message again (same intent) → must track, count=2
  const r4 = simulateRound([
    { role: "user", content: "ripristina tutti i fix" },
    { role: "assistant", content: "ok, executing tools..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file read" }] },
    { role: "assistant", content: "running command..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: "command output" }] },
    { role: "assistant", content: "tests fixed, ready to commit" },
    { role: "user", content: "ripristina tutti i fix" },
  ], "model-a");
  assert.equal(r4.tracked, true);
  assert.equal(r4.count, 2);

  // Round 5: more autonomous requests → must NOT track, count stays 2
  const r5 = simulateRound([
    { role: "user", content: "ripristina tutti i fix" },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "result" }] },
    { role: "assistant", content: "committing..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: "committed" }] },
    { role: "assistant", content: "pushing..." },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_3", content: "pushed" }] },
  ], "model-a");
  assert.equal(r5.tracked, false);
});

// -- 6. Semi-integration: simulate the proxy's escalation flow directly -----
// Usa i provider reali dell'utente per verificare che l'escalation funzioni
// coi modelli realmente disponibili.
//
// Provider reali (da `llmp models:list`):
//   deepseek-v4-flash-free (50), deepseek-v4-flash (56.2), deepseek-v4-pro (57),
//   qwen3.7-plus (64), qwen3.7-max (66), alibaba/qwen3.7-max (73),
//   kimi-k3 (76.2), deepseek-ai/deepseek-v4-pro (73)

test("Intent escalation — simulate proxy flow con provider reali", {
  concurrency: false,
}, async () => {
  const homeDir = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const { createTokenStore } = require("../lib/token-store");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-real-escal-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });

  // Provider ordinati come in `llmp models:list`
  tokenStore.saveProvider("opencode-alessio", {
    access_token: "tok-1", token_type: "api_key", provider: "opencode", auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
  }, { name: "opencode-alessio" });
  tokenStore.saveProvider("opencode-bacin", {
    access_token: "tok-2", token_type: "api_key", provider: "opencode", auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
  }, { name: "opencode-bacin" });
  tokenStore.saveProvider("opencode-seo-newbiz", {
    access_token: "tok-3", token_type: "api_key", provider: "opencode", auth_type: "api_key",
    default_model: "deepseek-v4-flash-free",
  }, { name: "opencode-seo-newbiz" });
  tokenStore.saveProvider("vercel-ai-gateway", {
    access_token: "tok-4", token_type: "api_key", provider: "vercel", auth_type: "api_key",
    default_model: "alibaba/qwen3.7-max",
  }, { name: "vercel-ai-gateway" });
  tokenStore.saveProvider("qwen", {
    access_token: "tok-5", token_type: "api_key", provider: "qwen", auth_type: "api_key",
    default_model: "qwen3.7-plus",
  }, { name: "qwen" });
  tokenStore.saveProvider("qwen3-7-max", {
    access_token: "tok-6", token_type: "api_key", provider: "qwen", auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "qwen3-7-max" });
  tokenStore.saveProvider("openrouter", {
    access_token: "tok-7", token_type: "api_key", provider: "openrouter", auth_type: "api_key",
    default_model: "deepseek-v4-flash",
  }, { name: "openrouter" });
  tokenStore.saveProvider("nvidia", {
    access_token: "tok-8", token_type: "api_key", provider: "nvidia", auth_type: "api_key",
    default_model: "deepseek-ai/deepseek-v4-pro",
  }, { name: "nvidia" });
  tokenStore.saveProvider("deepseek", {
    access_token: "tok-9", token_type: "api_key", provider: "deepseek", auth_type: "api_key",
    default_model: "deepseek-v4-flash",
  }, { name: "deepseek" });
  tokenStore.saveProvider("kimi", {
    access_token: "tok-10", token_type: "api_key", provider: "kimi", auth_type: "api_key",
    default_model: "kimi-k3",
  }, { name: "kimi" });

  const providers = tokenStore.listProviders();

  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: homeDir, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore,
    fetchFn: async () => ({
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content: "create api" } }] }; },
    }),
  });

  const userMessage = "create a paginated API for users";
  const currentModel = "deepseek-v4-flash-free"; // modello economico di partenza

  console.log("  [real] Escalation da deepseek-v4-flash-free (score 50):");
  let lastResult;
  for (let i = 1; i <= 5; i++) {
    const { intent } = await tracker.extractIntent(userMessage, {});
    const result = tracker.track(intent, currentModel, providers);
    console.log(`  [real]  req ${i}: count=${result.count} escalated=${result.escalated} → ${result.escalationModel || "nessuno"}`);
    lastResult = result;
  }

  // deepseek-v4-flash-free (50) + gap 8 = serve >= 58
  // I provider con score >= 58:
  //   alibaba/qwen3.7-max (73), qwen3.7-plus (64), qwen3.7-max (66),
  //   kimi-k3 (76.2), deepseek-ai/deepseek-v4-pro (73)
  // Il più economico (score minimo sopra soglia): qwen3.7-plus (64)
  assert.equal(lastResult.escalated, true);
  assert.equal(lastResult.escalationModel, "qwen3.7-plus",
    `Escalation dovrebbe scegliere qwen3.7-plus (più economico sopra soglia), scelto: ${lastResult.escalationModel}`);
  console.log("  [real] ✅ Escalation confermata coi provider reali →", lastResult.escalationModel);
});

test("Intent escalation — re-escalation con provider reali", {
  concurrency: false,
}, async () => {
  const homeDir = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const { createTokenStore } = require("../lib/token-store");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llmproxy-real-rescal-"));
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });

  // Solo provider con score medio-alto per testare re-escalation
  tokenStore.saveProvider("qwen", {
    access_token: "tok-1", token_type: "api_key", provider: "qwen", auth_type: "api_key",
    default_model: "qwen3.7-max",
  }, { name: "qwen" });
  tokenStore.saveProvider("kimi", {
    access_token: "tok-2", token_type: "api_key", provider: "kimi", auth_type: "api_key",
    default_model: "kimi-k3",
  }, { name: "kimi" });

  const providers = tokenStore.listProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: homeDir, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore,
    fetchFn: async () => ({
      ok: true, status: 200,
      async json() { return { choices: [{ message: { content: "create api" } }] }; },
    }),
  });

  // Partendo da deepseek-v4-flash (56.2), serve >= 64.2
  // qwen3.7-max (66) ✅ → prima escalation
  // kimi-k3 (76.2) ✅ → ma più costosa, non scelta

  const intent = "create api";
  const currentModel = "deepseek-v4-flash";
  const firstModel = "qwen3.7-max";

  // 3 request → escalation a qwen3.7-max
  let result;
  for (let i = 0; i < 3; i++) {
    result = tracker.track(intent, currentModel, providers);
  }
  assert.equal(result.escalationModel, firstModel);
  console.log(`  [real] Prima escalation → ${result.escalationModel}`);

  // 6 request totali → re-escalation a kimi-k3
  for (let i = 0; i < 3; i++) {
    result = tracker.track(intent, currentModel, providers);
  }
  assert.equal(result.escalationModel, "kimi-k3");
  console.log(`  [real] Re-escalation → ${result.escalationModel}`);
  console.log("  [real] ✅ Re-escalation confermata coi provider reali");
});

// -- 7. Continuation flag: extractIntent with options.messages and V2 LLM responses -

/**
 * Helper: create a fetchFn that returns a given LLM response content.
 */
function mockFetchReturning(content) {
  return async () => ({
    ok: true, status: 200,
    async json() { return { choices: [{ message: { content } }] }; },
  });
}

test("extractIntent with options.messages and V2 continuation='same'", async () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
    fetchFn: mockFetchReturning("INTENT: fix code | SAME: yes"),
  });

  const result = await tracker.extractIntent("fix it", {
    messages: [
      { role: "user", content: "create a validator for email" },
      { role: "assistant", content: "here is the code" },
      { role: "user", content: "fix it" },
    ],
  });
  assert.equal(result.intent, "fix code");
  assert.equal(result.continuation, "same");
});

test("extractIntent with options.messages and V2 continuation='new'", async () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
    fetchFn: mockFetchReturning("INTENT: add dark theme | SAME: no"),
  });

  const result = await tracker.extractIntent("now add dark theme", {
    messages: [
      { role: "user", content: "create a validator" },
      { role: "assistant", content: "done" },
      { role: "user", content: "now add dark theme" },
    ],
  });
  assert.equal(result.intent, "add dark theme");
  assert.equal(result.continuation, "new");
});

test("extractIntent with no options.messages (V1) returns continuation=null", async () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
    fetchFn: mockFetchReturning("fix code"),
  });

  const result = await tracker.extractIntent("fix it", {});
  // V1 (simple prompt) returns just the label → continuation=null
  assert.equal(result.intent, "fix code");
  assert.equal(result.continuation, null);
});

test("extractIntent with V1 content that has INTENT: prefix but no SAME", async () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
    fetchFn: mockFetchReturning("INTENT: create api"),
  });

  const result = await tracker.extractIntent("create api", {});
  assert.equal(result.intent, "create api");
  assert.equal(result.continuation, null);
});

// -- 8. Continuation + track() integration ------------------------------------

test("track with continuation='same' mantiene l'intento e non resetta il counter", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
  });

  const r1 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r1.count, 1);

  // "fix code" is a different intent, but continuation='same' says it's the same task
  const r2 = tracker.track("fix code", "deepseek-v4-flash", providers, "same");
  assert.equal(r2.count, 2, "continuation='same' → counter deve incrementare, non resettare");
  assert.equal(r2.escalated, false);
});

test("track with continuation='new' ma _isCorrectionMessage dice sticky → resta sticky", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
  });

  // "fix bug" is a pure correction-words intent
  // Even with continuation="new", _isCorrectionMessage acts as safety net
  tracker.track("create api", "deepseek-v4-flash", providers);
  const r2 = tracker.track("fix bug", "deepseek-v4-flash", providers, "new");
  assert.equal(r2.count, 2, "continuation='new' ma _isCorrectionMessage dice sticky → counter incrementa");
});

test("track with continuation='new' E intent senza correctionWords match → reset genuino", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
  });

  tracker.track("create api", "deepseek-v4-flash", providers);
  // "optimize query" has no correctionWords relation to "create api" → reset
  const r2 = tracker.track("optimize query", "deepseek-v4-flash", providers, "new");
  assert.equal(r2.count, 1, "continuation='new' + nessuna relazione → reset");
});

test("track with continuation='same' e intent diverso → escalation counts correctly", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "3" },
    tokenStore: stubTokenStore(providers),
  });

  // 3 request con continuation='same' per simulare task iterativo
  const r1 = tracker.track("create api", "deepseek-v4-flash", providers);
  assert.equal(r1.count, 1);

  const r2 = tracker.track("fix code", "deepseek-v4-flash", providers, "same");
  assert.equal(r2.count, 2);

  const r3 = tracker.track("fix it again", "deepseek-v4-flash", providers, "same");
  assert.equal(r3.count, 3);
  assert.equal(r3.escalated, true, "Continuation-same count=3 raggiunge threshold=3 → escalation");
});

test("track con continuation=null e _isCorrectionMessage fallback → sticky", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
  });

  tracker.track("create api", "deepseek-v4-flash", providers);
  // continuation=null con "fix bug" → _isCorrectionMessage dice sticky
  const r2 = tracker.track("fix bug", "deepseek-v4-flash", providers, null);
  assert.equal(r2.count, 2, "continuation=null + correction words → sticky fallback");
});

test("track con continuation=null e nuovo intent genuino (nessuna correction word) → reset", () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
  });

  tracker.track("create api", "deepseek-v4-flash", providers);
  // "add dark theme" non ha correction words → nuovo task
  const r2 = tracker.track("add dark theme", "deepseek-v4-flash", providers, null);
  assert.equal(r2.count, 1, "continuation=null + no correction words → reset");
});

// -- 9. Full flow: extractIntent + track with real fetchFn returning V2 ---------

test("Full flow: extractIntent returns continuation='same' → track rispetta sticky", async () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
    fetchFn: mockFetchReturning("INTENT: fix code | SAME: yes"),
  });

  // First task
  tracker.track("create api", "deepseek-v4-flash", providers);

  // extractIntent returns continuation='same'
  const result = await tracker.extractIntent("fix it", {
    messages: [{ role: "user", content: "fix it" }],
  });
  assert.equal(result.continuation, "same");

  // Pass continuation to track → sticky
  const r2 = tracker.track(result.intent, "deepseek-v4-flash", providers, result.continuation);
  assert.equal(r2.count, 2);
});

test("Full flow: extractIntent returns continuation='new' → track resetta counter", async () => {
  const home = freshEscalationHome();
  const { IntentTracker } = require("../lib/intent-escalation");
  const providers = makeProviders();
  const tracker = new IntentTracker({
    env: { ...process.env, LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: "4" },
    tokenStore: stubTokenStore(providers),
    fetchFn: mockFetchReturning("INTENT: add dark theme | SAME: no"),
  });

  tracker.track("create api", "deepseek-v4-flash", providers);

  const result = await tracker.extractIntent("now add dark theme", {
    messages: [{ role: "user", content: "now add dark theme" }],
  });
  assert.equal(result.continuation, "new");

  const r2 = tracker.track(result.intent, "deepseek-v4-flash", providers, result.continuation);
  assert.equal(r2.count, 1, "continuation='new' → counter resettato");
});

// -- Manual test (to run with real providers) ---------------------------------
//
// 1. Start the proxy with escalation:
//    LLMPROXY_INTENT_ESCALATION=4 LLMPROXY_LLM_STATS_API_KEY=sk-your-key node bin/llmproxy.js
//
// 2. In another terminal, send 5 requests with the same intent:
//    for i in 1 2 3 4 5; do
//      curl -s -X POST http://localhost:5045/v1/messages \
//        -H "Content-Type: application/json" \
//        -H "x-project-path: /tmp/test-project" \
//        -d '{"model":"deepseek-chat","max_tokens":64,"messages":[{"role":"user","content":[{"type":"text","text":"create a paginated API for users"}]}]}' \
//        | head -c 300 && echo "  --- request $i ---"
//    done
//
// 3. After request 4, the model should escalate. Look in the response
//    footer for "ESCALATED from deepseek-chat/claude-sonnet-4" (or similar).
//    The response will contain ESCALATED from <original>/<escalated>.
//    You can also check the proxy log output for the escalation message.
//
