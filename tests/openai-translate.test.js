const test = require("node:test");
const assert = require("node:assert/strict");

const { translateRequest } = require("../lib/openai-translate");

test("translateRequest keeps assistant tool-call messages compatible with Copilot responses input", () => {
  const translated = translateRequest({
    model: "gpt-5.4",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "Skill",
            input: { query: "test" },
          },
        ],
      },
    ],
  });

  assert.equal(translated.messages.length, 1);
  assert.equal(translated.messages[0].role, "assistant");
  assert.equal(translated.messages[0].content, "");
  assert.deepEqual(translated.messages[0].tool_calls, [
    {
      id: "toolu_123",
      type: "function",
      function: {
        name: "Skill",
        arguments: JSON.stringify({ query: "test" }),
      },
    },
  ]);
});