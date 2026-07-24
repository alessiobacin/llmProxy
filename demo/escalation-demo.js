#!/usr/bin/env node
"use strict";

/**
 * Escalation System Demo
 *
 * Run: node demo/escalation-demo.js
 *
 * Shows the escalation system working end-to-end with visual terminal output.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Colors
const R = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const G = "\x1b[32m", Y = "\x1b[33m", C = "\x1b[36m", M = "\x1b[35m";

const { IntentTracker } = require("../lib/intent-escalation");
const { getIntelligenceScore } = require("../lib/model-capabilities");

// ---------------------------------------------------------------------------
const PROVIDERS = [
  { id: "nano",     provider: "deepseek",  access_token: "tok-nano",   default_model: "deepseek-v4-flash-free", disabled: false },
  { id: "deepseek", provider: "deepseek",  access_token: "tok-deepseek", default_model: "deepseek-v4-flash",      disabled: false },
  { id: "sonnet",   provider: "openrouter",access_token: "tok-sonnet", default_model: "claude-sonnet-4",        disabled: false },
];

function makeFetchFn(responses) {
  let idx = 0;
  return async () => ({
    ok: true, status: 200,
    async json() { return { choices: [{ message: { content: responses[idx++] || "unknown" } }] }; },
  });
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "esc-demo-"));
}

// ---------------------------------------------------------------------------
function run(threshold, gap, label, steps) {
  return async () => {
    const s = "━".repeat(70);
    console.log(`\n${B}${s}${R}`);
    console.log(`${B}  ${label}${R}`);
    console.log(`${B}  threshold=${threshold}, gap=${gap}${R}`);
    console.log(`${B}${s}${R}\n`);

    const home = freshHome();
    const env = { LLMPROXY_HOME: home, LLMPROXY_INTENT_ESCALATION: String(threshold), LLMPROXY_INTENT_ESCALATION_GAP: String(gap) };

    // Build responses array for LLM intent extraction calls
    const responses = steps.map(s => s.llmResponse || "INTENT: " + s.intent + " | same: " + (s.same !== false ? "yes" : "no"));
    const fetchFn = makeFetchFn(responses);

    const tracker = new IntentTracker({ env, tokenStore: { listProviders: () => PROVIDERS }, fetchFn });

    console.log(`${D}  Step │ Intent                │ Continuation  │ Counter   │ Status${R}`);
    console.log(`${D}  ─────┼──────────────────────┼───────────────┼───────────┼──────────${R}`);

    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const r = tracker.track(
        st.intent, st.model || "deepseek-v4-flash", PROVIDERS,
        st.continuation !== undefined ? st.continuation : null
      );

      const esc = r.escalated
        ? `${G}⇧ ${M}${r.escalationModel}${R}`
        : `${D}─${R}`;
      const hit = `${r.count}/${threshold}`;
      const contStr = st.continuation === "same" ? `${D}↻ same${R}` : st.continuation === "new" ? `${D}✖ new${R}` : `${D}─${R}`;

      console.log(
        `  ${Y}${String(i+1).padStart(2)}${R}   │ ${B}${(st.intent||"").padEnd(20)}${R} │ ${contStr.padEnd(13)} │ ${hit.padEnd(9)} │ ${esc}`
      );
    }

    console.log(`\n  ${D}Model scores: nano=50, deepseek=56.2, sonnet=80${R}`);
    try { fs.rmSync(home, { recursive: true }); } catch {}
  };
}

// ---------------------------------------------------------------------------
(async () => {
  console.log(`\n${B}┌─────────────────────────────────────────────────────┐${R}`);
  console.log(`${B}│  llmProxy — Intent Escalation System Demo          │${R}`);
  console.log(`${B}│                                                     │${R}`);
  console.log(`${B}│  The system tracks how many times a user repeats    │${R}`);
  console.log(`${B}│  the same intent. At threshold, it escalates to a   │${R}`);
  console.log(`${B}│  smarter model (score ≥ current + gap).             │${R}`);
  console.log(`${B}└─────────────────────────────────────────────────────┘${R}`);

  // 1: Same intent repeated → escalation
  await run(3, 8, "Same intent repeated 3+ times → escalates to sonnet", [
    { intent: "create api" },
    { intent: "create api" },
    { intent: "create api" },  // → hits threshold=3, escalates
  ])();

  // 2: Sticky via continuation='same'
  await run(3, 8, "Continuation='same' keeps intent sticky across 'fix' messages", [
    { intent: "create api",      continuation: null   },
    { intent: "fix bug",         continuation: "same" },  // sticky, count=2
    { intent: "fix bug",         continuation: "same" },  // sticky, count=3 → escalation
    { intent: "create login",    continuation: "same" },  // sticky, keeps escalated model
    { intent: "create login",    continuation: "new"  },  // really new → reset
  ])();

  // 3: continuation='new' bypasses _isCorrectionMessage
  await run(3, 8, "Continuation='new' forces reset even with correction keywords", [
    { intent: "create dashboard" },
    { intent: "fix colors",        continuation: "same" },  // sticky, count=2
    { intent: "fix legend",        continuation: "same" },  // sticky, count=3 → escalation
    { intent: "fix login",         continuation: "new"  },  // reset! correction words ignored
  ])();

  // 4: Keyword fallback — correction words keep intent sticky
  await run(3, 8, "No continuation → keyword fallback (fix/* → sticky)", [
    { intent: "create export" },
    { intent: "fix export"  },    // shares "export" → sticky, count=2
    { intent: "fix bug"     },    // only correction words → sticky, count=3 → escalation
    { intent: "optimize query" }, // completely different → reset, count=1
  ])();

  // 5: Re-escalation (starts from free model, escalates to deepseek, then to sonnet)
  await run(5, 2, "Re-escalation: starts from free model, step-up to deepseek then sonnet", [
    { intent: "create api", model: "deepseek-v4-flash-free" },
    { intent: "create api", model: "deepseek-v4-flash-free" },
    { intent: "create api", model: "deepseek-v4-flash-free" },
    { intent: "create api", model: "deepseek-v4-flash-free" },
    { intent: "create api", model: "deepseek-v4-flash-free" },  // → threshold=5, escalate to deepseek (56.2 >= 50+2)
    { intent: "create api", model: "deepseek-v4-flash-free" },  // stays on escalated model
    { intent: "create api", model: "deepseek-v4-flash-free" },
    { intent: "create api", model: "deepseek-v4-flash-free" },  // → count >= 5+3=8 → re-escalate to sonnet (80 >= 56.2+2)
    { intent: "create api", model: "deepseek-v4-flash-free" },  // stays on sonnet
  ])();

  // 6: Below threshold → no escalation
  await run(5, 8, "Below threshold (threshold=5, count=2) → no escalation", [
    { intent: "create api" },
    { intent: "create api" },     // only 2, never reaches 5
  ])();

  console.log(`\n${B}${G}✓ Demo complete${R}\n`);
})();
