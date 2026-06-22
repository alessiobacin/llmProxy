const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseProviderModelPreferences,
  sanitizeSchemaForMoonshot,
  sanitizeToolsForMoonshot,
  sanitizeVisionContent,
  VISION_CAPABLE_PROVIDERS,
  isVisionCapableModel,
  shouldFallbackToNextProvider,
  isContextLimitError,
  trimOldestNonSystemMessage,
  hasImageInOpenAiMessages,
  API_KEY_PROVIDER_CONFIGS,
  getApiKeyProviderRequestUrls,
  probeApiKeyProviderModel,
  handleStreaming,
  consumeMinimaxToolCallBuffer,
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

test("API_KEY_PROVIDER_CONFIGS.qwen accepts only qwen model family", () => {
  const qwen = API_KEY_PROVIDER_CONFIGS.qwen;
  assert.equal(typeof qwen.supportsModel, "function");
  assert.equal(qwen.supportsModel("qwen3.7-max"), true);
  assert.equal(qwen.supportsModel("qwen3.7-plus"), true);
  assert.equal(qwen.supportsModel("gpt-5.4"), false);
});

test("API_KEY_PROVIDER_CONFIGS.opencode accepts only OpenCode Zen chat-completions models", () => {
  const opencode = API_KEY_PROVIDER_CONFIGS.opencode;
  assert.equal(typeof opencode.supportsModel, "function");
  assert.equal(opencode.supportsModel("deepseek-v4-flash"), true);
  assert.equal(opencode.supportsModel("minimax-m2.7"), true);
  assert.equal(opencode.supportsModel("minimax-m3"), false);
});

test("API_KEY_PROVIDER_CONFIGS.opencode-go accepts only OpenCode Go messages models", () => {
  const opencodeGo = API_KEY_PROVIDER_CONFIGS["opencode-go"];
  assert.equal(typeof opencodeGo.supportsModel, "function");
  assert.equal(opencodeGo.supportsModel("minimax-m3"), true);
  assert.equal(opencodeGo.supportsModel("qwen3.7-max"), true);
  assert.equal(opencodeGo.supportsModel("deepseek-v4-flash"), false);
});

test("getApiKeyProviderRequestUrls routes qwen token-plan keys to the token-plan endpoint first", () => {
  const urls = getApiKeyProviderRequestUrls({ provider: "qwen", access_token: "sk-sp-test" });
  assert.deepEqual(urls, [
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  ]);
});

test("getApiKeyProviderRequestUrls honors an explicit qwen payg plan", () => {
  const urls = getApiKeyProviderRequestUrls({ provider: "qwen", access_token: "sk-sp-test", endpoint_variant: "dashscope" });
  assert.deepEqual(urls, [
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  ]);
});

test("getApiKeyProviderRequestUrls returns the OpenCode Go messages endpoint", () => {
  const urls = getApiKeyProviderRequestUrls({ provider: "opencode-go", access_token: "sk-opencode-test" });
  assert.deepEqual(urls, [
    "https://opencode.ai/zen/go/v1/messages",
  ]);
});

