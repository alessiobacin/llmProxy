"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateAssistant = void 0;
const SYNTHETIC_THINKING_PLACEHOLDER = "[reasoning omitted]";
function isThinking(b) {
    return b.type === "thinking";
}
function isText(b) {
    return b.type === "text";
}
function isToolUse(b) {
    return b.type === "tool_use";
}
function getUsableThinkingTexts(blocks) {
    if (!Array.isArray(blocks))
        return [];
    return blocks
        .filter(isThinking)
        .map((block) => String(block.thinking ?? "").trim())
        .filter((text) => text.length > 0);
}
function translateAssistant(message) {
    if (!Array.isArray(message.content)) {
        return { role: "assistant", content: String(message.content ?? "") };
    }
    const blocks = message.content;
    const textBlocks = blocks.filter(isText);
    const toolBlocks = blocks.filter(isToolUse);
    const reasoningTexts = getUsableThinkingTexts(blocks);
    const result = { role: "assistant" };
    let reasoningText = reasoningTexts.join("\n");
    if (!reasoningText && toolBlocks.length > 0)
        reasoningText = SYNTHETIC_THINKING_PLACEHOLDER;
    if (textBlocks.length > 0) {
        result.content = textBlocks.map((block) => block.text ?? "").join("");
    }
    if (toolBlocks.length > 0) {
        result.tool_calls = toolBlocks.map((block) => ({
            id: block.id ?? "",
            type: "function",
            function: {
                name: block.name ?? "",
                arguments: JSON.stringify(block.input ?? {}),
            },
        }));
        if (!result.content)
            result.content = "";
        result.reasoning_content = reasoningText;
    }
    else if (reasoningText) {
        result.reasoning_content = reasoningText;
    }
    return result;
}
exports.translateAssistant = translateAssistant;
