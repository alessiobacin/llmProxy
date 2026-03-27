const crypto = require("node:crypto");
const { translateAssistant } = require("./message-translate");

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

function msgId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function mapModel(name) {
  const value = String(name || "").trim();
  if (!value) return DEFAULT_COPILOT_MODEL;
  if (MODEL_MAP[value]) return MODEL_MAP[value];
  const stripped = value.replace(/-\d{8}$/, "");
  return MODEL_MAP[stripped] || value;
}

function getAvailableModels() {
  return [...new Set(Object.values(MODEL_MAP).map((model) => String(model).trim()).filter(Boolean))];
}

function resolveSupportedModel(name, fallbackModel = DEFAULT_COPILOT_MODEL, availableModels = getAvailableModels()) {
  const mappedModel = mapModel(name);
  const supportedModels = new Set([
    ...getAvailableModels(),
    ...(Array.isArray(availableModels) ? availableModels.map((model) => String(model || "").trim()).filter(Boolean) : []),
  ]);
  if (supportedModels.has(mappedModel)) return mappedModel;

  const fallbackCandidate = mapModel(fallbackModel);
  if (supportedModels.has(fallbackCandidate)) return fallbackCandidate;

  return DEFAULT_COPILOT_MODEL;
}

function isClaude(model) {
  return String(model || "").includes("claude");
}

function translateTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  };
}

function translateToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return "auto";
  }
}

function formatContent(blocks) {
  if (!Array.isArray(blocks)) return String(blocks || "");
  const hasImages = blocks.some((block) => block.type === "image");
  if (hasImages) {
    return blocks
      .map((block) => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "image") {
          const url = block.source?.type === "base64"
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source?.url || "";
          return { type: "image_url", image_url: { url } };
        }
        return null;
      })
      .filter(Boolean);
  }

  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function translateUser(message) {
  if (!Array.isArray(message.content)) {
    return { role: "user", content: String(message.content || "") };
  }

  const toolResults = message.content.filter((block) => block.type === "tool_result");
  const otherBlocks = message.content.filter((block) => block.type !== "tool_result" && block.type !== "thinking");
  const messages = [];

  for (const toolResult of toolResults) {
    let content = "";
    if (typeof toolResult.content === "string") {
      content = toolResult.content;
    } else if (Array.isArray(toolResult.content)) {
      content = toolResult.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    } else if (toolResult.content) {
      content = JSON.stringify(toolResult.content);
    }

    if (toolResult.is_error) content = `[ERROR] ${content}`;
    messages.push({ role: "tool", tool_call_id: toolResult.tool_use_id, content });
  }

  if (otherBlocks.length > 0) {
    messages.push({ role: "user", content: formatContent(otherBlocks) });
  }

  return messages.length === 1 ? messages[0] : messages;
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function translateMessage(message) {
  if (message.role === "assistant") return translateAssistant(message);
  if (message.role === "user") return translateUser(message);
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
        ? body.system.filter((block) => block.type === "text").map((block) => block.text).join("\n")
        : "";
    if (systemText) output.messages.push({ role: "system", content: systemText });
  }

  for (const message of body.messages || []) {
    const translated = translateMessage(message);
    if (Array.isArray(translated)) output.messages.push(...translated);
    else output.messages.push(translated);
  }

  if (body.max_tokens) output.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.stop_sequences) output.stop = body.stop_sequences;
  if (body.stream !== undefined) output.stream = body.stream;
  if (body.stream) output.stream_options = { include_usage: true };
  if (body.tools?.length) output.tools = body.tools.map(translateTool);
  if (body.tool_choice) output.tool_choice = translateToolChoice(body.tool_choice);

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

function translateResponse(openai, responseModel) {
  const choice = openai?.choices?.[0];
  if (!choice) {
    return {
      id: msgId(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: String(openai?.model || responseModel || "unknown"),
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
    for (const toolCall of choice.message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(toolCall.function.arguments || "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    content,
    model: String(openai?.model || responseModel || "unknown"),
    stop_reason: translateStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai?.usage?.prompt_tokens || 0,
      output_tokens: openai?.usage?.completion_tokens || 0,
    },
  };
}

module.exports = {
  DEFAULT_COPILOT_MODEL,
  msgId,
  getAvailableModels,
  mapModel,
  resolveSupportedModel,
  isClaude,
  translateRequest,
  translateResponse,
};