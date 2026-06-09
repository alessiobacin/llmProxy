const { translateRequest, translateResponse, isClaude, resolveSupportedModel } = require("./openai-translate");
const {
  normalizeCopilotTooling,
  shouldUseCopilotResponsesApi,
  shouldUseCopilotChatCompletionsApi,
  translateOpenAiChatBodyToResponsesRequest,
  translateResponsesApiResponseToAnthropic,
} = require("./copilot-responses");
const { buildMeteringRecord, emitMetering } = require("./metering");

const COPILOT_API_URL = "https://api.githubcopilot.com";
const API_KEY_PROVIDER_CONFIGS = {
  openrouter: {
    displayName: "OpenRouter",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://openrouter.ai/api/v1/chat/completions",
  },
  zai: {
    displayName: "Z.ai",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.z.ai/api/paas/v4/chat/completions",
  },
  kimi: {
    displayName: "Kimi",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.moonshot.ai/v1/chat/completions",
  },
  openai: {
    displayName: "OpenAI",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
  },
  anthropic: {
    displayName: "Anthropic",
    protocol: "anthropic-messages",
    messagesUrl: "https://api.anthropic.com/v1/messages",
  },
  deepseek: {
    displayName: "DeepSeek",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.deepseek.com/v1/chat/completions",
    defaultModel: "deepseek-v4-flash",
    supportsModel: (model) => /^(deepseek-v4-(flash|pro)|deepseek-chat|deepseek-reasoner)$/i.test(String(model || "").trim()),
  },
  groq: {
    displayName: "Groq",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.groq.com/openai/v1/chat/completions",
  },
  mistral: {
    displayName: "Mistral",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.mistral.ai/v1/chat/completions",
  },
  xai: {
    displayName: "xAI",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.x.ai/v1/chat/completions",
  },
  perplexity: {
    displayName: "Perplexity",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.perplexity.ai/chat/completions",
  },
  together: {
    displayName: "Together",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.together.xyz/v1/chat/completions",
  },
  fireworks: {
    displayName: "Fireworks",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
  },
};

function shouldFallbackToNextProvider(status, errorText) {
  const statusCode = Number(status) || 0;
  const text = String(errorText || "").trim();
  return statusCode > 0 || text.length > 0;
}

function isTransientNetworkError(errorText) {
  const text = String(errorText || "");
  return /socket connection was closed unexpectedly|socket.*closed|econnreset|econnrefused|etimedout|und_err_socket|network error|fetch failed|timeout|temporar/i.test(text);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithNetworkRetry(requestFn, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 2);
  const retryDelayMs = Number(options.retryDelayMs || 200);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error || "");
      const canRetry = attempt < maxAttempts && isTransientNetworkError(message);
      if (!canRetry) throw error;
      await delay(retryDelayMs * attempt);
    }
  }

  throw lastError || new Error("network request failed");
}

function isContextLimitError(status, errorText) {
  const statusCode = Number(status) || 0;
  if (statusCode !== 400) return false;
  const text = String(errorText || "");
  return /token limit|maximum context length|context length exceeded|requested:\s*\d+|too many tokens|prompt token count.*exceeds the limit|model_max_prompt_tokens_exceeded|max[_\s-]*prompt[_\s-]*tokens[_\s-]*exceeded/i.test(text);
}

function trimOldestNonSystemMessage(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;
  const removableIndex = messages.findIndex((msg) => String(msg?.role || "").toLowerCase() !== "system");
  const indexToRemove = removableIndex >= 0 ? removableIndex : 0;
  if (messages.length - 1 <= 0) return messages;
  return messages.filter((_, index) => index !== indexToRemove);
}

function getContextTrimTarget(messagesProtocol, providerOpenaiBody, providerAnthropicBody) {
  if (messagesProtocol === "anthropic-messages") {
    return {
      messages: providerAnthropicBody?.messages,
      apply(trimmedMessages) {
        return {
          providerOpenaiBody,
          providerAnthropicBody: { ...providerAnthropicBody, messages: trimmedMessages },
        };
      },
    };
  }
  return {
    messages: providerOpenaiBody?.messages,
    apply(trimmedMessages) {
      return {
        providerOpenaiBody: { ...providerOpenaiBody, messages: trimmedMessages },
        providerAnthropicBody,
      };
    },
  };
}

