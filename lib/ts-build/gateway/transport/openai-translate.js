"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_COPILOT_MODEL = void 0;
exports.msgId = msgId;
exports.getAvailableModels = getAvailableModels;
exports.mapModel = mapModel;
exports.resolveSupportedModel = resolveSupportedModel;
exports.isClaude = isClaude;
exports.translateRequest = translateRequest;
exports.translateResponse = translateResponse;
const node_crypto_1 = __importDefault(require("node:crypto"));
const message_translate_1 = require("./message-translate");
const MODEL_MAP = {
    "claude-opus-4-6-20250820": "claude-opus-4-6",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
    "claude-sonnet-4-20250514": "claude-sonnet-4",
    "claude-haiku-4-5-20251001": "claude-haiku-4.5",
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4.5",
    haiku: "claude-haiku-4.5",
    gpt: "gpt-5",
};
const DEFAULT_COPILOT_MODEL = "claude-sonnet-4.5";
exports.DEFAULT_COPILOT_MODEL = DEFAULT_COPILOT_MODEL;
// ---------- type guards ----------
function isText(b) {
    return b.type === "text";
}
function isImage(b) {
    return b.type === "image";
}
function isToolResult(b) {
    return b.type === "tool_result";
}
// ---------- functions ----------
function msgId() {
    return `msg_${node_crypto_1.default.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
function mapModel(name) {
    const value = String(name ?? "").trim();
    if (!value)
        return DEFAULT_COPILOT_MODEL;
    if (MODEL_MAP[value] !== undefined)
        return MODEL_MAP[value];
    const stripped = value.replace(/-\d{8}$/, "");
    return MODEL_MAP[stripped] ?? value;
}
function getAvailableModels() {
    return [
        ...new Set(Object.values(MODEL_MAP)
            .map((model) => String(model).trim())
            .filter((m) => m.length > 0)),
    ];
}
function resolveSupportedModel(name, fallbackModel = DEFAULT_COPILOT_MODEL, availableModels) {
    const mappedModel = mapModel(name);
    const supportedModels = new Set([
        ...getAvailableModels(),
        ...(Array.isArray(availableModels)
            ? availableModels.map((model) => String(model ?? "").trim()).filter((m) => m.length > 0)
            : []),
    ]);
    if (supportedModels.has(mappedModel))
        return mappedModel;
    const fallbackCandidate = mapModel(fallbackModel);
    if (supportedModels.has(fallbackCandidate))
        return fallbackCandidate;
    return DEFAULT_COPILOT_MODEL;
}
function isClaude(model) {
    return String(model ?? "").includes("claude");
}
function translateTool(tool) {
    const fn = {
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
    };
    if (tool.name !== undefined)
        fn.name = tool.name;
    return {
        type: "function",
        function: fn,
    };
}
function translateToolChoice(choice) {
    if (!choice)
        return undefined;
    if (typeof choice === "string") {
        if (choice === "required")
            return "required";
        if (choice === "auto")
            return "auto";
        if (choice === "none")
            return "none";
        return "auto";
    }
    switch (choice.type) {
        case "auto":
            return "auto";
        case "any":
            return "required";
        case "none":
            return "none";
        case "tool": {
            const result = { type: "function", function: {} };
            if (choice.name !== undefined)
                result.function.name = choice.name;
            return result;
        }
        default:
            return "auto";
    }
}
function formatContent(blocks) {
    if (!Array.isArray(blocks))
        return String(blocks ?? "");
    const hasImages = blocks.some(isImage);
    if (hasImages) {
        const result = [];
        for (const block of blocks) {
            if (isText(block)) {
                result.push({ type: "text", text: block.text ?? "" });
                continue;
            }
            if (isImage(block)) {
                const source = block.source;
                const url = source?.type === "base64"
                    ? `data:${source.media_type ?? ""};base64,${source.data ?? ""}`
                    : source?.url ?? "";
                result.push({ type: "image_url", image_url: { url } });
            }
        }
        return result;
    }
    return blocks
        .filter(isText)
        .map((block) => block.text ?? "")
        .join("\n");
}
function translateUser(message) {
    if (!Array.isArray(message.content)) {
        return { role: "user", content: String(message.content ?? "") };
    }
    const blocks = message.content;
    const toolResults = blocks.filter(isToolResult);
    const otherBlocks = blocks.filter((b) => !isToolResult(b) && b.type !== "thinking");
    const messages = [];
    for (const toolResult of toolResults) {
        let contentStr = "";
        const toolContent = toolResult.content;
        if (typeof toolContent === "string") {
            contentStr = toolContent;
        }
        else if (Array.isArray(toolContent)) {
            contentStr = toolContent
                .filter((b) => b.type === "text")
                .map((b) => b.text ?? "")
                .join("\n");
        }
        else if (toolContent) {
            contentStr = JSON.stringify(toolContent);
        }
        if (toolResult.is_error)
            contentStr = `[ERROR] ${contentStr}`;
        messages.push({
            role: "tool",
            tool_call_id: toolResult.tool_use_id ?? "",
            content: contentStr,
        });
    }
    if (otherBlocks.length > 0) {
        messages.push({ role: "user", content: formatContent(otherBlocks) });
    }
    if (messages.length === 1)
        return messages[0];
    return messages;
}
function stringifyContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return String(content ?? "");
    return content
        .filter(isText)
        .map((block) => block.text ?? "")
        .join("\n");
}
function translateMessage(message) {
    if (message.role === "assistant") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (0, message_translate_1.translateAssistant)(message);
    }
    if (message.role === "user") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return translateUser(message);
    }
    return { role: message.role, content: stringifyContent(message.content) };
}
function translateRequest(body) {
    const output = {
        model: mapModel(body.model),
        messages: [],
    };
    if (body.system) {
        const systemText = typeof body.system === "string"
            ? body.system
            : Array.isArray(body.system)
                ? body.system
                    .filter((block) => block.type === "text")
                    .map((block) => block.text ?? "")
                    .join("\n")
                : "";
        if (systemText)
            output.messages.push({ role: "system", content: systemText });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const message of messages) {
        const translated = translateMessage(message);
        if (Array.isArray(translated)) {
            for (const t of translated)
                output.messages.push(t);
        }
        else {
            output.messages.push(translated);
        }
    }
    if (body.max_tokens) {
        const usesCompletionTokens = /^(gpt-5|o1|o3|o4)/.test(output.model ?? "");
        if (usesCompletionTokens) {
            output.max_completion_tokens = body.max_tokens;
        }
        else {
            output.max_tokens = body.max_tokens;
        }
    }
    if (body.temperature !== undefined)
        output.temperature = body.temperature;
    if (body.top_p !== undefined)
        output.top_p = body.top_p;
    if (body.stop_sequences)
        output.stop = body.stop_sequences;
    if (body.stream !== undefined)
        output.stream = body.stream;
    if (body.stream)
        output.stream_options = { include_usage: true };
    if (body.tools !== undefined && body.tools.length > 0) {
        output.tools = body.tools.map(translateTool);
    }
    if (body.tool_choice) {
        const tc = translateToolChoice(body.tool_choice);
        if (tc !== undefined)
            output.tool_choice = tc;
    }
    return output;
}
function translateStopReason(reason) {
    switch (reason) {
        case "length":
            return "max_tokens";
        case "tool_calls":
            return "tool_use";
        case "stop":
        default:
            return "end_turn";
    }
}
function extractUsageTokenCounts(rawUsage) {
    const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
    const firstFinite = (...values) => {
        for (const value of values) {
            const normalized = Number(value);
            if (Number.isFinite(normalized) && normalized >= 0)
                return normalized;
        }
        return null;
    };
    const totalTokens = firstFinite(usage.total_tokens, usage.totalTokens);
    const inputTokens = firstFinite(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.promptTokens);
    const outputTokens = firstFinite(usage.output_tokens, usage.completion_tokens, usage.outputTokens, usage.completionTokens);
    return {
        inputTokens: inputTokens ?? Math.max(0, Number(totalTokens || 0) - Number(outputTokens || 0)),
        outputTokens: outputTokens ?? Math.max(0, Number(totalTokens || 0) - Number(inputTokens || 0)),
    };
}
function translateResponse(openai, responseModel) {
    const choice = openai?.choices?.[0];
    if (!choice) {
        return {
            id: msgId(),
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "" }],
            model: String(openai?.model ?? responseModel ?? "unknown"),
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        };
    }
    const content = [];
    if (choice.message?.content) {
        content.push({ type: "text", text: choice.message.content });
    }
    if (choice.message?.tool_calls) {
        for (const raw of choice.message.tool_calls) {
            let input = {};
            try {
                const parsed = JSON.parse(raw.function?.arguments ?? "{}");
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    input = parsed;
                }
            }
            catch {
                input = {};
            }
            content.push({
                type: "tool_use",
                id: raw.id ?? "",
                name: raw.function?.name ?? "",
                input,
            });
        }
    }
    if (content.length === 0)
        content.push({ type: "text", text: "" });
    const usageCounts = extractUsageTokenCounts(openai?.usage);
    return {
        id: msgId(),
        type: "message",
        role: "assistant",
        content,
        model: String(openai?.model ?? responseModel ?? "unknown"),
        stop_reason: translateStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: usageCounts.inputTokens,
            output_tokens: usageCounts.outputTokens,
        },
    };
}
