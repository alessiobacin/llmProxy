const test = require("node:test");
const assert = require("node:assert/strict");

const { parseProviderModelPreferences, sanitizeSchemaForMoonshot, sanitizeToolsForMoonshot, sanitizeVisionContent, VISION_CAPABLE_PROVIDERS } = require("../lib/copilot-proxy");

test("parseProviderModelPreferences keeps deepseek model names intact", () => {
  const parsed = parseProviderModelPreferences("deepseek-v4-flash");
  assert.deepEqual(parsed, [{ provider: null, model: "deepseek-v4-flash" }]);
});

test("parseProviderModelPreferences keeps mistral model names intact", () => {
  const parsed = parseProviderModelPreferences("mistral-large-latest");
  assert.deepEqual(parsed, [{ provider: null, model: "mistral-large-latest" }]);
});

test("parseProviderModelPreferences keeps mistral-small model names intact", () => {
  const parsed = parseProviderModelPreferences("mistral-small-latest");
  assert.deepEqual(parsed, [{ provider: null, model: "mistral-small-latest" }]);
});

test("parseProviderModelPreferences still supports zai- prefix shorthand", () => {
  const parsed = parseProviderModelPreferences("zai-glm-5");
  assert.deepEqual(parsed, [{ provider: "zai", model: "glm-5" }]);
});

test("sanitizeSchemaForMoonshot removes sibling keywords from $ref nodes", () => {
  const input = {
    type: "object",
    properties: {
      designSystem: { $ref: "#/definitions/DesignSystem", description: "The design system" },
      name: { type: "string", description: "A name" },
    },
  };
  const output = sanitizeSchemaForMoonshot(input);
  assert.deepEqual(output.properties.designSystem, { $ref: "#/definitions/DesignSystem" });
  // non-$ref nodes are untouched
  assert.deepEqual(output.properties.name, { type: "string", description: "A name" });
});

test("sanitizeToolsForMoonshot sanitizes parameters of each tool", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "myTool",
        parameters: {
          type: "object",
          properties: {
            config: { $ref: "#/defs/Config", description: "conflicting" },
          },
        },
      },
    },
  ];
  const result = sanitizeToolsForMoonshot(tools);
  assert.deepEqual(result[0].function.parameters.properties.config, { $ref: "#/defs/Config" });
});

test("sanitizeVisionContent replaces image_url blocks with [image] text for non-vision providers", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Guarda questa immagine:" }, { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] },
    { role: "assistant", content: [{ type: "text", text: "Ok" }] },
  ];
  const result = sanitizeVisionContent(messages);
  // First message: collapsed to string (text + [image])
  assert.equal(typeof result[0].content, "string");
  assert.ok(result[0].content.includes("[image]"), "deve contenere [image]");
  // Second message: invariato (nessuna image_url)
  assert.deepEqual(result[1], messages[1]);
});

test("sanitizeVisionContent keeps messages with only text unchanged", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Ciao" }] },
    { role: "user", content: "Semplice stringa" },
  ];
  const result = sanitizeVisionContent(messages);
  assert.deepEqual(result, messages);
});

test("sanitizeVisionContent handles message where content is only image_url (no text)", () => {
  const messages = [
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }] },
  ];
  const result = sanitizeVisionContent(messages);
  assert.equal(result[0].content, "[image]");
});

test("VISION_CAPABLE_PROVIDERS includes copilot and openai but not deepseek", () => {
  assert.ok(VISION_CAPABLE_PROVIDERS.has("copilot"), "copilot deve supportare vision");
  assert.ok(VISION_CAPABLE_PROVIDERS.has("openai"), "openai deve supportare vision");
  assert.ok(!VISION_CAPABLE_PROVIDERS.has("deepseek"), "deepseek non deve supportare vision");
  assert.ok(!VISION_CAPABLE_PROVIDERS.has("kimi"), "kimi non deve supportare vision");
  assert.ok(!VISION_CAPABLE_PROVIDERS.has("groq"), "groq non deve supportare vision");
});