function buildProviderCandidates(tokenStore) {
  if (tokenStore?.listProviders) {
    return tokenStore
      .listProviders()
      .filter((provider) => provider.access_token)
      .filter((provider) => {
        const providerKind = String(provider.provider || "copilot").toLowerCase();
        return providerKind === "copilot" || API_KEY_PROVIDER_CONFIGS[providerKind];
      });
  }

  const accessToken = tokenStore?.getAccessToken ? tokenStore.getAccessToken() : null;
  if (!accessToken) return [];
  return [{ id: "default", name: "Default GitHub Copilot", access_token: accessToken }];
}

function getProviderKind(provider) {
  return String(provider?.provider || "copilot").toLowerCase();
}

/**
 * Moonshot (Kimi) JSON Schema validator is strict: it rejects objects that have
 * both `$ref` and any sibling keywords (e.g. `description`). This function
 * recursively strips sibling keywords from any schema node that contains `$ref`.
 */
function sanitizeSchemaForMoonshot(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if ("$ref" in schema) {
    // Keep only $ref, discard sibling keywords
    return { $ref: schema["$ref"] };
  }
  const result = {};
  for (const key of Object.keys(schema)) {
    const value = schema[key];
    if (key === "properties" && value && typeof value === "object") {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, sanitizeSchemaForMoonshot(v)])
      );
    } else if ((key === "items" || key === "additionalProperties") && value && typeof value === "object") {
      result[key] = sanitizeSchemaForMoonshot(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      result[key] = value.map(sanitizeSchemaForMoonshot);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function sanitizeToolsForMoonshot(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (tool?.function?.parameters) {
      return {
        ...tool,
        function: {
          ...tool.function,
          parameters: sanitizeSchemaForMoonshot(tool.function.parameters),
        },
      };
    }
    return tool;
  });
}

/**
 * Providers that support vision (image_url) content in messages.
 * All others will have image_url blocks replaced with a text placeholder.
 */
const VISION_CAPABLE_PROVIDERS = new Set(["copilot", "openai", "anthropic", "openrouter"]);

/**
 * Replaces image_url content blocks with a text placeholder for providers
 * that do not support vision input (e.g. DeepSeek, Groq, Mistral, kimi).
 */
function sanitizeVisionContent(messages) {
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const hasImageUrl = msg.content.some((block) => block.type === "image_url");
    if (!hasImageUrl) return msg;
    const sanitized = msg.content.map((block) =>
      block.type === "image_url" ? { type: "text", text: "[image]" } : block,
    );
    // Collapse single-text array to a plain string for cleaner payloads
    if (sanitized.every((b) => b.type === "text")) {
      const joined = sanitized.map((b) => b.text).join("\n").trim();
      return { ...msg, content: joined || "" };
    }
    return { ...msg, content: sanitized };
  });
}

function hasImageInOpenAiMessages(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((msg) => Array.isArray(msg?.content)
    && msg.content.some((block) => block?.type === "image_url"));
}

function buildApiKeyProviderHeaders(accessToken, userAgent = "llmproxy/0.1.0") {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
  };
}

async function probeApiKeyProviderModel({ provider, apiKey, model, fetchFn = fetch }) {
  const providerKind = getProviderKind({ provider });
  const providerConfig = API_KEY_PROVIDER_CONFIGS[providerKind];
  const targetModel = String(model || "").trim();
  const accessToken = String(apiKey || "").trim();

  if (!providerConfig) {
    return { ok: false, status: 400, error: `Provider API-key non supportato: ${providerKind}` };
  }
  if (!accessToken) {
    return { ok: false, status: 400, error: "API key richiesta" };
  }
  if (!targetModel) {
    return { ok: false, status: 400, error: "Modello di default richiesto" };
  }

  const body = providerConfig.protocol === "anthropic-messages"
    ? {
        model: targetModel,
        max_tokens: 16,
        messages: [{ role: "user", content: "Rispondi solo con: ok" }],
      }
    : {
        model: targetModel,
        max_tokens: 16,
        messages: [{ role: "user", content: "Rispondi solo con: ok" }],
      };
  const headers = providerConfig.protocol === "anthropic-messages"
    ? buildAnthropicHeaders(accessToken)
    : buildApiKeyProviderHeaders(accessToken);
  const url = providerConfig.messagesUrl || providerConfig.chatCompletionsUrl;

  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }

  if (response.ok) return { ok: true, status: response.status };
  const errorText = typeof response.text === "function" ? await response.text() : "request_failed";
  return { ok: false, status: response.status, error: errorText.slice(0, 500) };
}

