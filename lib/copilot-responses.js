function shouldUseCopilotResponsesApi(status, bodyText) {
  if (Number(status) !== 400) return false;
  const text = String(bodyText || "");
  return /unsupported_api_for_model/i.test(text) || /not accessible via the \/chat\/completions endpoint/i.test(text);
}

function shouldUseCopilotChatCompletionsApi(status, bodyText) {
  if (Number(status) !== 400) return false;
  const text = String(bodyText || "");
  return /unsupported_api_for_model/i.test(text) || /not accessible via the \/responses endpoint/i.test(text);
}

function normalizeResponsesInputMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "").trim();
  if (!role) return null;
  return {
    role,
    content: normalizeResponsesContent(message.content),
  };
}

function normalizeResponsesContent(content) {
  if (!Array.isArray(content)) return content;
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      if (part.type === "text") return { type: "input_text", text: String(part.text || "") };
      if (part.type === "image_url") {
        return { type: "input_image", image_url: String(part.image_url?.url || "") };
      }
      return null;
    })
    .filter(Boolean);
}

function translateOpenAiChatBodyToResponsesRequest(openaiBody = {}) {
  const messages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const instructions = messages
    .filter((message) => message?.role === "system")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean)
    .join("\n\n");

  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") continue;

    if (message.role === "assistant") {
      const assistantMessage = normalizeResponsesInputMessage(message);
      if (assistantMessage) input.push(assistantMessage);

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const toolCall of toolCalls) {
        input.push({
          type: "function_call",
          call_id: String(toolCall.id || "").trim(),
          name: String(toolCall.function?.name || "").trim(),
          arguments: String(toolCall.function?.arguments || "{}"),
        });
      }
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id || "").trim(),
        output: String(message.content || ""),
      });
      continue;
    }

    const normalized = normalizeResponsesInputMessage(message);
    if (normalized) input.push(normalized);
  }

  const request = {
    model: openaiBody.model,
    input,
    stream: false,
  };

  if (instructions) request.instructions = instructions;
  if (openaiBody.max_tokens != null) request.max_output_tokens = openaiBody.max_tokens;
  if (openaiBody.temperature !== undefined) request.temperature = openaiBody.temperature;
  if (openaiBody.top_p !== undefined) request.top_p = openaiBody.top_p;

  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0) {
    request.tools = openaiBody.tools.map((tool) => ({
      type: tool.type || "function",
      name: String(tool.function?.name || tool.name || "").trim(),
      description: String(tool.function?.description || tool.description || "").trim(),
      parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} },
    }));
  }

  if (openaiBody.tool_choice !== undefined) {
    request.tool_choice = openaiBody.tool_choice;
  }

  return request;
}

function safeParseJson(rawValue) {
  try {
    return JSON.parse(String(rawValue || "{}"));
  } catch {
    return {};
  }
}

function translateResponsesApiResponseToAnthropic(response, model) {
  const content = [];
  const outputItems = Array.isArray(response?.output) ? response.output : [];

  for (const item of outputItems) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text") {
          content.push({ type: "text", text: String(part.text || "") });
        }
      }
      continue;
    }

    if (item?.type === "function_call") {
      content.push({
        type: "tool_use",
        id: String(item.call_id || item.id || "tool_call"),
        name: String(item.name || "tool"),
        input: safeParseJson(item.arguments),
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: String(response?.output_text || "") });
  }

  return {
    id: String(response?.id || ""),
    type: "message",
    role: "assistant",
    content,
    model: String(response?.model || model || "unknown"),
    stop_reason: response?.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(response?.usage?.input_tokens || 0),
      output_tokens: Number(response?.usage?.output_tokens || 0),
    },
  };
}

module.exports = {
  shouldUseCopilotResponsesApi,
  shouldUseCopilotChatCompletionsApi,
  translateOpenAiChatBodyToResponsesRequest,
  translateResponsesApiResponseToAnthropic,
};