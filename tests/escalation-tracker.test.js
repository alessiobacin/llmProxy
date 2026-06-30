"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EscalationTracker } = require("../lib/escalation-tracker");

test("EscalationTracker disabled by default — never escalates", () => {
  const et = new EscalationTracker();
  assert.equal(et.enabled, false);

  const result = et.track("conv1", "Ciao come stai?");
  assert.equal(result.escalate, false);
  assert.equal(result.level, 0);

  // Stesso messaggio 3x — non deve escalare perché disabled
  assert.equal(et.track("conv1", "Ciao come stai?").escalate, false);
  assert.equal(et.track("conv1", "Ciao come stai?").escalate, false);
  assert.equal(et.track("conv1", "Ciao come stai?").escalate, false);
});

test("EscalationTracker enabled — escalates after threshold identical messages", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  // Primo messaggio — nessuna escalation
  let r = et.track("conv1", "Risolvi questo bug");
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);

  // Secondo identico — nessuna escalation (attemptCount=1, < threshold)
  r = et.track("conv1", "Risolvi questo bug");
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);

  // Terzo identico — escalation! (attemptCount=2 >= threshold)
  r = et.track("conv1", "Risolvi questo bug");
  assert.equal(r.escalate, true);
  assert.equal(r.level, 1);
});

test("EscalationTracker — resets on different message when not yet escalated", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  et.track("conv1", "Primo problema");
  et.track("conv1", "Primo problema"); // attempt=1

  // Messaggio diverso — reset
  let r = et.track("conv1", "Secondo problema");
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);

  // Il reset ha funzionato: riparte da 0
  r = et.track("conv1", "Secondo problema");
  assert.equal(r.escalate, false); // attempt=1, < threshold
});

test("EscalationTracker — preserves level after escalation even with different messages", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  // Escalate to level 1
  et.track("conv1", "Stesso problema");
  et.track("conv1", "Stesso problema");
  const r = et.track("conv1", "Stesso problema");
  assert.equal(r.escalate, true);
  assert.equal(r.level, 1);

  // Dopo escalation, messaggio diverso NON resetta il livello
  const r2 = et.track("conv1", "Problema diverso ma stesso thread");
  assert.equal(r2.escalate, false);
  assert.equal(r2.level, 1); // preserved
});

test("EscalationTracker — escalates to level 2 after another threshold", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  // Escalate to level 1
  et.track("conv1", "Bug A");
  et.track("conv1", "Bug A");
  et.track("conv1", "Bug A"); // escalate to level 1

  // Escalate to level 2
  et.track("conv1", "Bug A"); // attemptCount=1, < threshold
  const r = et.track("conv1", "Bug A"); // attemptCount=2 >= threshold
  assert.equal(r.escalate, true);
  assert.equal(r.level, 2);
});

test("EscalationTracker — conversations are isolated", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  et.track("convA", "Messaggio in A");
  et.track("convA", "Messaggio in A");
  let r = et.track("convA", "Messaggio in A");
  assert.equal(r.escalate, true); // escalated in A

  // B non ha tentativi
  r = et.track("convB", "Messaggio in B");
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);
});

test("EscalationTracker — null/empty user message does not escalate", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  let r = et.track("conv1", "");
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);

  r = et.track("conv1", null);
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);
});

test("EscalationTracker — hash normalizes whitespace and case", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  const h1 = et.hash("Ciao mondo");
  const h2 = et.hash("ciao   mondo");
  const h3 = et.hash(" CIAO MONDO ");

  assert.equal(h1, h2);
  assert.equal(h1, h3);
});

test("EscalationTracker — getLevel returns current escalation level", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  assert.equal(et.getLevel("conv1"), 0);

  et.track("conv1", "Fix this");
  et.track("conv1", "Fix this");
  et.track("conv1", "Fix this"); // escalate
  assert.equal(et.getLevel("conv1"), 1);
});

test("EscalationTracker — cleanup removes conversation state", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2 });

  et.track("conv1", "Test");
  et.cleanup("conv1");
  assert.equal(et.getLevel("conv1"), 0);

  // Dopo cleanup, ricomincia da zero
  const r = et.track("conv1", "Test");
  assert.equal(r.escalate, false);
  assert.equal(r.level, 0);
});

test("EscalationTracker — does not crash on undefined options", () => {
  const et = new EscalationTracker(undefined);
  assert.equal(et.enabled, false);

  const r = et.track("conv1", "Hello");
  assert.equal(r.escalate, false);
});

test("EscalationTracker — evicts old entries when maxEntries reached", () => {
  const et = new EscalationTracker({ enabled: true, threshold: 2, maxEntries: 10 });

  // Fill beyond maxEntries with unique messages
  for (let i = 0; i < 15; i++) {
    et.track(`conv${i}`, `Messaggio ${i}`);
  }

  // The store should have been evicted — should be <= maxEntries
  assert.ok(et.store.size <= 10);
});