function buildAnthropicHeaders(accessToken, userAgent = "llmproxy/0.1.0") {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": accessToken,
    "anthropic-version": "2023-06-01",
    "User-Agent": userAgent,
  };
}

function providerSupportsRequestedModel(provider, model) {
  const providerKind = getProviderKind(provider);
  if (providerKind === "copilot") return false;
  const providerConfig = API_KEY_PROVIDER_CONFIGS[providerKind];
  if (!providerConfig) return false;
  if (typeof providerConfig.supportsModel === "function") return providerConfig.supportsModel(model);
  return true;
}

function parseProviderModelPreferences(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIndex = entry.indexOf(":");
      if (colonIndex > 0) {
        return {
          provider: entry.slice(0, colonIndex).trim().toLowerCase(),
          model: entry.slice(colonIndex + 1).trim(),
        };
      }

      const matchedProvider = ["copilot", ...Object.keys(API_KEY_PROVIDER_CONFIGS).filter((provider) => provider !== "kimi" && provider !== "deepseek" && provider !== "mistral")]
        .sort((left, right) => right.length - left.length)
        .find((provider) => entry.toLowerCase().startsWith(`${provider}-`));
      if (matchedProvider) {
        return {
          provider: matchedProvider,
          model: entry.slice(matchedProvider.length + 1).trim(),
        };
      }

      return { provider: null, model: entry };
    })
    .filter((entry) => entry.model);
}

function providerMatchesPreference(provider, preferenceProvider) {
  if (!preferenceProvider) return true;
  const normalized = String(preferenceProvider || "").trim().toLowerCase();
  return normalized === getProviderKind(provider) || normalized === String(provider?.id || "").toLowerCase();
}

