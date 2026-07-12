"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  getCapabilities,
  getTierForModel,
  getPowerScore,
  getSpeedScore,
  MODEL_TIERS,
  MODEL_CAPABILITIES,
} = require("../lib/model-capabilities");

describe("model-capabilities", () => {
  describe("getCapabilities", () => {
    it("ritorna capabilities per un modello noto", () => {
      const caps = getCapabilities("claude-sonnet-4.5");
      assert.ok(caps);
      assert.equal(caps.vision, true);
      assert.equal(caps.tools, true);
    });

    it("ritorna null per un modello sconosciuto", () => {
      const caps = getCapabilities("unknown-model-v2");
      assert.equal(caps, null);
    });

    it("ritorna capabilities per variante con suffisso data", () => {
      // Le varianti con suffisso -YYYYMMDD devono essere risolte al modello base
      const caps = getCapabilities("claude-opus-4-6-20250820");
      assert.ok(caps, "deve trovare capabilities per variante con data");
    });

    it("ritorna capabilities per deepseek-chat", () => {
      const caps = getCapabilities("deepseek-chat");
      assert.ok(caps);
      assert.equal(caps.vision, false);
      assert.equal(caps.tools, true);
    });

    it("normalizza nomi modello case-insensitive", () => {
      const caps = getCapabilities("DEEPSEEK-CHAT");
      assert.ok(caps);
    });
  });

  describe("getTierForModel", () => {
    it("ritorna economy per deepseek-chat", () => {
      assert.equal(getTierForModel("deepseek-chat"), "economy");
    });

    it("ritorna standard per claude-haiku-4.5", () => {
      assert.equal(getTierForModel("claude-haiku-4.5"), "standard");
    });

    it("ritorna premium per claude-opus-4-6", () => {
      assert.equal(getTierForModel("claude-opus-4-6"), "premium");
    });

    it("ritorna standard per modello sconosciuto (default)", () => {
      assert.equal(getTierForModel("fantasy-model"), "standard");
    });
  });

  describe("power/speed scores", () => {
    it("assegna piu potenza ai tier premium rispetto agli economy", () => {
      assert.ok(getPowerScore("gpt-5") > getPowerScore("deepseek-chat"));
    });

    it("assegna piu velocita stimata ai tier economy rispetto ai premium", () => {
      assert.ok(getSpeedScore("deepseek-chat") > getSpeedScore("gpt-5"));
    });
  });

  describe("MODEL_TIERS", () => {
    it("contiene tutti i tier necessari", () => {
      assert.ok(Array.isArray(MODEL_TIERS.economy));
      assert.ok(Array.isArray(MODEL_TIERS.standard));
      assert.ok(Array.isArray(MODEL_TIERS.premium));
    });

    it("ogni modello ha capabilities definite", () => {
      for (const tier of Object.values(MODEL_TIERS)) {
        for (const model of tier) {
          const caps = getCapabilities(model);
          assert.ok(caps, `il modello "${model}" nel tier deve avere capabilities`);
        }
      }
    });
  });
});
