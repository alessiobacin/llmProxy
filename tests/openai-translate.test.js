const test = require("node:test");
const assert = require("node:assert/strict");

const {
  translateRequest,
  translateResponse,
  mapModel,
  DEFAULT_COPILOT_MODEL,
  parseMinimaxToolCallContent,
} = require("../lib/openai-translate");

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

test("mapModel returns default for empty input", () => {
  assert.equal(mapModel(""), DEFAULT_COPILOT_MODEL);
  assert.equal(mapModel(null), DEFAULT_COPILOT_MODEL);
  assert.equal(mapModel(undefined), DEFAULT_COPILOT_MODEL);
});

test("mapModel maps known aliases", () => {
  assert.equal(mapModel("sonnet"), "claude-sonnet-4.5");
  assert.equal(mapModel("opus"), "claude-opus-4-6");
  assert.equal(mapModel("haiku"), "claude-haiku-4.5");
  assert.equal(mapModel("gpt"), "gpt-5");
});

test("mapModel strips date suffixes", () => {
  assert.equal(mapModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4.5");
  assert.equal(mapModel("claude-opus-4-6-20250820"), "claude-opus-4-6");
});

test("translateRequest folds system messages", () => {
  const translated = translateRequest({
    model: "claude-sonnet-4.5",
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "Hello" },
    ],
  });

  assert.equal(translated.messages.length, 2);
  assert.equal(translated.messages[0].role, "system");
  assert.equal(translated.messages[0].content, "You are a helpful assistant.");
  assert.equal(translated.messages[1].role, "user");
  assert.equal(translated.messages[1].content, "Hello");
});

test("translateRequest sets stream_options when streaming", () => {
  const translated = translateRequest({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });

  assert.equal(translated.stream, true);
  assert.deepEqual(translated.stream_options, { include_usage: true });
});

test("translateRequest maps tools into function definitions", () => {
  const translated = translateRequest({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "lookup",
        description: "Look up pricing",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
  });

  assert.equal(translated.tools.length, 1);
  assert.deepEqual(translated.tools[0], {
    type: "function",
    function: {
      name: "lookup",
      description: "Look up pricing",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  });
});

test("translateRequest uses max_completion_tokens for gpt-5/o1/o3/o4 models", () => {
  const translated = translateRequest({
    model: "gpt-5.1",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 256,
  });

  assert.equal(translated.max_completion_tokens, 256);
  assert.equal(translated.max_tokens, undefined);
});

test("translateResponse returns empty text for missing choice", () => {
  const response = translateResponse({ model: "gpt-4o" }, "gpt-4o");
  assert.equal(response.role, "assistant");
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[0].text, "");
  assert.equal(response.stop_reason, "end_turn");
});

test("translateResponse maps tool_calls into tool_use blocks", () => {
  const response = translateResponse({
    model: "gpt-4o",
    choices: [
      {
        message: {
          content: "Calling tool",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"test"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  }, "gpt-4o");

  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.usage.input_tokens, 5);
  assert.equal(response.usage.output_tokens, 3);
  assert.equal(response.content.length, 2);
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[0].text, "Calling tool");
  assert.equal(response.content[1].type, "tool_use");
  assert.equal(response.content[1].name, "lookup");
  assert.deepEqual(response.content[1].input, { query: "test" });
});

test("translateResponse accepts input_tokens and output_tokens usage fields", () => {
  const response = translateResponse({
    model: "qwen3.7-max",
    choices: [
      {
        message: { content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { input_tokens: 20, output_tokens: 236, total_tokens: 256 },
  }, "qwen3.7-max");

  assert.equal(response.usage.input_tokens, 20);
  assert.equal(response.usage.output_tokens, 236);
});

test("translateResponse extracts text from structured message content arrays", () => {
  const response = translateResponse({
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          content: [
            { type: "text", text: "llmproxy-test-opencode" },
            { type: "metadata", content: "ignored metadata text" },
            "second-line",
          ],
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  }, "deepseek-v4-flash");

  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[0].text, "llmproxy-test-opencode\nignored metadata text\nsecond-line");
});

test("parseMinimaxToolCallContent converts minimax tool markup into tool_use blocks", () => {
  const parsed = parseMinimaxToolCallContent([
    "<tool_call>",
    "]<|minimax|>[<invoke name=\"TodoWrite\">",
    "]<|minimax|>[<todos><item><content>Sostituire inference</content><status>in_progress</status><activeForm>Sostituendo inference</activeForm></item></todos>",
    "]<|minimax|>[</invoke>",
    "]<|minimax|>[</tool_call>",
  ].join(""));

  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "tool_use");
  assert.equal(parsed[0].name, "TodoWrite");
  assert.deepEqual(parsed[0].input, {
    todos: [
      {
        content: "Sostituire inference",
        status: "in_progress",
        activeForm: "Sostituendo inference",
      },
    ],
  });
});

test("parseMinimaxToolCallContent converts malformed minimax marker variant into tool_use blocks", () => {
  const parsed = parseMinimaxToolCallContent([
    "<tool_call>",
    "]<]minimax[>[<invoke name=\"Read\">",
    "]<]minimax[>[<file_path>/Users/alessiobacin/Development/testCode/voice-agent/index.html</file_path>",
    "]<]minimax[>[<offset>35</offset>",
    "]<]minimax[>[<limit>10</limit>",
    "]<]minimax[>[</invoke>",
    "]<]minimax[>[</tool_call>",
  ].join(""));

  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].type, "tool_use");
  assert.equal(parsed[0].name, "Read");
  assert.deepEqual(parsed[0].input, {
    file_path: "/Users/alessiobacin/Development/testCode/voice-agent/index.html",
    offset: "35",
    limit: "10",
  });
});

test("translateResponse maps minimax tool markup in plain text to tool_use", () => {
  const response = translateResponse({
    model: "minimax/minimax-m3-20260531",
    choices: [
      {
        message: {
          content: [
            "<tool_call>",
            "]<|minimax|>[<invoke name=\"Bash\">",
            "]<|minimax|>[<command>ls /tmp 2>&1 | grep -E \"deepgram|openai|cartesia\"</command>",
            "]<|minimax|>[<description>Verify plugin modules installed</description>",
            "]<|minimax|>[</invoke>",
            "]<|minimax|>[</tool_call>",
          ].join(""),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }, "minimax/minimax-m3");

  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, "tool_use");
  assert.equal(response.content[0].name, "Bash");
  assert.deepEqual(response.content[0].input, {
    command: "ls /tmp 2>&1 | grep -E \"deepgram|openai|cartesia\"",
    description: "Verify plugin modules installed",
  });
});

test("translateResponse maps malformed minimax marker variant in plain text to tool_use", () => {
  const response = translateResponse({
    model: "minimax/minimax-m3-20260531",
    choices: [
      {
        message: {
          content: [
            "<tool_call>",
            "]<]minimax[>[<invoke name=\"Read\">",
            "]<]minimax[>[<file_path>/Users/alessiobacin/Development/testCode/voice-agent/index.html</file_path>",
            "]<]minimax[>[<offset>35</offset>",
            "]<]minimax[>[<limit>10</limit>",
            "]<]minimax[>[</invoke>",
            "]<]minimax[>[</tool_call>",
          ].join(""),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }, "minimax/minimax-m3");

  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.content.length, 1);
  assert.equal(response.content[0].type, "tool_use");
  assert.equal(response.content[0].name, "Read");
  assert.deepEqual(response.content[0].input, {
    file_path: "/Users/alessiobacin/Development/testCode/voice-agent/index.html",
    offset: "35",
    limit: "10",
  });
});