function buildProviderModelCandidates(provider, modelPreference, openaiModel, availableModels, options = {}) {
  const providerKind = getProviderKind(provider);
  const providerConfig = API_KEY_PROVIDER_CONFIGS[providerKind] || null;
  const preferences = parseProviderModelPreferences(modelPreference);
  const providerSpecificModels = preferences
    .filter((preference) => providerMatchesPreference(provider, preference.provider))
    .map((preference) => preference.model);
  const useGlobalRequestedModel = !options.hasProviderModelPreferences && (options.explicitProvider || providerKind === "copilot" || !provider.default_model);
  const requestedModelsRaw = providerSpecificModels.length > 0
    ? providerSpecificModels
    : useGlobalRequestedModel
      ? preferences.filter((preference) => !preference.provider).map((preference) => preference.model)
      : [];
  const requestedModels = requestedModelsRaw.filter((model) => providerKind === "copilot" || providerSupportsRequestedModel(provider, model));
  const fallbackDefaultModel = String(provider.default_model || providerConfig?.defaultModel || "").trim();
  const rawCandidates = [...requestedModels];

  if (rawCandidates.length === 0 && openaiModel && useGlobalRequestedModel && providerSupportsRequestedModel(provider, openaiModel)) {
    rawCandidates.push(openaiModel);
  }
  if (fallbackDefaultModel) rawCandidates.push(fallbackDefaultModel);

  if (rawCandidates.length === 0 && providerKind === "copilot") {
    rawCandidates.push(resolveSupportedModel(openaiModel, undefined, availableModels));
  }

  const seen = new Set();
  return rawCandidates
    .map((model) => {
      const rawModel = String(model || "").trim();
      const colonPrefix = `${providerKind}:`;
      const dashPrefix = `${providerKind}-`;
      const normalizedModel = rawModel.toLowerCase().startsWith(colonPrefix)
        ? rawModel.slice(colonPrefix.length)
        : rawModel.toLowerCase().startsWith(dashPrefix) && providerKind !== "kimi" && providerKind !== "deepseek" && providerKind !== "mistral"
          ? rawModel.slice(dashPrefix.length)
          : rawModel;
      if (providerKind === "copilot" && !options.preserveCopilotModel && !fallbackDefaultModel) {
        return resolveSupportedModel(normalizedModel, undefined, availableModels);
      }
      return normalizedModel;
    })
    .filter(Boolean)
    .filter((model) => {
      const key = model.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

function buildInferenceFooter(providerId, modelUsed) {
  const provider = String(providerId || "").trim();
  const model = String(modelUsed || "").trim();
  if (!provider && !model) return "";
  return `\n\n[llmproxy] provider: ${provider || "unknown"} | model: ${model || "unknown"}`;
}

function appendInferenceFooterToMessage(message, providerId, modelUsed) {
  if (!message || message.stop_reason === "tool_use") return message;
  const footer = buildInferenceFooter(providerId, modelUsed);
  if (!footer) return message;
  const content = Array.isArray(message.content) ? [...message.content] : [];
  let lastTextIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === "text") {
      lastTextIndex = index;
      break;
    }
  }
  if (lastTextIndex === -1) {
    content.push({ type: "text", text: footer.trimStart() });
  } else {
    content[lastTextIndex] = {
      ...content[lastTextIndex],
      text: `${String(content[lastTextIndex].text || "")}${footer}`,
    };
  }
  return { ...message, content };
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

async function relayAnthropicStreamWithFooter(fetchResponse, res, options = {}) {
  const reader = fetchResponse.body?.getReader ? fetchResponse.body.getReader() : null;
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let maxContentIndex = -1;
  let footerSent = false;
  const footer = buildInferenceFooter(options.providerId, options.modelUsed);

  const maybeSendFooter = (stopReason) => {
    if (footerSent || !footer || stopReason === "tool_use") return;
    const footerIndex = maxContentIndex + 1;
    sendSse(res, "content_block_start", {
      type: "content_block_start",
      index: footerIndex,
      content_block: { type: "text", text: "" },
    });
    sendSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: footerIndex,
      delta: { type: "text_delta", text: footer },
    });
    sendSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: footerIndex,
    });
    maxContentIndex = footerIndex;
    footerSent = true;
  };

  const processEventBlock = (block) => {
    const lines = String(block || "").split("\n");
    let eventName = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || eventName;
        continue;
      }
      if (line.startsWith("data:")) {
        data += `${data ? "\n" : ""}${line.slice(5).trim()}`;
      }
    }
    if (!data) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      res.write(`event: ${eventName}\ndata: ${data}\n\n`);
      return;
    }

    if (eventName === "content_block_start" && Number.isInteger(payload?.index)) {
      maxContentIndex = Math.max(maxContentIndex, payload.index);
    }
    if (eventName === "message_delta") {
      maybeSendFooter(payload?.delta?.stop_reason || null);
    }
    sendSse(res, eventName, payload);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      if (block.trim()) processEventBlock(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const blocks = buffer.split("\n\n");
    for (const block of blocks) {
      if (block.trim()) processEventBlock(block);
    }
  }
  res.end();
}

async function handleStreaming(fetchResponse, res, responseModel, options = {}) {
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
  const footer = buildInferenceFooter(options.providerId, actualModel || responseModel);
  if (footer && stopReason !== "tool_use") {
    const footerIndex = nextBlockIndex++;
    sendSse(res, "content_block_start", {
      type: "content_block_start",
      index: footerIndex,
      content_block: { type: "text", text: "" },
    });
    sendSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: footerIndex,
      delta: { type: "text_delta", text: footer },
    });
    sendSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: footerIndex,
    });
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
    inputTokens,
    outputTokens,
  };
}

