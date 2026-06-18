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
const QWEN_PAYG_CHAT_COMPLETIONS_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_TOKEN_PLAN_CHAT_COMPLETIONS_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions";
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
  qwen: {
    displayName: "Qwen",
    protocol: "openai-chat",
    chatCompletionsUrl: QWEN_PAYG_CHAT_COMPLETIONS_URL,
    defaultModel: "qwen3.7-max",
    supportsModel: (model) => /^qwen/i.test(String(model || "").trim()),
  },
  opencode: {
    displayName: "OpenCode Zen",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://opencode.ai/zen/v1/chat/completions",
    defaultModel: "deepseek-v4-flash",
    supportsModel: (model) => /^(deepseek-v4-(flash|pro|flash-free)|minimax-m2\.(5|7)|glm-5(\.1)?|kimi-k2\.(5|6)|grok-build-0\.1|big-pickle|mimo-v2\.5-free|north-mini-code-free|nemotron-3-ultra-free)$/i.test(String(model || "").trim()),
  },
  "opencode-go": {
    displayName: "OpenCode Go",
    protocol: "anthropic-messages",
    messagesUrl: "https://opencode.ai/zen/go/v1/messages",
    defaultModel: "minimax-m3",
    supportsModel: (model) => /^(minimax-m3|minimax-m2\.(5|7)|qwen3\.(7-max|7-plus|6-plus))$/i.test(String(model || "").trim()),
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
  commandcode: {
    displayName: "Command Code",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://api.commandcode.ai/provider/v1/chat/completions",
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

function buildProviderCandidates(tokenStore, explicitCandidates) {
  if (Array.isArray(explicitCandidates) && explicitCandidates.length > 0) {
    return explicitCandidates
      .filter((provider) => provider && provider.access_token)
      .filter((provider) => {
        const providerKind = String(provider.provider || "copilot").toLowerCase();
        return providerKind === "copilot" || API_KEY_PROVIDER_CONFIGS[providerKind];
      });
  }

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

function normalizeMoonshotRef(refValue) {
  const ref = String(refValue || "").trim();
  if (!ref) return ref;
  // If already in correct format, return as-is
  if (ref.startsWith("#/$defs/")) return ref;
  // Convert #/definitions/... to #/$defs/...
  if (ref.startsWith("#/definitions/")) return ref.replace(/^#\/definitions\//, "#/$defs/");
  // Convert #/defs/... to #/$defs/...
  if (ref.startsWith("#/defs/")) return ref.replace(/^#\/defs\//, "#/$defs/");
  // If it's just a plain name (e.g., "TagFilter"), prefix with #/$defs/
  if (ref && !ref.startsWith("#/")) return `#/$defs/${ref}`;
  return ref;
}

/**
 * Moonshot (Kimi) JSON Schema validator is strict:
 * - it rejects objects that have both `$ref` and sibling keywords
 * - it expects internal references under `#/$defs/...`
 */
function sanitizeSchemaForMoonshot(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForMoonshot);
  }
  if (!schema || typeof schema !== "object") return schema;
  if ("$ref" in schema) {
    return { $ref: normalizeMoonshotRef(schema["$ref"]) };
  }

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((key === "definitions" || key === "defs") && value && typeof value === "object" && !Array.isArray(value)) {
      result.$defs = Object.fromEntries(
        Object.entries(value).map(([defKey, defValue]) => [defKey, sanitizeSchemaForMoonshot(defValue)])
      );
      continue;
    }
    if (key === "$defs" && value && typeof value === "object" && !Array.isArray(value)) {
      result.$defs = Object.fromEntries(
        Object.entries(value).map(([defKey, defValue]) => [defKey, sanitizeSchemaForMoonshot(defValue)])
      );
      continue;
    }
    if (value && typeof value === "object") {
      result[key] = sanitizeSchemaForMoonshot(value);
      continue;
    }
    result[key] = value;
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
 * Vision capability detection by model name and provider.
 * Returns true if the model is known to support image input.
 * When in doubt, returns false to avoid sending images to models that can't handle them.
 */
const VISION_CAPABLE_MODELS = {
  copilot: () => true, // Copilot uses Claude/GPT-4o which are vision-capable
  openai: (model) => /gpt-4(o|\.1|\.5)?|gpt-4-turbo|gpt-4-vision|o1|o3|o4/i.test(model),
  anthropic: (model) => /claude/i.test(model), // All Claude 3+ models support vision
  openrouter: () => true, // OpenRouter routes to vision-capable models when needed
  qwen: (model) => /vl|vision|qwen3\.7-plus/i.test(model), // VL models + qwen3.7-plus (multimodal); qwen3.7-max is text-only
  opencode: () => false, // OpenCode Zen support varies by model; stay conservative
  "opencode-go": () => false, // OpenCode Go models supported here are text-oriented
  deepseek: (model) => /deepseek-vl/i.test(model), // Only VL variants
  kimi: (model) => /vl|vision|kimi-vl|kimi-k2\.6/i.test(model), // VL variants + kimi-k2.6 (multimodal)
  mistral: (model) => /pixtral|vision/i.test(model), // Pixtral and vision models
  groq: () => false, // Groq doesn't support vision
  xai: (model) => /grok-2-vision|grok-3/i.test(model), // Grok-2-vision and Grok-3
  perplexity: () => false, // Perplexity is search-focused, no vision
  together: (model) => /vision|vl|llava/i.test(model), // Only explicit vision models
  fireworks: (model) => /vision|vl|llava/i.test(model), // Only explicit vision models
  zai: () => false, // Z.ai - unknown, conservative
};

function isVisionCapableModel(model, providerKind) {
  const normalizedModel = String(model || "").trim().toLowerCase();
  const checker = VISION_CAPABLE_MODELS[providerKind];
  if (!checker) return false; // Unknown provider, conservative
  return checker(normalizedModel);
}

/**
 * Providers where vision is broadly supported (all or most models).
 * Used as a quick provider-level check; prefer isVisionCapableModel() for per-model precision.
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

const INFERENCE_METADATA_LINE_REGEX = /^\s*(?:[-*•]\s*)?\[llmproxy\]\s+.*$/gim;

function removeInferenceMetadataLines(text) {
  return String(text || "").replace(INFERENCE_METADATA_LINE_REGEX, "");
}

function stripInferenceMetadataFromText(text) {
  return removeInferenceMetadataLines(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripInferenceMetadataFromDeltaText(text) {
  return removeInferenceMetadataLines(text).replace(/\n{3,}/g, "\n\n");
}

function sanitizeInferenceMetadataInMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    if (typeof msg.content === "string") {
      return { ...msg, content: stripInferenceMetadataFromText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (!block || typeof block !== "object" || block.type !== "text") return block;
          return { ...block, text: stripInferenceMetadataFromText(block.text) };
        }),
      };
    }
    return msg;
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

function normalizeQwenEndpointVariant(rawVariant) {
  const variant = String(rawVariant || "").trim().toLowerCase();
  if (!variant) return "";
  if (["subscription", "token-plan", "token_plan", "tokenplan", "plan"].includes(variant)) return "token_plan";
  if (["payg", "pay-as-you-go", "pay_as_you_go", "dashscope", "standard"].includes(variant)) return "dashscope";
  if (variant === "token_plan" || variant === "dashscope") return variant;
  return "";
}

function getApiKeyProviderRequestUrls(provider, accessToken) {
  const providerKind = getProviderKind(provider);
  const providerConfig = API_KEY_PROVIDER_CONFIGS[providerKind] || null;
  if (!providerConfig) return [];

  if (providerConfig.protocol === "anthropic-messages") {
    return providerConfig.messagesUrl ? [providerConfig.messagesUrl] : [];
  }

  if (providerKind === "qwen") {
    const token = String(accessToken || provider?.access_token || "").trim();
    const configuredVariant = normalizeQwenEndpointVariant(provider?.endpoint_variant || provider?.endpointVariant);
    if (configuredVariant === "token_plan") {
      return [QWEN_TOKEN_PLAN_CHAT_COMPLETIONS_URL];
    }
    if (configuredVariant === "dashscope") {
      return [QWEN_PAYG_CHAT_COMPLETIONS_URL];
    }
    if (/^sk-sp-/i.test(token)) {
      return [QWEN_TOKEN_PLAN_CHAT_COMPLETIONS_URL, QWEN_PAYG_CHAT_COMPLETIONS_URL];
    }
    return [QWEN_PAYG_CHAT_COMPLETIONS_URL, QWEN_TOKEN_PLAN_CHAT_COMPLETIONS_URL];
  }

  return providerConfig.chatCompletionsUrl ? [providerConfig.chatCompletionsUrl] : [];
}

async function probeApiKeyProviderModel({ provider, apiKey, model, fetchFn = fetch }) {
  const providerDescriptor = provider && typeof provider === "object" ? provider : { provider };
  const providerKind = getProviderKind(providerDescriptor);
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
  const urls = getApiKeyProviderRequestUrls(providerDescriptor, accessToken);
  let lastFailure = { ok: false, status: 0, error: "request_failed" };

  for (const url of urls) {
    let response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastFailure = { ok: false, status: 0, error: error.message };
      continue;
    }

    if (response.ok) return { ok: true, status: response.status };
    const errorText = typeof response.text === "function" ? await response.text() : "request_failed";
    lastFailure = { ok: false, status: response.status, error: errorText.slice(0, 500) };
  }

  return lastFailure;
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

function isMeteringInlineEnabled() {
  const raw = String(process.env.LLMPROXY_METERING_INLINE || "").trim();
  return raw === "true" || raw === "1";
}

function buildInferenceHeader(providerId, modelUsed) {
  if (!isMeteringInlineEnabled()) return "";
  const provider = String(providerId || "").trim();
  const model = String(modelUsed || "").trim();
  if (!provider && !model) return "";
  return `[llmproxy] provider: ${provider || "unknown"} | model: ${model || "unknown"}`;
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

function buildInferenceFooter(usageStats = null, smartRouteInfo = null) {
  if (!isMeteringInlineEnabled()) return "";
  const requestTotal = Number(usageStats?.requestTotalTokens || 0);
  const requestInput = Number(usageStats?.requestInputTokens || 0);
  const requestOutput = Number(usageStats?.requestOutputTokens || 0);
  const providerToday = Number(usageStats?.providerTodayTokens || 0);
  const providerWeek = Number(usageStats?.providerWeekTokens || 0);
  const modelToday = Number(usageStats?.modelTodayTokens || 0);
  const modelWeek = Number(usageStats?.modelWeekTokens || 0);
  const hasUsage = usageStats || requestTotal || providerToday || providerWeek || modelToday || modelWeek;
  const hasSmart = smartRouteInfo && (smartRouteInfo.tier || smartRouteInfo.alertMessage);
  if (!hasUsage && !hasSmart) return "";

  let footer = "";
  if (hasUsage) {
    footer += `\n\n[llmproxy] tokens: req ${requestTotal} (in ${requestInput}, out ${requestOutput}) | provider today ${providerToday} week ${providerWeek} | model today ${modelToday} week ${modelWeek}`;
  }
  if (smartRouteInfo) {
    if (smartRouteInfo.tier) {
      footer += ` | smart-route: ${smartRouteInfo.tier} via ${smartRouteInfo.method}`;
    }
    if (smartRouteInfo.alertMessage) {
      footer += ` | [!] ${smartRouteInfo.alertMessage}`;
    }
  }
  return footer;
}

function buildUsageStats(logger, promptTokens, completionTokens, providerId, modelUsed) {
  const requestInputTokens = Number(promptTokens || 0);
  const requestOutputTokens = Number(completionTokens || 0);
  const requestTotalTokens = requestInputTokens + requestOutputTokens;
  const providerHistorical = logger && typeof logger.getUsageTotals === "function" && providerId
    ? logger.getUsageTotals({ provider: providerId })
    : { todayTokens: 0, weekTokens: 0 };
  const modelHistorical = logger && typeof logger.getUsageTotals === "function" && modelUsed
    ? logger.getUsageTotals({ model: modelUsed })
    : { todayTokens: 0, weekTokens: 0 };
  return {
    requestInputTokens,
    requestOutputTokens,
    requestTotalTokens,
    providerTodayTokens: Number(providerHistorical.todayTokens || 0) + requestTotalTokens,
    providerWeekTokens: Number(providerHistorical.weekTokens || 0) + requestTotalTokens,
    modelTodayTokens: Number(modelHistorical.todayTokens || 0) + requestTotalTokens,
    modelWeekTokens: Number(modelHistorical.weekTokens || 0) + requestTotalTokens,
  };
}

function appendInferenceMetadataToMessage(message, providerId, modelUsed, usageStats = null, smartRouteInfo = null) {
  if (!message || message.stop_reason === "tool_use") return message;
  const header = buildInferenceHeader(providerId, modelUsed);
  const footer = buildInferenceFooter(usageStats, smartRouteInfo);
  if (!header && !footer) return message;
  const content = Array.isArray(message.content)
    ? message.content.map((block) => {
        if (!block || typeof block !== "object" || block.type !== "text") return block;
        return {
          ...block,
          text: stripInferenceMetadataFromText(block.text),
        };
      })
    : [];
  let firstTextIndex = -1;
  let lastTextIndex = -1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index]?.type !== "text") continue;
    if (firstTextIndex === -1) firstTextIndex = index;
    lastTextIndex = index;
  }
  if (firstTextIndex === -1) {
    const text = `${header ? `${header}\n\n` : ""}${footer ? footer.trimStart() : ""}`;
    if (text) content.push({ type: "text", text });
  } else {
    if (header) {
      content[firstTextIndex] = {
        ...content[firstTextIndex],
        text: `${header}\n\n${String(content[firstTextIndex].text || "")}`,
      };
    }
    if (footer) {
      content[lastTextIndex] = {
        ...content[lastTextIndex],
        text: `${String(content[lastTextIndex].text || "")}${footer}`,
      };
    }
  }
  // Preserva reasoning_content se presente (per modelli come Kimi, DeepSeek R1, ecc.)
  const result = { ...message, content };
  if (message.reasoning_content !== undefined) {
    result.reasoning_content = message.reasoning_content;
  }
  return result;
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
    return { inputTokens: 0, outputTokens: 0 };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let maxContentIndex = -1;
  let prefixSent = false;
  let footerSent = false;
  let inputTokens = 0;
  let outputTokens = 0;

  const maybeSendFooter = (stopReason) => {
    const footer = buildInferenceFooter(
      buildUsageStats(options.logger, inputTokens, outputTokens, options.providerId, options.modelUsed),
      options.smartRouteInfo || null,
    );
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
      if (payload?.content_block?.type === "text" && !prefixSent) {
        sendSse(res, eventName, payload);
        const header = buildInferenceHeader(options.providerId, options.modelUsed);
        if (header) {
          sendSse(res, "content_block_delta", {
            type: "content_block_delta",
            index: payload.index,
            delta: { type: "text_delta", text: `${header}\n\n` },
          });
        }
        prefixSent = true;
        return;
      }
    }
    if (eventName === "content_block_delta" && payload?.delta?.type === "text_delta") {
      const sanitizedText = stripInferenceMetadataFromDeltaText(payload?.delta?.text);
      if (!sanitizedText) return;
      payload = {
        ...payload,
        delta: {
          ...payload.delta,
          text: sanitizedText,
        },
      };
    }
    if (eventName === "message_delta") {
      if (payload?.usage) {
        inputTokens = Number(payload.usage.input_tokens || inputTokens);
        outputTokens = Number(payload.usage.output_tokens || outputTokens);
      }
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
  return { inputTokens, outputTokens };
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
  let prefixSent = false;

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

      if (!actualModel && chunk.model) actualModel = String(chunk.model);
      if (chunk.usage) {
        const usageCounts = extractUsageTokenCounts(chunk.usage);
        inputTokens = usageCounts.inputTokens || inputTokens;
        outputTokens = usageCounts.outputTokens || outputTokens;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;
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
        const sanitizedContent = stripInferenceMetadataFromDeltaText(delta.content);
        if (!sanitizedContent) continue;
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
          const header = buildInferenceHeader(options.providerId, actualModel || responseModel);
          if (header && !prefixSent) {
            sendSse(res, "content_block_delta", {
              type: "content_block_delta",
              index: textBlockIndex,
              delta: { type: "text_delta", text: `${header}\n\n` },
            });
            prefixSent = true;
          }
        }
        sendSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: sanitizedContent },
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
  const footer = buildInferenceFooter(
    buildUsageStats(options.logger, inputTokens, outputTokens, options.providerId, actualModel || responseModel),
    options.smartRouteInfo || null,
  );
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
    providerCandidates,
    smartRouteInfo = null,
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

  function logRequestSummary(payload = {}) {
    if (!logger || typeof logger.logRequestSummary !== "function") return;
    const promptTokens = typeof payload.promptTokens === "number" ? payload.promptTokens : null;
    const completionTokens = typeof payload.completionTokens === "number" ? payload.completionTokens : null;
    logger.logRequestSummary({
      requestId,
      traceId,
      projectName,
      configuredModel,
      requestedModel: requestModel,
      success: payload.success === true,
      finalProvider: payload.finalProvider || null,
      finalModel: payload.finalModel || null,
      finalStatus: typeof payload.finalStatus === "number" ? payload.finalStatus : null,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens != null || completionTokens != null
        ? Number(promptTokens || 0) + Number(completionTokens || 0)
        : null,
      providerAttempts,
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

  let providers = buildProviderCandidates(tokenStore, providerCandidates);
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
          : "Nessun provider autenticato. Esegui `llmproxy provider:add copilot` o configura un provider API-key.",
      },
    });
    return;
  }

  const openaiBody = translateRequest(anthropicBody);
  const requestModel = String(configuredModel || anthropicBody.model || "").trim();
  const clientProvidedModel = Boolean(configuredModel || anthropicBody.model);
  const requestedMappedModel = clientProvidedModel ? openaiBody.model : "";
  const hasApiKeyProviderForRequestedModel = providers.some((provider) => providerSupportsRequestedModel(provider, requestedMappedModel));
  const hasProviderModelPreferences = parseProviderModelPreferences(requestModel).some((preference) => preference.provider);
  const hasImages = hasImageInOpenAiMessages(openaiBody.messages || []);
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const providerKind = getProviderKind(provider);
    if (hasImages) {
      const explicitVision = provider.vision;
      let providerSupportsVision;
      if (explicitVision !== undefined && explicitVision !== null) {
        providerSupportsVision = explicitVision;
      } else if (provider.default_model) {
        providerSupportsVision = isVisionCapableModel(provider.default_model, providerKind);
      } else {
        providerSupportsVision = VISION_CAPABLE_PROVIDERS.has(providerKind);
      }
      if (!providerSupportsVision) {
        logger.logProviderAttempt?.({
          requestId,
          projectName,
          configuredModel,
          provider: provider.id,
          endpoint: "skipped",
          requestedModel: requestModel,
          effectiveModel: provider.default_model || "",
          fallbackModel: true,
          skippedReason: "no_vision_support",
        });
        continue;
      }
    }
    const apiKeyProviderConfig = API_KEY_PROVIDER_CONFIGS[providerKind] || null;
    const headers = providerKind === "copilot"
      ? buildCopilotHeaders(provider.access_token)
      : apiKeyProviderConfig?.protocol === "anthropic-messages"
        ? buildAnthropicHeaders(provider.access_token)
        : buildApiKeyProviderHeaders(provider.access_token);
    const apiKeyProviderUrls = apiKeyProviderConfig
      ? getApiKeyProviderRequestUrls(provider, provider.access_token)
      : [];
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
      const isKimiModel = /kimi/i.test(String(targetModel || ""));
      let rawOpenaiBody = ((providerKind === "kimi" || isKimiModel) && openaiBody.tools?.length)
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
      if (rawOpenaiBody.messages?.length) {
        rawOpenaiBody = { ...rawOpenaiBody, messages: sanitizeInferenceMetadataInMessages(rawOpenaiBody.messages) };
      }
      const explicitVision = provider.vision;
      const modelSupportsVision = explicitVision !== undefined && explicitVision !== null
        ? explicitVision
        : isVisionCapableModel(targetModel, providerKind);
      if (!modelSupportsVision && rawOpenaiBody.messages?.length && hasImageInOpenAiMessages(rawOpenaiBody.messages)) {
        rawOpenaiBody = { ...rawOpenaiBody, messages: sanitizeVisionContent(rawOpenaiBody.messages) };
      }
      let providerOpenaiBody = { ...rawOpenaiBody, model: targetModel };
      let providerAnthropicBody = { ...anthropicBody, model: targetModel };
      if (providerAnthropicBody.messages?.length) {
        providerAnthropicBody = {
          ...providerAnthropicBody,
          messages: sanitizeInferenceMetadataInMessages(providerAnthropicBody.messages),
        };
      }
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
      let apiKeyProviderUrlIndex = 0;
      let switched = false;

      while (true) {
        const activeApiKeyProviderUrl = apiKeyProviderConfig
          ? (apiKeyProviderUrls[apiKeyProviderUrlIndex] || apiKeyProviderConfig.messagesUrl || apiKeyProviderConfig.chatCompletionsUrl)
          : null;
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
              return fetchFn(activeApiKeyProviderUrl, {
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

          if (apiKeyProviderConfig && apiKeyProviderUrlIndex < apiKeyProviderUrls.length - 1) {
            apiKeyProviderUrlIndex += 1;
            continue;
          }

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
          logRequestSummary({
            success: false,
            finalProvider: provider.id,
            finalModel: targetModel,
            finalStatus: response.status,
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
            const anthropicStreamingResult = await relayAnthropicStreamWithFooter(response, res, {
              providerId: provider.id,
              modelUsed: targetModel,
              logger,
              smartRouteInfo,
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
              promptTokens: anthropicStreamingResult?.inputTokens,
              completionTokens: anthropicStreamingResult?.outputTokens,
            });
            logRequestSummary({
              success: true,
              finalProvider: provider.id,
              finalModel: targetModel,
              finalStatus: response.status,
              promptTokens: anthropicStreamingResult?.inputTokens,
              completionTokens: anthropicStreamingResult?.outputTokens,
            });
          } else {
            const payload = await response.json();
            const promptTokens = payload?.usage?.input_tokens;
            const completionTokens = payload?.usage?.output_tokens;
            res.json(
              appendInferenceMetadataToMessage(
                payload,
                provider.id,
                payload?.model || targetModel,
                buildUsageStats(logger, promptTokens, completionTokens, provider.id, payload?.model || targetModel),
                smartRouteInfo,
              ),
            );
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
            logRequestSummary({
              success: true,
              finalProvider: provider.id,
              finalModel: payload?.model || targetModel,
              finalStatus: response.status,
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
              appendInferenceMetadataToMessage(
                translated,
                provider.id,
                payload?.model || targetModel,
                buildUsageStats(logger, promptTokens, completionTokens, provider.id, payload?.model || targetModel),
                smartRouteInfo,
              ),
            );
          } else {
            res.json(
              appendInferenceMetadataToMessage(
                translated,
                provider.id,
                payload?.model || targetModel,
                buildUsageStats(logger, promptTokens, completionTokens, provider.id, payload?.model || targetModel),
                smartRouteInfo,
              ),
            );
          }
          await emitRequestMetering({
            success: true,
            provider: provider.id,
            endpoint,
            modelUsed: payload?.model || targetModel,
            promptTokens,
            completionTokens,
          });
          logRequestSummary({
            success: true,
            finalProvider: provider.id,
            finalModel: payload?.model || targetModel,
            finalStatus: response.status,
            promptTokens,
            completionTokens,
          });
          return;
        }

        if (anthropicBody.stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          const streamingResult = await handleStreaming(response, res, targetModel, { providerId: provider.id, logger });
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
          logRequestSummary({
            success: true,
            finalProvider: provider.id,
            finalModel: streamingResult.actualModel,
            finalStatus: response.status,
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
        res.json(
          appendInferenceMetadataToMessage(
            translated,
            provider.id,
            payload?.model || targetModel,
            buildUsageStats(logger, promptTokens, completionTokens, provider.id, payload?.model || targetModel),
            smartRouteInfo,
          ),
        );
        await emitRequestMetering({
          success: true,
          provider: provider.id,
          endpoint,
          modelUsed: payload?.model || targetModel,
          promptTokens,
          completionTokens,
        });
        logRequestSummary({
          success: true,
          finalProvider: provider.id,
          finalModel: payload?.model || targetModel,
          finalStatus: response.status,
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
  logRequestSummary({
    success: false,
    finalProvider: providerAttempts[providerAttempts.length - 1]?.provider || null,
    finalModel: providerAttempts[providerAttempts.length - 1]?.actual_model || providerAttempts[providerAttempts.length - 1]?.effective_model || null,
    finalStatus: providerAttempts[providerAttempts.length - 1]?.status ?? null,
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
  getApiKeyProviderRequestUrls,
  normalizeQwenEndpointVariant,
  sanitizeSchemaForMoonshot,
  sanitizeToolsForMoonshot,
  isVisionCapableModel,
  VISION_CAPABLE_PROVIDERS,
  sanitizeVisionContent,
  hasImageInOpenAiMessages,
};
