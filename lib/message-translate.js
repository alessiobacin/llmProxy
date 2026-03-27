const SYNTHETIC_THINKING_PLACEHOLDER = "[reasoning omitted]";

function getUsableThinkingTexts(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block.type === "thinking")
    .map((block) => String(block?.thinking || "").trim())
    .filter(Boolean);
}

function translateAssistant(message) {
  if (!Array.isArray(message.content)) {
    return { role: "assistant", content: String(message.content || "") };
  }

  const textBlocks = message.content.filter((block) => block.type === "text");
  const toolBlocks = message.content.filter((block) => block.type === "tool_use");
  const reasoningTexts = getUsableThinkingTexts(message.content);

  const result = { role: "assistant" };
  let reasoningText = reasoningTexts.join("\n");
  if (!reasoningText && toolBlocks.length > 0) reasoningText = SYNTHETIC_THINKING_PLACEHOLDER;

  if (textBlocks.length > 0) {
    result.content = textBlocks.map((block) => block.text).join("");
  }

  if (toolBlocks.length > 0) {
    result.tool_calls = toolBlocks.map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));
    if (!result.content) result.content = null;
    result.reasoning_content = reasoningText;
  } else if (reasoningText) {
    result.reasoning_content = reasoningText;
  }

  return result;
}

module.exports = {
  translateAssistant,
};