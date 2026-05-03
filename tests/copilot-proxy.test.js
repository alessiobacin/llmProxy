const test = require("node:test");
const assert = require("node:assert/strict");

const { parseProviderModelPreferences, sanitizeSchemaForMoonshot, sanitizeToolsForMoonshot } = require("../lib/copilot-proxy");

test("parseProviderModelPreferences keeps deepseek model names intact", () => {
  const parsed = parseProviderModelPreferences("deepseek-v4-flash");
  assert.deepEqual(parsed, [{ provider: null, model: "deepseek-v4-flash" }]);
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
