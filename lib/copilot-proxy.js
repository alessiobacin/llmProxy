const { translateRequest, translateResponse, isClaude, resolveSupportedModel } = require("./openai-translate");
const {
  shouldUseCopilotResponsesApi,
  shouldUseCopilotChatCompletionsApi,
  translateOpenAiChatBodyToResponsesRequest,
  translateResponsesApiResponseToAnthropic,
} = require("./copilot-responses");

const COPILOT_API_URL = "https://api.githubcopilot.com";

function shouldFallbackToNextProvider(status, errorText) {
  const statusCode = Number(status) || 0;
  const text = String(errorText || "");
  if (statusCode === 0) return true;
  if (statusCode === 401 || statusCode === 408 || statusCode === 429) return true;
  if (statusCode >= 500) return true;
  return /network error|fetch failed|timeout|temporar/i.test(text);
}

function buildProviderCandidates(tokenStore) {
  if (tokenStore?.listProviders) {
    return tokenStore.listProviders().filter((provider) => provider.access_token);
  }

  const accessToken = tokenStore?.getAccessToken ? tokenStore.getAccessToken() : null;
  if (!accessToken) return [];
  return [{ id: "default", name: "Default GitHub Copilot", access_token: accessToken }];
}

function buildCopilotHeaders(accessToken, userAgent = "llmproxy/0.1.0") {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
    "Openai-Intent": "conversation-edits",
    "x-initiator": "agent",
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicMessageAsSse(res, message) {
  sendSse(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      content: [],
      model: message.model,
      stop_reason: null,
      stop_sequence: null,
      usage: message.usage || { input_tokens: 0, output_tokens: 0 },
    },
  });

  message.content.forEach((block, index) => {
    if (block.type === "text") {
      sendSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      sendSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
      sendSse(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
      return;
    }

    if (block.type === "tool_use") {
      sendSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      sendSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
      sendSse(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    }
  });

  sendSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null },
    usage: message.usage || { input_tokens: 0, output_tokens: 0 },
  });
  sendSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function handleStreaming(fetchResponse, res, responseModel) {
  const decoder = new TextDecoder();
  const reader = fetchResponse.body.getReader();
  let buffer = "";
  let nextBlockIndex = 0;
  let textBlockIndex = -1;
  let thinkingBlockIndex = -1;
  const toolCalls = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  let actualModel = "";

  sendSse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      content: [],
      model: responseModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;
      if (!actualModel && chunk.model) actualModel = String(chunk.model);
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || inputTokens;
        outputTokens = chunk.usage.completion_tokens || outputTokens;
      }
      if (choice.finish_reason) stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";

      if (delta.reasoning_content) {
        if (textBlockIndex !== -1) {
          sendSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockIndex = -1;
        }
        if (thinkingBlockIndex === -1) {
          thinkingBlockIndex = nextBlockIndex++;
          sendSse(res, "content_block_start", {
            type: "content_block_start",
            index: thinkingBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          });
        }
        sendSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: thinkingBlockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        });
      }

      if (delta.content) {
        if (thinkingBlockIndex !== -1) {
          sendSse(res, "content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
          thinkingBlockIndex = -1;
        }
        if (textBlockIndex === -1) {
          textBlockIndex = nextBlockIndex++;
          sendSse(res, "content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        sendSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const toolCall of delta.tool_calls || []) {
        if (textBlockIndex !== -1) {
          sendSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
          textBlockIndex = -1;
        }
        if (thinkingBlockIndex !== -1) {
          sendSse(res, "content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
          thinkingBlockIndex = -1;
        }

        const toolCallIndex = toolCall.index ?? 0;
        if (toolCall.id) {
          const blockIndex = nextBlockIndex++;
          toolCalls.set(toolCallIndex, blockIndex);
          sendSse(res, "content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.function?.name || "tool",
              input: {},
            },
          });
        }
        const blockIndex = toolCalls.get(toolCallIndex);
        if (blockIndex === undefined) continue;
        const partialJson = toolCall.function?.arguments || "";
        if (partialJson) {
          sendSse(res, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: partialJson },
          });
        }
      }
    }
  }

  if (thinkingBlockIndex !== -1) sendSse(res, "content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
  if (textBlockIndex !== -1) sendSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
  for (const index of toolCalls.values()) {
    sendSse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  sendSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  sendSse(res, "message_stop", { type: "message_stop" });
  res.end();
  return {
    actualModel: actualModel || responseModel,
  };
}

async function proxyAnthropicRequest(options) {
  const {
    anthropicBody,
    req,
    res,
    requestId,
    projectName,
    configuredModel,
    tokenStore,
    fetchFn = fetch,
    endpointPreferences,
    logger,
    availableModels,
  } = options;

  const providers = buildProviderCandidates(tokenStore);
  if (providers.length === 0) {
    res.status(401).json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "GitHub Copilot non autenticato. Esegui `llmproxy login`.",
      },
    });
    return;
  }

  const openaiBody = translateRequest(anthropicBody);
  const requestModel = configuredModel || anthropicBody.model || openaiBody.model;
  const targetModel = resolveSupportedModel(configuredModel || openaiBody.model, undefined, availableModels);
  openaiBody.model = targetModel;
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const providerPreferenceKey = `${provider.id}:${targetModel}`;
    const headers = buildCopilotHeaders(provider.access_token);
    if (isClaude(targetModel)) {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }

    let endpoint = endpointPreferences.getPreferredEndpoint(providerPreferenceKey)
      || endpointPreferences.getPreferredEndpoint(targetModel)
      || "chat";
    let switched = false;

    while (true) {
      const startedAt = Date.now();
      logger.logProviderAttempt({
        requestId,
        projectName,
        configuredModel,
        provider: provider.id,
        endpoint,
        requestedModel: requestModel,
        effectiveModel: targetModel,
      });

      let response;
      try {
        if (endpoint === "responses") {
          response = await fetchFn(`${COPILOT_API_URL}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(translateOpenAiChatBodyToResponsesRequest(openaiBody)),
          });
        } else {
          response = await fetchFn(`${COPILOT_API_URL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(openaiBody),
          });
        }
      } catch (error) {
        logger.logProviderResult({
          requestId,
          projectName,
          configuredModel,
          provider: provider.id,
          endpoint,
          success: false,
          durationMs: Date.now() - startedAt,
          requestedModel: requestModel,
          effectiveModel: targetModel,
          error: error.message,
        });

        if (providerIndex < providers.length - 1 && shouldFallbackToNextProvider(0, error.message)) {
          break;
        }

        res.status(502).json({
          type: "error",
          error: { type: "api_error", message: `Copilot network error: ${error.message}` },
        });
        return;
      }

      if (!response.ok) {
        const errorText = typeof response.text === "function" ? await response.text() : "request_failed";
        logger.logProviderResult({
          requestId,
          projectName,
          configuredModel,
          provider: provider.id,
          endpoint,
          success: false,
          status: response.status,
          durationMs: Date.now() - startedAt,
          requestedModel: requestModel,
          effectiveModel: targetModel,
          error: errorText,
        });

        const shouldSwitch = endpoint === "responses"
          ? shouldUseCopilotChatCompletionsApi(response.status, errorText)
          : shouldUseCopilotResponsesApi(response.status, errorText);

        if (!switched && shouldSwitch) {
          endpoint = endpoint === "responses" ? "chat" : "responses";
          switched = true;
          continue;
        }

        if (providerIndex < providers.length - 1 && shouldFallbackToNextProvider(response.status, errorText)) {
          break;
        }

        res.status(response.status).json({
          type: "error",
          error: {
            type: response.status === 401 ? "authentication_error" : "api_error",
            message: response.status === 401
              ? "Token Copilot scaduto o non valido. Esegui `llmproxy login` di nuovo."
              : `Copilot API ${response.status}: ${errorText.slice(0, 500)}`,
          },
        });
        return;
      }

      endpointPreferences.setPreferredEndpoint(providerPreferenceKey, endpoint, { source: switched ? "auto-switch" : "runtime", status: response.status });

      if (endpoint === "responses") {
        const payload = await response.json();
        const translated = translateResponsesApiResponseToAnthropic(payload, targetModel);
        logger.logProviderResult({
          requestId,
          projectName,
          configuredModel,
          provider: provider.id,
          endpoint,
          success: true,
          status: response.status,
          durationMs: Date.now() - startedAt,
          requestedModel: requestModel,
          effectiveModel: targetModel,
          actualModel: payload?.model || targetModel,
        });
        if (anthropicBody.stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          sendAnthropicMessageAsSse(res, translated);
        } else {
          res.json(translated);
        }
        return;
      }

      if (anthropicBody.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const streamingResult = await handleStreaming(response, res, targetModel);
        logger.logProviderResult({
          requestId,
          projectName,
          configuredModel,
          provider: provider.id,
          endpoint,
          success: true,
          status: response.status,
          durationMs: Date.now() - startedAt,
          requestedModel: requestModel,
          effectiveModel: targetModel,
          actualModel: streamingResult.actualModel,
        });
        return;
      }

      const payload = await response.json();
      const translated = translateResponse(payload, targetModel);
      logger.logProviderResult({
        requestId,
        projectName,
        configuredModel,
        provider: provider.id,
        endpoint,
        success: true,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestedModel: requestModel,
        effectiveModel: targetModel,
        actualModel: payload?.model || targetModel,
      });
      res.json(translated);
      return;
    }
  }

  res.status(502).json({
    type: "error",
    error: {
      type: "api_error",
      message: "Tutti i provider GitHub Copilot configurati hanno fallito.",
    },
  });
}

module.exports = {
  proxyAnthropicRequest,
  buildCopilotHeaders,
  shouldFallbackToNextProvider,
};