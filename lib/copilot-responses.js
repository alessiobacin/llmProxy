const COPILOT_RESPONSES_MAX_TOOLS = 128;

function normalizeCopilotTooling(openaiBody = {}) {
  if (!Array.isArray(openaiBody.tools) || openaiBody.tools.length <= COPILOT_RESPONSES_MAX_TOOLS) {
    return openaiBody;
  }

  const trimmedTools = openaiBody.tools.slice(0, COPILOT_RESPONSES_MAX_TOOLS);
  let nextToolChoice = openaiBody.tool_choice;
  const selectedToolName = String(
    openaiBody.tool_choice?.function?.name
    || openaiBody.tool_choice?.name
    || "",
  ).trim();
  if (selectedToolName) {
    const selectedToolStillPresent = trimmedTools.some((tool) => String(tool?.function?.name || tool?.name || "").trim() === selectedToolName);
    if (!selectedToolStillPresent) nextToolChoice = "auto";
  }

  return {
    ...openaiBody,
    tools: trimmedTools,
    ...(openaiBody.tool_choice !== undefined ? { tool_choice: nextToolChoice } : {}),
  };
}

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
  const normalizedBody = normalizeCopilotTooling(openaiBody);
  const messages = Array.isArray(normalizedBody.messages) ? normalizedBody.messages : [];
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
    model: normalizedBody.model,
    input,
    stream: false,
  };

  if (instructions) request.instructions = instructions;
  if (normalizedBody.max_tokens != null) request.max_output_tokens = normalizedBody.max_tokens;
  if (normalizedBody.temperature !== undefined) request.temperature = normalizedBody.temperature;
  if (normalizedBody.top_p !== undefined) request.top_p = normalizedBody.top_p;

  if (Array.isArray(normalizedBody.tools) && normalizedBody.tools.length > 0) {
    request.tools = normalizedBody.tools.map((tool) => ({
      type: tool.type || "function",
      name: String(tool.function?.name || tool.name || "").trim(),
      description: String(tool.function?.description || tool.description || "").trim(),
      parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} },
    }));
  }

  if (normalizedBody.tool_choice !== undefined) {
    request.tool_choice = normalizedBody.tool_choice;
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

function extractUsageTokenCounts(rawUsage = {}) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const firstFinite = (...values) => {
    for (const value of values) {
      const normalized = Number(value);
      if (Number.isFinite(normalized) && normalized >= 0) return normalized;
    }
    return null;
  };

  const totalTokens = firstFinite(usage.total_tokens, usage.totalTokens);
  const inputTokens = firstFinite(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.inputTokens,
    usage.promptTokens,
  );
  const outputTokens = firstFinite(
    usage.output_tokens,
    usage.completion_tokens,
    usage.outputTokens,
    usage.completionTokens,
  );

  return {
    inputTokens: inputTokens ?? Math.max(0, Number(totalTokens || 0) - Number(outputTokens || 0)),
    outputTokens: outputTokens ?? Math.max(0, Number(totalTokens || 0) - Number(inputTokens || 0)),
  };
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

  const usageCounts = extractUsageTokenCounts(response?.usage);

  return {
    id: String(response?.id || ""),
    type: "message",
    role: "assistant",
    content,
    model: String(response?.model || model || "unknown"),
    stop_reason: response?.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usageCounts.inputTokens,
      output_tokens: usageCounts.outputTokens,
    },
  };
}

module.exports = {
  normalizeCopilotTooling,
  shouldUseCopilotResponsesApi,
  shouldUseCopilotChatCompletionsApi,
  translateOpenAiChatBodyToResponsesRequest,
  translateResponsesApiResponseToAnthropic,
};
