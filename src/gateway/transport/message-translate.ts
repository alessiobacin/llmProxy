const SYNTHETIC_THINKING_PLACEHOLDER = "[reasoning omitted]";

type TextBlock = { type: "text"; text?: string };
type ToolUseBlock = { type: "tool_use"; id?: string; name?: string; input?: Record<string, unknown> };
type ThinkingBlock = { type: "thinking"; thinking?: string };
type FallbackBlock = { type: string; [key: string]: unknown };

type AnthropicContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | FallbackBlock;

type AnthropicAssistantMessage = {
  role?: "assistant";
  content?: string | AnthropicContentBlock[];
};

interface TranslatedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface TranslatedAssistantMessage {
  role: "assistant";
  content?: string;
  tool_calls?: TranslatedToolCall[];
  reasoning_content?: string;
}

function isThinking(b: AnthropicContentBlock): b is ThinkingBlock {
  return b.type === "thinking";
}
function isText(b: AnthropicContentBlock): b is TextBlock {
  return b.type === "text";
}
function isToolUse(b: AnthropicContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

function getUsableThinkingTexts(blocks: AnthropicContentBlock[] | undefined | null): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter(isThinking)
    .map((block) => String(block.thinking ?? "").trim())
    .filter((text) => text.length > 0);
}

function translateAssistant(message: AnthropicAssistantMessage): TranslatedAssistantMessage {
  if (!Array.isArray(message.content)) {
    return { role: "assistant", content: String(message.content ?? "") };
  }

  const blocks = message.content;
  const textBlocks = blocks.filter(isText);
  const toolBlocks = blocks.filter(isToolUse);
  const reasoningTexts = getUsableThinkingTexts(blocks);

  const result: TranslatedAssistantMessage = { role: "assistant" };
  let reasoningText = reasoningTexts.join("\n");
  if (!reasoningText && toolBlocks.length > 0) reasoningText = SYNTHETIC_THINKING_PLACEHOLDER;

  if (textBlocks.length > 0) {
    result.content = textBlocks.map((block) => block.text ?? "").join("");
  }

  if (toolBlocks.length > 0) {
    result.tool_calls = toolBlocks.map(
      (block): TranslatedToolCall => ({
        id: block.id ?? "",
        type: "function" as const,
        function: {
          name: block.name ?? "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      }),
    );
    if (!result.content) result.content = "";
    result.reasoning_content = reasoningText;
  } else if (reasoningText) {
    result.reasoning_content = reasoningText;
  }

  return result;
}

export {
  translateAssistant,
};
