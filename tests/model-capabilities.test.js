"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  getCapabilities,
  getTierForModel,
  getPowerScore,
  getSpeedScore,
  findBestModel,
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

  describe("findBestModel", () => {
    it("seleziona modello economy quando nessun requisito speciale", () => {
      const registered = [
        { model: "deepseek-chat", provider: { kind: "openrouter", id: "or-1" } },
        { model: "claude-opus-4-6", provider: { kind: "copilot", id: "copilot" } },
        { model: "claude-haiku-4.5", provider: { kind: "copilot", id: "copilot" } },
      ];
      const requirements = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const result = findBestModel(requirements, registered, "balanced");
      assert.ok(result, "deve trovare un modello");
      assert.equal(result.model, "deepseek-chat");
      assert.equal(result.provider.kind, "openrouter");
    });

    it("seleziona modello vision quando richiesto", () => {
      const registered = [
        { model: "deepseek-chat", provider: { kind: "openrouter", id: "or-1" } },
        { model: "claude-haiku-4.5", provider: { kind: "copilot", id: "copilot" } },
      ];
      const requirements = { needsVision: true, needsTools: false, recommendedTier: "standard" };
      const result = findBestModel(requirements, registered, "balanced");
      assert.ok(result);
      assert.equal(result.model, "claude-haiku-4.5");
    });

    it("fallback al tier superiore se nessun modello nel tier corrente", () => {
      const registered = [
        { model: "claude-opus-4-6", provider: { kind: "copilot", id: "copilot" } },
      ];
      const requirements = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const result = findBestModel(requirements, registered, "economy");
      // Non ci sono modelli economy, quindi premium e l'unica opzione
      assert.ok(result);
      assert.equal(result.model, "claude-opus-4-6");
    });

    it("ritorna null quando nessun modello matcha (vision richiesta ma non disponibile)", () => {
      const registered = [
        { model: "deepseek-chat", provider: { kind: "openrouter", id: "or-1" } },
      ];
      const requirements = { needsVision: true, needsTools: false, recommendedTier: "standard" };
      const result = findBestModel(requirements, registered, "balanced");
      assert.equal(result, null);
    });

    it("rispetta preferenza economy", () => {
      const registered = [
        { model: "claude-haiku-4.5", provider: { kind: "copilot", id: "c1" } },
        { model: "deepseek-chat", provider: { kind: "openrouter", id: "or-1" } },
      ];
      const requirements = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const result = findBestModel(requirements, registered, "economy");
      assert.equal(result.model, "deepseek-chat");
    });

    it("rispetta preferenza quality", () => {
      const registered = [
        { model: "deepseek-chat", provider: { kind: "openrouter", id: "or-1" } },
        { model: "gpt-5", provider: { kind: "openai", id: "oa-1" } },
      ];
      const requirements = { needsVision: false, needsTools: false, recommendedTier: "premium" };
      const result = findBestModel(requirements, registered, "quality");
      assert.equal(result.model, "gpt-5");
    });

    it("non include modelli di provider inattivi", () => {
      const registered = [
        { model: "deepseek-chat", provider: { kind: "openrouter", id: "or-1", active: false } },
        { model: "claude-haiku-4.5", provider: { kind: "copilot", id: "copilot", active: true } },
      ];
      const requirements = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const result = findBestModel(requirements, registered, "balanced");
      // deepseek e economy ma il provider e inattivo, quindi skippato
      assert.equal(result.model, "claude-haiku-4.5");
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