test("probeApiKeyProviderModel retries qwen against the token-plan endpoint", async () => {
  const urls = [];
  const result = await probeApiKeyProviderModel({
    provider: "qwen",
    apiKey: "sk-sp-test",
    model: "qwen3.7-max",
    fetchFn: async (url) => {
      urls.push(url);
      return {
        ok: url.includes("token-plan"),
        status: url.includes("token-plan") ? 200 : 401,
        async text() {
          return "Incorrect API key provided";
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(urls, ["https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions"]);
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

test("sanitizeSchemaForMoonshot removes sibling keywords from $ref nodes and normalizes refs to $defs", () => {
  const input = {
    type: "object",
    definitions: {
      DesignSystem: {
        type: "object",
        properties: {
          mode: { type: "string" },
        },
      },
    },
    properties: {
      designSystem: { $ref: "#/definitions/DesignSystem", description: "The design system" },
      name: { type: "string", description: "A name" },
    },
  };
  const output = sanitizeSchemaForMoonshot(input);
  assert.deepEqual(output.properties.designSystem, { $ref: "#/$defs/DesignSystem" });
  assert.deepEqual(output.$defs, {
    DesignSystem: {
      type: "object",
      properties: {
        mode: { type: "string" },
      },
    },
  });
  assert.equal("definitions" in output, false);
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
          defs: {
            Config: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
          },
          properties: {
            config: { $ref: "#/defs/Config", description: "conflicting" },
          },
        },
      },
    },
  ];
  const result = sanitizeToolsForMoonshot(tools);
  assert.deepEqual(result[0].function.parameters.properties.config, { $ref: "#/$defs/Config" });
  assert.deepEqual(result[0].function.parameters.$defs, {
    Config: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
    },
  });
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

test("isVisionCapableModel: qwen VL variants and qwen3.7-plus are vision, qwen3.7-max/qwen3/qwen-max are not", () => {
  // VL variants — vision YES
  assert.equal(isVisionCapableModel("qwen-vl-plus", "qwen"), true);
  assert.equal(isVisionCapableModel("qwen-vl-max", "qwen"), true);
  assert.equal(isVisionCapableModel("qwen3-vl-plus", "qwen"), true);
  assert.equal(isVisionCapableModel("qwen3-vl-max", "qwen"), true);
  // qwen3.7-plus — vision YES (multimodal)
  assert.equal(isVisionCapableModel("qwen3.7-plus", "qwen"), true);
  // qwen3.7-max — vision NO (text-only)
  assert.equal(isVisionCapableModel("qwen3.7-max", "qwen"), false);
  // qwen3 text family — vision NO
  assert.equal(isVisionCapableModel("qwen3-max", "qwen"), false);
  assert.equal(isVisionCapableModel("qwen3-plus", "qwen"), false);
  // qwen-max — vision NO
  assert.equal(isVisionCapableModel("qwen-max", "qwen"), false);
});

test("isVisionCapableModel: copilot and openrouter are always vision", () => {
  assert.equal(isVisionCapableModel("claude-sonnet-4", "copilot"), true);
  assert.equal(isVisionCapableModel("gpt-5.4", "copilot"), true);
  assert.equal(isVisionCapableModel("any-model", "openrouter"), true);
});

test("isVisionCapableModel: openai vision models detected correctly", () => {
  assert.equal(isVisionCapableModel("gpt-4o", "openai"), true);
  assert.equal(isVisionCapableModel("gpt-4o-mini", "openai"), true);
  assert.equal(isVisionCapableModel("gpt-4.1", "openai"), true);
  assert.equal(isVisionCapableModel("gpt-4.1-nano", "openai"), true);
  assert.equal(isVisionCapableModel("o1", "openai"), true);
  assert.equal(isVisionCapableModel("o3", "openai"), true);
  assert.equal(isVisionCapableModel("o4-mini", "openai"), true);
  assert.equal(isVisionCapableModel("gpt-3.5-turbo", "openai"), false);
});

test("isVisionCapableModel: non-vision providers correctly identified", () => {
  assert.equal(isVisionCapableModel("deepseek-chat", "deepseek"), false);
  assert.equal(isVisionCapableModel("deepseek-v4-flash", "deepseek"), false);
  assert.equal(isVisionCapableModel("deepseek-v4-pro", "deepseek"), false);
  assert.equal(isVisionCapableModel("deepseek-vl", "deepseek"), true);
  assert.equal(isVisionCapableModel("grok-2", "xai"), false);
  assert.equal(isVisionCapableModel("grok-3", "xai"), true);
  assert.equal(isVisionCapableModel("llama-3.3-70b-versatile", "groq"), false);
  assert.equal(isVisionCapableModel("kimi-k2.6", "kimi"), true);
  assert.equal(isVisionCapableModel("kimi-k2", "kimi"), false);
});

test("isVisionCapableModel: unknown provider returns false", () => {
  assert.equal(isVisionCapableModel("some-model", "unknown-provider"), false);
  assert.equal(isVisionCapableModel("", "openai"), false);
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

test("consumeMinimaxToolCallBuffer extracts tool calls from minimax markup", () => {
  const result = consumeMinimaxToolCallBuffer([
    "<tool_call>",
    "]<|minimax|>[<invoke name=\"Bash\">",
    "]<|minimax|>[<command>pwd</command>",
    "]<|minimax|>[<description>Show cwd</description>",
    "]<|minimax|>[</invoke>",
    "]<|minimax|>[</tool_call>",
  ].join(""), { flush: true });

  assert.equal(result.remainder, "");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, "tool_use");
  assert.equal(result.events[0].toolUse.name, "Bash");
  assert.deepEqual(result.events[0].toolUse.input, {
    command: "pwd",
    description: "Show cwd",
  });
});

test("handleStreaming converts minimax text tool markup into Anthropic tool_use SSE", async () => {
  const sseChunks = [
    "data: " + JSON.stringify({
      id: "chatcmpl_1",
      model: "minimax/minimax-m3-20260531",
      choices: [{ delta: { content: "<tool_call>]<|minimax|>[<invoke name=\"Bash\">]<|minimax|>[<command>pwd</command>]<|minimax|>[<description>Show cwd</description>]<|minimax|>[</invoke>]<|minimax|>[</tool_call>" }, finish_reason: null }],
    }) + "\n",
    "data: " + JSON.stringify({
      id: "chatcmpl_1",
      model: "minimax/minimax-m3-20260531",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }) + "\n",
    "data: [DONE]\n",
  ].join("");

  const res = {
    writes: [],
    write(chunk) {
      this.writes.push(String(chunk));
    },
    end() {
      this.ended = true;
    },
  };

  const fetchResponse = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseChunks));
        controller.close();
      },
    }),
  };

  await handleStreaming(fetchResponse, res, "minimax/minimax-m3", {});

  const events = res.writes
    .join("")
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      return dataLine ? JSON.parse(dataLine.slice(6)) : null;
    })
    .filter(Boolean);

  const toolStart = events.find((event) => event.type === "content_block_start" && event.content_block?.type === "tool_use");
  const toolDelta = events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta");
  const messageDelta = events.find((event) => event.type === "message_delta");
  const rawMarkupLeak = events.find((event) => event.delta?.type === "text_delta" && /<tool_call>|<invoke name=|<command>/.test(event.delta.text));

  assert.ok(toolStart);
  assert.equal(toolStart.content_block.name, "Bash");
  assert.ok(toolDelta);
  assert.deepEqual(JSON.parse(toolDelta.delta.partial_json), {
    command: "pwd",
    description: "Show cwd",
  });
  assert.equal(messageDelta.delta.stop_reason, "tool_use");
  assert.equal(rawMarkupLeak, undefined);
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
