"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openAIRequestToAnthropic = openAIRequestToAnthropic;
exports.anthropicResponseToOpenAI = anthropicResponseToOpenAI;
exports.anthropicErrorToOpenAI = anthropicErrorToOpenAI;
exports.createOpenAiStreamTranslator = createOpenAiStreamTranslator;
exports.anthropicSseWriteToOpenAiChunks = anthropicSseWriteToOpenAiChunks;
const node_crypto_1 = __importDefault(require("node:crypto"));
function openAIMessageToAnthropic(msg) {
    if (!msg)
        return null;
    const role = msg.role;
    if (role === "system") {
        const content = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n")
                : "";
        return { _system: content };
    }
    if (role === "tool") {
        return {
            role: "user",
            content: [{
                    type: "tool_result",
                    tool_use_id: msg.tool_call_id ?? "",
                    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
                }],
        };
    }
    if (role === "assistant") {
        const content = [];
        if (msg.content) {
            content.push({
                type: "text",
                text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            });
        }
        if (Array.isArray(msg.tool_calls)) {
            for (const toolCall of msg.tool_calls) {
                let input = {};
                try {
                    const parsed = JSON.parse(toolCall.function?.arguments ?? "{}");
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        input = parsed;
                    }
                }
                catch {
                    input = {};
                }
                content.push({
                    type: "tool_use",
                    id: toolCall.id ?? "",
                    name: toolCall.function?.name ?? "",
                    input,
                });
            }
        }
        return {
            role: "assistant",
            content: content.length > 0 ? content : [{ type: "text", text: "" }],
        };
    }
    if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
    }
    if (Array.isArray(msg.content)) {
        const blocks = [];
        for (const item of msg.content) {
            if (item.type === "text") {
                blocks.push({ type: "text", text: item.text ?? "" });
                continue;
            }
            if (item.type === "image_url") {
                const url = item.image_url?.url ?? "";
                const match = url.match(/^data:([^;]+);base64,(.*)$/);
                if (match) {
                    const mediaType = match[1] ?? "application/octet-stream";
                    const data = match[2] ?? "";
                    blocks.push({
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: mediaType,
                            data,
                        },
                    });
                }
                else {
                    blocks.push({
                        type: "image",
                        source: {
                            type: "url",
                            url,
                        },
                    });
                }
            }
        }
        return { role: "user", content: blocks };
    }
    return { role: "user", content: String(msg.content ?? "") };
}
function openAIRequestToAnthropic(body) {
    const out = {
        messages: [],
    };
    if (body.model !== undefined)
        out.model = body.model;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemParts = [];
    for (const message of messages) {
        const translated = openAIMessageToAnthropic(message);
        if (!translated)
            continue;
        if ("_system" in translated) {
            systemParts.push(translated._system);
            continue;
        }
        out.messages.push(translated);
    }
    if (systemParts.length > 0)
        out.system = systemParts.join("\n");
    const maxTokens = body.max_tokens || body.max_completion_tokens;
    if (maxTokens !== undefined)
        out.max_tokens = maxTokens;
    if (body.temperature !== undefined)
        out.temperature = body.temperature;
    if (body.top_p !== undefined)
        out.top_p = body.top_p;
    if (body.stop)
        out.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
    if (body.stream !== undefined)
        out.stream = body.stream;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        out.tools = body.tools.map((tool) => {
            const anthropicTool = {
                description: tool.function?.description ?? "",
                input_schema: tool.function?.parameters ?? { type: "object", properties: {} },
            };
            if (tool.function?.name !== undefined)
                anthropicTool.name = tool.function.name;
            return anthropicTool;
        });
    }
    if (body.tool_choice) {
        if (typeof body.tool_choice === "string") {
            out.tool_choice = body.tool_choice === "required"
                ? { type: "any" }
                : { type: body.tool_choice };
        }
        else if (body.tool_choice.type === "function") {
            out.tool_choice = { type: "tool", name: body.tool_choice.function?.name };
        }
    }
    return out;
}
function anthropicResponseToOpenAI(anthropic) {
    const id = `chatcmpl-${node_crypto_1.default.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
    const textParts = [];
    const toolCalls = [];
    for (const block of blocks) {
        if (block.type === "text") {
            textParts.push(block.text ?? "");
            continue;
        }
        if (block.type === "tool_use") {
            const toolCall = {
                type: "function",
                function: {
                    arguments: JSON.stringify(block.input ?? {}),
                },
            };
            if (block.id !== undefined)
                toolCall.id = block.id;
            if (block.name !== undefined)
                toolCall.function.name = block.name;
            toolCalls.push(toolCall);
        }
    }
    const finishReason = anthropic.stop_reason === "tool_use"
        ? "tool_calls"
        : anthropic.stop_reason === "max_tokens"
            ? "length"
            : "stop";
    const promptTokens = anthropic.usage?.input_tokens ?? 0;
    const completionTokens = anthropic.usage?.output_tokens ?? 0;
    // Estrai reasoning_content se presente (per modelli come Kimi, DeepSeek R1, ecc.)
    const reasoningContent = anthropic.reasoning_content;
    return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: anthropic.model ?? "unknown",
        choices: [{
                index: 0,
                message: {
                    role: "assistant",
                    content: textParts.join("") || null,
                    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: finishReason,
            }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
    };
}
// ---------------------------------------------------------------------------
// OpenAI-style error mapping (T2)
// ---------------------------------------------------------------------------
function anthropicErrorToOpenAI(payload) {
    const error = payload?.error;
    if (!error || typeof error !== "object")
        return payload;
    const type = String(error.type ?? "api_error");
    const message = String(error.message ?? "request failed");
    const code = type === "authentication_error" ? "invalid_api_key" : type === "invalid_request_error" ? "invalid_request_error" : null;
    return {
        error: {
            message,
            type,
            ...(code ? { code } : {}),
        },
    };
}
function mapStopReasonToFinishReason(stopReason) {
    const reason = String(stopReason ?? "end_turn");
    if (reason === "max_tokens")
        return "length";
    if (reason === "tool_use")
        return "tool_calls";
    return "stop";
}
function serializeChunk(chunk) {
    return `data: ${JSON.stringify(chunk)}\n\n`;
}
function createOpenAiStreamTranslator(options) {
    return {
        id: `chatcmpl-${node_crypto_1.default.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        created: Math.floor(Date.now() / 1000),
        model: String(options.model || "unknown"),
        includeUsage: options.includeUsage === true,
        sentFirstChunk: false,
        finished: false,
        toolCallIndex: 0,
        buffer: "",
    };
}
function buildOpenAiChunk(state, delta, finishReason) {
    return serializeChunk({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
}
/**
 * Consume one (possibly partial) raw SSE write from the Anthropic stream and
 * return the OpenAI chunk payloads to forward. The translator keeps an internal
 * buffer so events split across writes are handled correctly.
 */
function anthropicSseWriteToOpenAiChunks(state, rawWrite) {
    if (state.finished)
        return [];
    state.buffer += String(rawWrite ?? "");
    const events = [];
    // Extract complete SSE events: "event: <name>\ndata: <json>\n\n"
    let boundary = state.buffer.indexOf("\n\n");
    while (boundary !== -1) {
        const rawEvent = state.buffer.slice(0, boundary);
        state.buffer = state.buffer.slice(boundary + 2);
        boundary = state.buffer.indexOf("\n\n");
        let dataLine = null;
        for (const line of rawEvent.split("\n")) {
            if (line.startsWith("data:")) {
                dataLine = line.slice(5).trim();
                break;
            }
        }
        if (dataLine === null || dataLine === "[DONE]")
            continue;
        let event;
        try {
            event = JSON.parse(dataLine);
        }
        catch {
            continue;
        }
        events.push(...handleAnthropicSseEvent(state, event));
    }
    return events;
}
function handleAnthropicSseEvent(state, event) {
    const type = String(event.type ?? "");
    if (type === "message_start") {
        const firstDelta = { role: "assistant", content: "" };
        state.sentFirstChunk = true;
        return [buildOpenAiChunk(state, firstDelta, null)];
    }
    if (type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "tool_use") {
            const toolCall = {
                index: state.toolCallIndex,
                type: "function",
                id: String(block.id ?? `call_${state.toolCallIndex}`),
                function: { name: String(block.name ?? "tool"), arguments: "" },
            };
            state.toolCallIndex += 1;
            return [buildOpenAiChunk(state, { tool_calls: [toolCall] }, null)];
        }
        return [];
    }
    if (type === "content_block_delta") {
        const delta = event.delta;
        if (!delta)
            return [];
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            return [buildOpenAiChunk(state, { content: delta.text }, null)];
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            // Not part of the OpenAI contract; exposed for reasoning-style clients.
            return [buildOpenAiChunk(state, { reasoning_content: delta.thinking }, null)];
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
            const toolCall = {
                index: Math.max(0, state.toolCallIndex - 1),
                function: { arguments: delta.partial_json },
            };
            return [buildOpenAiChunk(state, { tool_calls: [toolCall] }, null)];
        }
        return [];
    }
    if (type === "message_delta") {
        const delta = event.delta;
        const usage = event.usage;
        const finishReason = mapStopReasonToFinishReason(delta?.stop_reason);
        const out = [buildOpenAiChunk(state, {}, finishReason)];
        if (state.includeUsage && usage) {
            const promptTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
            const completionTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
            out.push(serializeChunk({
                id: state.id,
                object: "chat.completion.chunk",
                created: state.created,
                model: state.model,
                choices: [],
                usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                },
            }));
        }
        return out;
    }
    if (type === "message_stop") {
        state.finished = true;
        return ["data: [DONE]\n\n"];
    }
    return [];
}
