const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseProviderModelPreferences,
  sanitizeSchemaForMoonshot,
  sanitizeToolsForMoonshot,
  sanitizeVisionContent,
  VISION_CAPABLE_PROVIDERS,
  shouldFallbackToNextProvider,
  isContextLimitError,
  trimOldestNonSystemMessage,
  hasImageInOpenAiMessages,
  API_KEY_PROVIDER_CONFIGS,
} = require("../lib/copilot-proxy");
const {
  normalizeCopilotTooling,
  translateOpenAiChatBodyToResponsesRequest,
} = require("../lib/copilot-responses");

test("parseProviderModelPreferences keeps deepseek model names intact", () => {
  const parsed = parseProviderModelPreferences("deepseek-v4-flash");
  assert.deepEqual(parsed, [{ provider: null, model: "deepseek-v4-flash" }]);
});

test("API_KEY_PROVIDER_CONFIGS.deepseek accepts only deepseek model family", () => {
  const deepseek = API_KEY_PROVIDER_CONFIGS.deepseek;
  assert.equal(typeof deepseek.supportsModel, "function");
  assert.equal(deepseek.supportsModel("deepseek-v4-flash"), true);
  assert.equal(deepseek.supportsModel("deepseek-v4-pro"), true);
  assert.equal(deepseek.supportsModel("gpt-5.4"), false);
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

test("isContextLimitError detects Moonshot token limit errors", () => {
  const errorText = "Invalid request: Your request exceeded model token limit: 262144 (requested: 262164)";
  assert.equal(isContextLimitError(400, errorText), true);
  assert.equal(isContextLimitError(429, errorText), false);
  assert.equal(isContextLimitError(400, "invalid model"), false);
});

test("isContextLimitError detects Copilot max prompt token errors", () => {
  const errorText = "{\"error\":{\"message\":\"prompt token count of 86627 exceeds the limit of 64000\",\"code\":\"model_max_prompt_tokens_exceeded\"}}";
  assert.equal(isContextLimitError(400, errorText), true);
});

test("shouldFallbackToNextProvider treats any provider error as fallbackable", () => {
  const insufficientBalance = JSON.stringify({
    error: {
      message: "Insufficient Balance",
      type: "unknown_error",
      code: "invalid_request_error",
    },
  });
  assert.equal(shouldFallbackToNextProvider(402, insufficientBalance), true);
  assert.equal(shouldFallbackToNextProvider(400, "arbitrary provider validation error"), true);
  assert.equal(shouldFallbackToNextProvider(503, "temporary outage"), true);
  assert.equal(shouldFallbackToNextProvider(0, "unexpected local failure"), true);
});

test("trimOldestNonSystemMessage removes oldest non-system message", () => {
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "oldest user" },
    { role: "assistant", content: "assistant reply" },
    { role: "user", content: "newest user" },
  ];
  const trimmed = trimOldestNonSystemMessage(messages);
  assert.equal(trimmed.length, 3);
  assert.deepEqual(trimmed[0], messages[0]);
  assert.deepEqual(trimmed[1], messages[2]);
  assert.deepEqual(trimmed[2], messages[3]);
});

test("hasImageInOpenAiMessages detects image_url blocks", () => {
  assert.equal(hasImageInOpenAiMessages([{ role: "user", content: [{ type: "text", text: "hello" }] }]), false);
  assert.equal(hasImageInOpenAiMessages([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/img.png" } }] }]), true);
  assert.equal(hasImageInOpenAiMessages(null), false);
});

test("translateOpenAiChatBodyToResponsesRequest caps tools to 128 for Copilot responses", () => {
  const tools = Array.from({ length: 170 }, (_, index) => ({
    type: "function",
    function: {
      name: `tool_${index + 1}`,
      description: `Tool ${index + 1}`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
    },
  }));

  const request = translateOpenAiChatBodyToResponsesRequest({
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hello" }],
    tools,
  });

  assert.equal(request.tools.length, 128);
  assert.equal(request.tools[0].name, "tool_1");
  assert.equal(request.tools[127].name, "tool_128");
});

test("translateOpenAiChatBodyToResponsesRequest resets named tool_choice when trimmed tool is removed", () => {
  const tools = Array.from({ length: 129 }, (_, index) => ({
    type: "function",
    function: {
      name: `tool_${index + 1}`,
      description: `Tool ${index + 1}`,
      parameters: { type: "object", properties: {} },
    },
  }));

  const request = translateOpenAiChatBodyToResponsesRequest({
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hello" }],
    tools,
    tool_choice: {
      type: "function",
      function: {
        name: "tool_129",
      },
    },
  });

  assert.equal(request.tools.length, 128);
  assert.equal(request.tool_choice, "auto");
});

test("normalizeCopilotTooling caps tools to 128 for Copilot chat payloads", () => {
  const tools = Array.from({ length: 170 }, (_, index) => ({
    type: "function",
    function: {
      name: `tool_${index + 1}`,
      description: `Tool ${index + 1}`,
      parameters: { type: "object", properties: {} },
    },
  }));

  const normalized = normalizeCopilotTooling({
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hello" }],
    tools,
  });

  assert.equal(normalized.tools.length, 128);
  assert.equal(normalized.tools[127].function.name, "tool_128");
});

test("normalizeCopilotTooling resets named tool_choice when trimmed chat tool is removed", () => {
  const tools = Array.from({ length: 129 }, (_, index) => ({
    type: "function",
    function: {
      name: `tool_${index + 1}`,
      description: `Tool ${index + 1}`,
      parameters: { type: "object", properties: {} },
    },
  }));

  const normalized = normalizeCopilotTooling({
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hello" }],
    tools,
    tool_choice: {
      type: "function",
      function: {
        name: "tool_129",
      },
    },
  });

  assert.equal(normalized.tools.length, 128);
  assert.equal(normalized.tool_choice, "auto");
});
