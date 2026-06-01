const test = require("node:test");
const assert = require("node:assert/strict");

const {
  openAIRequestToAnthropic,
  anthropicResponseToOpenAI,
} = require("../lib/openai-format");

test("openAIRequestToAnthropic folds system messages and converts tool calls", () => {
  const translated = openAIRequestToAnthropic({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are helpful." },
      {
        role: "assistant",
        content: "Calling tool",
        tool_calls: [
          {
            id: "tool_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: JSON.stringify({ q: "pricing" }),
            },
          },
        ],
      },
    ],
    tool_choice: "required",
  });

  assert.equal(translated.system, "You are helpful.");
  assert.equal(translated.messages.length, 1);
  assert.equal(translated.messages[0].role, "assistant");
  assert.deepEqual(translated.messages[0].content, [
    { type: "text", text: "Calling tool" },
    { type: "tool_use", id: "tool_1", name: "lookup", input: { q: "pricing" } },
  ]);
  assert.deepEqual(translated.tool_choice, { type: "any" });
});

test("openAIRequestToAnthropic converts data url images into base64 image blocks", () => {
  const translated = openAIRequestToAnthropic({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJDRA==" } },
        ],
      },
    ],
  });

  assert.deepEqual(translated.messages[0], {
    role: "user",
    content: [
      { type: "text", text: "Describe this image" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "QUJDRA==",
        },
      },
    ],
  });
});

test("anthropicResponseToOpenAI converts tool_use blocks into OpenAI tool_calls", () => {
  const translated = anthropicResponseToOpenAI({
    model: "claude-sonnet-4.5",
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "I will call a tool." },
      { type: "tool_use", id: "toolu_123", name: "Skill", input: { query: "test" } },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 8,
    },
  });

  assert.equal(translated.object, "chat.completion");
  assert.equal(translated.model, "claude-sonnet-4.5");
  assert.equal(translated.choices[0].finish_reason, "tool_calls");
  assert.equal(translated.choices[0].message.content, "I will call a tool.");
  assert.deepEqual(translated.choices[0].message.tool_calls, [
    {
      id: "toolu_123",
      type: "function",
      function: {
        name: "Skill",
        arguments: JSON.stringify({ query: "test" }),
      },
    },
  ]);
  assert.deepEqual(translated.usage, {
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
  });
});