async function proxyAnthropicRequest(options) {
  const {
    anthropicBody,
    req,
    res,
    requestId,
    traceId,
    hierarchyContext,
    meteringContext,
    meteringSink,
    eventBusSink,
    projectName,
    configuredModel,
    provider: requestedProvider,
    tokenStore,
    fetchFn = fetch,
    endpointPreferences,
    logger,
    availableModels,
  } = options;

  const requestStartedAt = Date.now();
  const providerAttempts = [];

  function pushProviderAttempt(payload = {}) {
    providerAttempts.push({
      provider: payload.provider || null,
      provider_kind: payload.providerKind || null,
      endpoint: payload.endpoint || null,
      status: typeof payload.status === "number" ? payload.status : null,
      success: payload.success === true,
      duration_ms: typeof payload.durationMs === "number" ? payload.durationMs : null,
      requested_model: payload.requestedModel || null,
      effective_model: payload.effectiveModel || null,
      actual_model: payload.actualModel || null,
      error: payload.error ? String(payload.error).slice(0, 500) : null,
    });
  }

  async function emitRequestMetering(payload = {}) {
    const record = buildMeteringRecord({
      idempotencyKey: `${requestId}:${providerAttempts.length}`,
      requestId,
      traceId,
      provider: payload.provider || null,
      providerAttempts,
      modelRequested: requestModel,
      modelUsed: payload.modelUsed || null,
      endpoint: payload.endpoint || null,
      durationMs: Date.now() - requestStartedAt,
      promptTokens: payload.promptTokens,
      completionTokens: payload.completionTokens,
      success: payload.success,
      errorCode: payload.errorCode || null,
      hierarchyContext,
      meteringContext,
      customDimensions: meteringContext?.custom_dimensions || null,
    });
    await emitMetering(meteringSink, record);
    if (eventBusSink && typeof eventBusSink.publish === "function") {
      // fire-and-forget: do not await, never block the response
      eventBusSink.publish({ payload: record, hierarchyContext }).catch(() => {});
    }
  }

  let providers = buildProviderCandidates(tokenStore);
  if (requestedProvider && requestedProvider !== "auto") {
    providers = providers.filter((candidate) => getProviderKind(candidate) === requestedProvider || String(candidate.id || "").toLowerCase() === requestedProvider);
  }
  if (providers.length === 0) {
    res.status(401).json({
      type: "error",
      error: {
        type: "authentication_error",
        message: requestedProvider && requestedProvider !== "auto"
          ? `Provider non configurato o non autenticato: ${requestedProvider}.`
          : "Nessun provider autenticato. Esegui `llmproxy login` o configura un provider API-key.",
      },
    });
    return;
  }

  const openaiBody = translateRequest(anthropicBody);
  const requestModel = String(configuredModel || anthropicBody.model || "").trim();
  const clientProvidedModel = Boolean(configuredModel || anthropicBody.model);
  const requestedMappedModel = clientProvidedModel ? openaiBody.model : "";
  const requestHasImageInput = hasImageInOpenAiMessages(openaiBody.messages);
  const hasVisionProviderInChain = providers.some((candidate) => VISION_CAPABLE_PROVIDERS.has(getProviderKind(candidate)));
  const hasApiKeyProviderForRequestedModel = providers.some((provider) => providerSupportsRequestedModel(provider, requestedMappedModel));
  const hasProviderModelPreferences = parseProviderModelPreferences(requestModel).some((preference) => preference.provider);
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const providerKind = getProviderKind(provider);
    if (requestHasImageInput && hasVisionProviderInChain && !VISION_CAPABLE_PROVIDERS.has(providerKind)) {
      continue;
    }
    const apiKeyProviderConfig = API_KEY_PROVIDER_CONFIGS[providerKind] || null;
    const headers = providerKind === "copilot"
      ? buildCopilotHeaders(provider.access_token)
      : apiKeyProviderConfig?.protocol === "anthropic-messages"
        ? buildAnthropicHeaders(provider.access_token)
        : buildApiKeyProviderHeaders(provider.access_token);
    const modelCandidates = buildProviderModelCandidates(
      provider,
      requestModel,
      requestedMappedModel,
      availableModels,
      {
        preserveCopilotModel: hasApiKeyProviderForRequestedModel || hasProviderModelPreferences,
        hasProviderModelPreferences,
        explicitProvider: Boolean(requestedProvider && requestedProvider !== "auto"),
      },
    );

    for (let modelIndex = 0; modelIndex < modelCandidates.length; modelIndex += 1) {
      const targetModel = modelCandidates[modelIndex];
      let rawOpenaiBody = (providerKind === "kimi" && openaiBody.tools?.length)
        ? { ...openaiBody, tools: sanitizeToolsForMoonshot(openaiBody.tools) }
        : openaiBody;
      let toolAdjustment = null;
      if (providerKind === "copilot" && rawOpenaiBody.tools?.length) {
        const originalToolCount = Array.isArray(rawOpenaiBody.tools) ? rawOpenaiBody.tools.length : 0;
        const originalToolChoice = rawOpenaiBody.tool_choice;
        rawOpenaiBody = normalizeCopilotTooling(rawOpenaiBody);
        const effectiveToolCount = Array.isArray(rawOpenaiBody.tools) ? rawOpenaiBody.tools.length : 0;
        const toolChoiceAdjusted = originalToolChoice !== rawOpenaiBody.tool_choice;

        if (effectiveToolCount < originalToolCount || toolChoiceAdjusted) {
          toolAdjustment = {
            kind: "copilot_tools_truncated",
            originalToolCount,
            effectiveToolCount,
            droppedToolCount: Math.max(0, originalToolCount - effectiveToolCount),
            toolChoiceAdjusted,
          };
        }
      }
      if (!VISION_CAPABLE_PROVIDERS.has(providerKind) && rawOpenaiBody.messages?.length) {
        rawOpenaiBody = { ...rawOpenaiBody, messages: sanitizeVisionContent(rawOpenaiBody.messages) };
      }
      let providerOpenaiBody = { ...rawOpenaiBody, model: targetModel };
      let providerAnthropicBody = { ...anthropicBody, model: targetModel };
      delete providerAnthropicBody.provider;
      let contextTrimRetries = 0;
      const providerPreferenceKey = `${provider.id}:${targetModel}`;
      if (isClaude(targetModel)) {
        headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
      } else {
        delete headers["anthropic-beta"];
      }

      let endpoint = providerKind === "copilot"
        ? endpointPreferences.getPreferredEndpoint(providerPreferenceKey)
        || endpointPreferences.getPreferredEndpoint(targetModel)
        || "chat"
        : "chat";
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
          fallbackModel: modelIndex > 0,
          toolAdjustment,
        });

        let response;
        try {
          response = await fetchWithNetworkRetry(async () => {
            if (apiKeyProviderConfig?.protocol === "anthropic-messages") {
              return fetchFn(apiKeyProviderConfig.messagesUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(providerAnthropicBody),
              });
            }
            if (apiKeyProviderConfig) {
              return fetchFn(apiKeyProviderConfig.chatCompletionsUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(providerOpenaiBody),
              });
            }
            if (endpoint === "responses") {
              return fetchFn(`${COPILOT_API_URL}/responses`, {
                method: "POST",
                headers,
                body: JSON.stringify(translateOpenAiChatBodyToResponsesRequest(providerOpenaiBody)),
              });
            }
            return fetchFn(`${COPILOT_API_URL}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify(providerOpenaiBody),
            });
          });
        } catch (error) {
          const attemptDuration = Date.now() - startedAt;
          logger.logProviderResult({
            requestId,
            projectName,
            configuredModel,
            provider: provider.id,
            endpoint,
            success: false,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            error: error.message,
          });
          pushProviderAttempt({
            provider: provider.id,
            providerKind,
            endpoint,
            success: false,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            error: error.message,
          });

          if (modelIndex < modelCandidates.length - 1 && shouldFallbackToNextProvider(0, error.message)) {
            break;
          }
          if (providerIndex < providers.length - 1 && shouldFallbackToNextProvider(0, error.message)) {
            break;
          }

          res.status(502).json({
            type: "error",
            error: { type: "api_error", message: `${provider.name || provider.id} network error: ${error.message}` },
          });
          await emitRequestMetering({
            success: false,
            provider: provider.id,
            endpoint,
            modelUsed: targetModel,
            errorCode: "NETWORK_ERROR",
          });
          return;
        }

        if (!response.ok) {
          const errorText = typeof response.text === "function" ? await response.text() : "request_failed";
          const attemptDuration = Date.now() - startedAt;
          logger.logProviderResult({
            requestId,
            projectName,
            configuredModel,
            provider: provider.id,
            endpoint,
            success: false,
            status: response.status,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            error: errorText,
          });
          pushProviderAttempt({
            provider: provider.id,
            providerKind,
            endpoint,
            status: response.status,
            success: false,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            error: errorText,
          });

          const shouldSwitch = !apiKeyProviderConfig && (endpoint === "responses"
            ? shouldUseCopilotChatCompletionsApi(response.status, errorText)
            : shouldUseCopilotResponsesApi(response.status, errorText));

          if (!switched && shouldSwitch) {
            endpoint = endpoint === "responses" ? "chat" : "responses";
            switched = true;
            continue;
          }

          const trimTarget = getContextTrimTarget(apiKeyProviderConfig?.protocol, providerOpenaiBody, providerAnthropicBody);
          const maxContextTrimRetries = Array.isArray(trimTarget.messages)
            ? Math.max(0, trimTarget.messages.length - 1)
            : 0;
          const canTrimContext = isContextLimitError(response.status, errorText)
            && Array.isArray(trimTarget.messages)
            && trimTarget.messages.length > 1
            && contextTrimRetries < maxContextTrimRetries;

          if (canTrimContext) {
            const trimmedMessages = trimOldestNonSystemMessage(trimTarget.messages);
            if (trimmedMessages.length < trimTarget.messages.length) {
              contextTrimRetries += 1;
              const trimmedBodies = trimTarget.apply(trimmedMessages);
              providerOpenaiBody = trimmedBodies.providerOpenaiBody;
              providerAnthropicBody = trimmedBodies.providerAnthropicBody;
              continue;
            }
          }

          if (modelIndex < modelCandidates.length - 1 && shouldFallbackToNextProvider(response.status, errorText)) {
            break;
          }
          if (providerIndex < providers.length - 1 && shouldFallbackToNextProvider(response.status, errorText)) {
            break;
          }

          res.status(response.status).json({
            type: "error",
            error: {
              type: response.status === 401 ? "authentication_error" : "api_error",
              message: response.status === 401
                ? `${provider.name || provider.id}: credenziale scaduta o non valida.`
                : `${provider.name || provider.id} API ${response.status}: ${errorText.slice(0, 500)}`,
            },
          });
          await emitRequestMetering({
            success: false,
            provider: provider.id,
            endpoint,
            modelUsed: targetModel,
            errorCode: response.status === 401 ? "AUTH_REQUIRED" : `HTTP_${response.status}`,
          });
          return;
        }

        if (!apiKeyProviderConfig) {
          endpointPreferences.setPreferredEndpoint(providerPreferenceKey, endpoint, { source: switched ? "auto-switch" : "runtime", status: response.status });
        }

        if (apiKeyProviderConfig?.protocol === "anthropic-messages") {
          const attemptDuration = Date.now() - startedAt;
          logger.logProviderResult({
            requestId,
            projectName,
            configuredModel,
            provider: provider.id,
            endpoint,
            success: true,
            status: response.status,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            actualModel: targetModel,
          });
          if (anthropicBody.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            await relayAnthropicStreamWithFooter(response, res, {
              providerId: provider.id,
              modelUsed: targetModel,
            });
            pushProviderAttempt({
              provider: provider.id,
              providerKind,
              endpoint,
              status: response.status,
              success: true,
              durationMs: attemptDuration,
              requestedModel: requestModel,
              effectiveModel: targetModel,
              actualModel: targetModel,
            });
            await emitRequestMetering({
              success: true,
              provider: provider.id,
              endpoint,
              modelUsed: targetModel,
            });
          } else {
            const payload = await response.json();
            res.json(appendInferenceFooterToMessage(payload, provider.id, payload?.model || targetModel));
            const promptTokens = payload?.usage?.input_tokens;
            const completionTokens = payload?.usage?.output_tokens;
            pushProviderAttempt({
              provider: provider.id,
              providerKind,
              endpoint,
              status: response.status,
              success: true,
              durationMs: attemptDuration,
              requestedModel: requestModel,
              effectiveModel: targetModel,
              actualModel: payload?.model || targetModel,
            });
            await emitRequestMetering({
              success: true,
              provider: provider.id,
              endpoint,
              modelUsed: payload?.model || targetModel,
              promptTokens,
              completionTokens,
            });
          }
          return;
        }

        if (endpoint === "responses") {
          const payload = await response.json();
          const translated = translateResponsesApiResponseToAnthropic(payload, targetModel);
          const attemptDuration = Date.now() - startedAt;
          logger.logProviderResult({
            requestId,
            projectName,
            configuredModel,
            provider: provider.id,
            endpoint,
            success: true,
            status: response.status,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            actualModel: payload?.model || targetModel,
          });
          const promptTokens = translated?.usage?.input_tokens;
          const completionTokens = translated?.usage?.output_tokens;
          pushProviderAttempt({
            provider: provider.id,
            providerKind,
            endpoint,
            status: response.status,
            success: true,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            actualModel: payload?.model || targetModel,
          });
          if (anthropicBody.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            sendAnthropicMessageAsSse(
              res,
              appendInferenceFooterToMessage(translated, provider.id, payload?.model || targetModel),
            );
          } else {
            res.json(appendInferenceFooterToMessage(translated, provider.id, payload?.model || targetModel));
          }
          await emitRequestMetering({
            success: true,
            provider: provider.id,
            endpoint,
            modelUsed: payload?.model || targetModel,
            promptTokens,
            completionTokens,
          });
          return;
        }

        if (anthropicBody.stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          const streamingResult = await handleStreaming(response, res, targetModel, { providerId: provider.id });
          const attemptDuration = Date.now() - startedAt;
          logger.logProviderResult({
            requestId,
            projectName,
            configuredModel,
            provider: provider.id,
            endpoint,
            success: true,
            status: response.status,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            actualModel: streamingResult.actualModel,
          });
          pushProviderAttempt({
            provider: provider.id,
            providerKind,
            endpoint,
            status: response.status,
            success: true,
            durationMs: attemptDuration,
            requestedModel: requestModel,
            effectiveModel: targetModel,
            actualModel: streamingResult.actualModel,
          });
          await emitRequestMetering({
            success: true,
            provider: provider.id,
            endpoint,
            modelUsed: streamingResult.actualModel,
            promptTokens: streamingResult.inputTokens,
            completionTokens: streamingResult.outputTokens,
          });
          return;
        }

        const payload = await response.json();
        const translated = translateResponse(payload, targetModel);
        const attemptDuration = Date.now() - startedAt;
        logger.logProviderResult({
          requestId,
          projectName,
          configuredModel,
          provider: provider.id,
          endpoint,
          success: true,
          status: response.status,
          durationMs: attemptDuration,
          requestedModel: requestModel,
          effectiveModel: targetModel,
          actualModel: payload?.model || targetModel,
        });
        const promptTokens = translated?.usage?.input_tokens;
        const completionTokens = translated?.usage?.output_tokens;
        pushProviderAttempt({
          provider: provider.id,
          providerKind,
          endpoint,
          status: response.status,
          success: true,
          durationMs: attemptDuration,
          requestedModel: requestModel,
          effectiveModel: targetModel,
          actualModel: payload?.model || targetModel,
        });
        res.json(appendInferenceFooterToMessage(translated, provider.id, payload?.model || targetModel));
        await emitRequestMetering({
          success: true,
          provider: provider.id,
          endpoint,
          modelUsed: payload?.model || targetModel,
          promptTokens,
          completionTokens,
        });
        return;
      }
    }
  }

  res.status(502).json({
    type: "error",
    error: {
      type: "api_error",
      message: "Tutti i provider configurati hanno fallito.",
    },
  });
  await emitRequestMetering({
    success: false,
    provider: null,
    endpoint: null,
    modelUsed: null,
    errorCode: "PROVIDER_FALLBACK_EXHAUSTED",
  });
}

module.exports = {
  proxyAnthropicRequest,
  buildCopilotHeaders,
  shouldFallbackToNextProvider,
  isContextLimitError,
  trimOldestNonSystemMessage,
  API_KEY_PROVIDER_CONFIGS,
  parseProviderModelPreferences,
  probeApiKeyProviderModel,
  sanitizeSchemaForMoonshot,
  sanitizeToolsForMoonshot,
  VISION_CAPABLE_PROVIDERS,
  sanitizeVisionContent,
  hasImageInOpenAiMessages,
};
