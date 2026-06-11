"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeRequest,
  routeRequest,
  classifyWithLLM,
} = require("../lib/smart-router");

describe("smart-router", () => {
  describe("analyzeRequest", () => {
    it("classifica request semplice come economy", () => {
      const body = {
        messages: [
          { role: "user", content: "Ciao, come stai?" },
          { role: "assistant", content: "Tutto bene, grazie!" },
        ],
      };
      const result = analyzeRequest(body);
      assert.equal(result.needsVision, false);
      assert.equal(result.needsTools, false);
      assert.equal(result.complexity, "simple");
      assert.equal(result.recommendedTier, "economy");
    });

    it("rileva bisogno di vision quando ci sono image block", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Descrivi questa immagine" },
              { type: "image", source: { type: "base64", data: "abc" } },
            ],
          },
        ],
      };
      const result = analyzeRequest(body);
      assert.equal(result.needsVision, true);
      assert.equal(result.recommendedTier, "standard");
    });

    it("rileva bisogno di tools quando ci sono tool definitions", () => {
      const body = {
        messages: [{ role: "user", content: "Usa il tool" }],
        tools: [
          { name: "read_file", description: "Read a file" },
          { name: "write_file", description: "Write a file" },
        ],
      };
      const result = analyzeRequest(body);
      assert.equal(result.needsTools, true);
      assert.equal(result.needsVision, false);
    });

    it("classifica request complessa con molti messaggi e tools", () => {
      const messages = [];
      for (let i = 0; i < 25; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(500) });
      }
      const body = {
        messages,
        tools: Array.from({ length: 8 }, (_, i) => ({ name: `tool_${i}`, description: "" })),
      };
      const result = analyzeRequest(body);
      assert.equal(result.complexity, "complex");
      assert.equal(result.recommendedTier, "premium");
    });

    it("classifica request moderata correttamente", () => {
      const messages = [];
      for (let i = 0; i < 8; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: "text ".repeat(50) });
      }
      const body = {
        messages,
        tools: [{ name: "read_file", description: "" }],
      };
      const result = analyzeRequest(body);
      assert.equal(result.complexity, "moderate");
    });

    it("gestisce body con messages vuoti", () => {
      const result = analyzeRequest({ messages: [] });
      assert.equal(result.needsVision, false);
      assert.equal(result.needsTools, false);
      assert.equal(result.complexity, "simple");
    });

    it("gestisce body senza messages", () => {
      const result = analyzeRequest({});
      assert.equal(result.needsVision, false);
      assert.equal(result.needsTools, false);
      assert.equal(result.messageCount, 0);
    });

    it("calcola messageCount correttamente", () => {
      const body = {
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      };
      const result = analyzeRequest(body);
      assert.equal(result.messageCount, 3);
    });

    it("stima totalChars dai messages", () => {
      const body = {
        messages: [
          { role: "user", content: "hello world" },
          { role: "assistant", content: "hi" },
        ],
      };
      const result = analyzeRequest(body);
      assert.ok(result.totalChars >= 13, "deve contare caratteri dai messages");
    });

    it("conta chars anche da content blocks array", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "text", text: "world" },
            ],
          },
        ],
      };
      const result = analyzeRequest(body);
      assert.ok(result.totalChars >= 10);
    });
  });

  describe("routeRequest", () => {
    it("ritorna null quando non ci sono provider attivi", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const result = routeRequest(analysis, [], "balanced");
      assert.equal(result, null);
    });

    it("ritorna null quando nessun modello soddisfa requisiti vision", () => {
      const analysis = { needsVision: true, needsTools: false, recommendedTier: "standard" };
      const activeProviders = [
        {
          provider: "deepseek",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["deepseek-chat"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "balanced");
      assert.equal(result, null);
    });

    it("seleziona modello economy per task semplice", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const activeProviders = [
        {
          provider: "openrouter",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["deepseek-chat", "claude-sonnet-4"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "balanced");
      assert.ok(result);
      assert.equal(result.model, "deepseek-chat");
      assert.equal(result.tier, "economy");
    });

    it("seleziona modello con vision quando richiesto", () => {
      const analysis = { needsVision: true, needsTools: false, recommendedTier: "standard" };
      const activeProviders = [
        {
          provider: "copilot",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["claude-haiku-4.5"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "balanced");
      assert.ok(result);
      assert.equal(result.model, "claude-haiku-4.5");
    });

    it("ignora provider non attivi", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const activeProviders = [
        {
          provider: "openrouter",
          scope_type: "user",
          scope_id: "u1",
          active: false,
          models: ["deepseek-chat"],
        },
        {
          provider: "copilot",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["claude-haiku-4.5"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "balanced");
      assert.ok(result);
      assert.equal(result.provider, "copilot");
    });

    it("preferenza economy ordina per costo crescente", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const activeProviders = [
        {
          provider: "copilot",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["claude-haiku-4.5", "gpt-4o-mini"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "economy");
      assert.ok(result);
      // gpt-4o-mini costs less than claude-haiku-4.5
      assert.equal(result.model, "gpt-4o-mini");
    });

    it("preferenza quality ordina per costo decrescente", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "premium" };
      const activeProviders = [
        {
          provider: "openai",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["gpt-5", "deepseek-chat"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "quality");
      assert.ok(result);
      assert.equal(result.model, "gpt-5");
    });

    it("ritorna null quando registeredModels e vuoto", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "economy" };
      const result = routeRequest(analysis, [], "balanced");
      assert.equal(result, null);
    });

    it("include provider e tier nel risultato", () => {
      const analysis = { needsVision: false, needsTools: false, recommendedTier: "standard" };
      const activeProviders = [
        {
          provider: "copilot",
          scope_type: "user",
          scope_id: "u1",
          active: true,
          models: ["claude-sonnet-4"],
        },
      ];
      const result = routeRequest(analysis, activeProviders, "balanced");
      assert.ok(result);
      assert.equal(result.provider, "copilot");
      assert.equal(result.tier, "standard");
      assert.ok(typeof result.estimatedCostPerKInput === "number");
      assert.ok(typeof result.estimatedCostPerKOutput === "number");
    });
  });

  describe("classifyWithLLM", () => {
    it("ritorna classificazione da risposta LLM JSON", async () => {
      const body = {
        messages: [{ role: "user", content: "Write a React component" }],
      };
      const routerConfig = {
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-test",
      };

      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"vision":false,"tools":true,"complexity":"moderate","type":"coding"}',
              },
            },
          ],
        }),
      });

      const result = await classifyWithLLM(body, routerConfig, mockFetch);
      assert.equal(result.vision, false);
      assert.equal(result.tools, true);
      assert.equal(result.complexity, "moderate");
      assert.equal(result.type, "coding");
    });

    it("ritorna null quando fetch fallisce", async () => {
      const body = { messages: [{ role: "user", content: "test" }] };
      const routerConfig = {
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-test",
      };

      const mockFetch = async () => ({ ok: false, status: 500 });

      const result = await classifyWithLLM(body, routerConfig, mockFetch);
      assert.equal(result, null);
    });

    it("ritorna null quando JSON non e valido", async () => {
      const body = { messages: [{ role: "user", content: "test" }] };
      const routerConfig = {
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-test",
      };

      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "not json at all" } }],
        }),
      });

      const result = await classifyWithLLM(body, routerConfig, mockFetch);
      assert.equal(result, null);
    });

    it("ritorna null quando fetch lancia eccezione", async () => {
      const body = { messages: [{ role: "user", content: "test" }] };
      const routerConfig = {
        classifierProvider: "openrouter",
        classifierModel: "deepseek-chat",
        classifierApiKey: "sk-or-test",
      };

      const mockFetch = async () => {
        throw new Error("Network error");
      };

      const result = await classifyWithLLM(body, routerConfig, mockFetch);
      assert.equal(result, null);
    });
  });
});
