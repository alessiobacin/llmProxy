const { translateRequest, translateResponse, isClaude, resolveSupportedModel } = require("./openai-translate");
const {
  normalizeCopilotTooling,
  shouldUseCopilotResponsesApi,
  shouldUseCopilotChatCompletionsApi,
  translateOpenAiChatBodyToResponsesRequest,
  translateResponsesApiResponseToAnthropic,
} = require("./copilot-responses");
const { buildMeteringRecord, emitMetering } = require("./metering");
const { fetchProviderCreditInfo, createCreditCache } = require("./provider-credit");
const { createProxyStore } = require("./proxy-store");

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
  nvidia: {
    displayName: "NVIDIA",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    defaultModel: "z-ai/glm-5.2",
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

function makeProxyFetch(baseFetch, proxyUrl) {
  if (!proxyUrl) return baseFetch;
  try {
    const undici = require("undici");
    const proxyAgent = proxyUrl ? new undici.ProxyAgent(proxyUrl) : null;
    if (!proxyAgent) return baseFetch;
    return (url, opts = {}) => undici.fetch(url, { ...opts, dispatcher: proxyAgent });
  } catch {
    return baseFetch;
  }
}

let _proxyStoreInstance = null;
function getProxyStore(proxyRegistryPath) {
  if (!_proxyStoreInstance) {
    _proxyStoreInstance = createProxyStore({ filePath: proxyRegistryPath || process.env.LLMPROXY_PROXY_REGISTRY || "" });
  }
  return _proxyStoreInstance;
}

function resolveProviderProxyUrl(provider) {
  // Proxy specifico salvato sul provider
  if (provider.proxy_url) return provider.proxy_url;
  // Rotazione proxy: usa il primo proxy registrato (failover sequenziale)
  if (provider.proxy_rotation) {
    const store = getProxyStore();
    const proxies = store.listProxies();
    if (proxies.length > 0) return proxies[0].url;
  }
  return "";
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

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function prioritizeProvider(providers, preferredProviderId) {
  if (!Array.isArray(providers) || providers.length <= 1) return Array.isArray(providers) ? providers : [];
  const normalizedPreferred = String(preferredProviderId || "").trim().toLowerCase();
  if (!normalizedPreferred) return providers;
  const nextProviders = providers.slice();
  // Match distinct instances first by precise id, then by providerKind — but
  // when multiple instances of the same providerKind exist (e.g. two
  // opencode-bacin/opencode-alessio), each one MUST be tried in its original
  // position before falling back to a different provider kind. Returning only
  // the first kind-match would silently skip the remaining same-kind instances
  // and jump straight to the next provider kind in the chain.
  const preferredIndex = nextProviders.findIndex((provider) => {
    const providerId = String(provider?.id || "").trim().toLowerCase();
    return providerId === normalizedPreferred;
  });
  if (preferredIndex > 0) {
    const [preferred] = nextProviders.splice(preferredIndex, 1);
    nextProviders.unshift(preferred);
    return nextProviders;
  }
  // Fallback: keep original order so multiple same-kind instances are all
  // consumed before any other provider kind is attempted.
  return nextProviders;
}

function normalizeMoonshotRef(refValue) {
  const ref = String(refValue || "").trim();
  if (!ref) return ref;
  // Regardless of the original pointer shape (#/$defs/X, #/definitions/X,
  // #/defs/X, a deeply-nested pointer like #/properties/.../definitions/X,
  // or a bare name like "X"), Moonshot only accepts a flat "#/$defs/<name>"
  // pointer resolved against the schema root. Take the final path segment
  // as the definition name so every shape above converges on the same
  // valid, root-relative reference.
  const segments = ref.split("/").filter((segment) => segment.length > 0 && segment !== "#");
  const basename = segments.length > 0 ? segments[segments.length - 1] : ref;
  return `#/$defs/${basename}`;
}

/**
 * Recursively collects every `definitions`/`defs`/`$defs` map found anywhere
 * in the schema tree into a single flat bucket, keyed by definition name.
 * Moonshot's validator resolves "#/$defs/..." refs against the schema root,
 * so nested definitions (e.g. under `properties.filters.definitions`) must
 * be hoisted to the root — leaving them in place would produce refs that
 * look correct but don't resolve.
 */
function collectNestedMoonshotDefs(schema, bucket) {
  if (Array.isArray(schema)) {
    for (const item of schema) collectNestedMoonshotDefs(item, bucket);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const key of ["definitions", "defs", "$defs"]) {
    const value = schema[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [defKey, defValue] of Object.entries(value)) {
      if (!(defKey in bucket)) bucket[defKey] = defValue;
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "definitions" || key === "defs" || key === "$defs") continue;
    if (value && typeof value === "object") collectNestedMoonshotDefs(value, bucket);
  }
}

/**
 * Moonshot (Kimi) JSON Schema validator is strict:
 * - it rejects objects that have both `$ref` and sibling keywords
 * - it expects internal references under `#/$defs/...`, resolved against
 *   the schema root (not wherever the original `definitions` happened to live)
 */
function rewriteMoonshotSchemaNode(schema) {
  if (Array.isArray(schema)) {
    return schema.map(rewriteMoonshotSchemaNode);
  }
  if (!schema || typeof schema !== "object") return schema;
  if ("$ref" in schema) {
    return { $ref: normalizeMoonshotRef(schema["$ref"]) };
  }

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    // Nested definitions/defs/$defs maps are dropped here; they get hoisted
    // once to the true root by sanitizeSchemaForMoonshot below.
    if (key === "definitions" || key === "defs" || key === "$defs") continue;
    result[key] = (value && typeof value === "object") ? rewriteMoonshotSchemaNode(value) : value;
  }
  return result;
}

function sanitizeSchemaForMoonshot(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForMoonshot);
  }
  if (!schema || typeof schema !== "object") return schema;

  const defsBucket = {};
  collectNestedMoonshotDefs(schema, defsBucket);
  const rewritten = rewriteMoonshotSchemaNode(schema);
  if (Object.keys(defsBucket).length > 0) {
    rewritten.$defs = Object.fromEntries(
      Object.entries(defsBucket).map(([defKey, defValue]) => [defKey, rewriteMoonshotSchemaNode(defValue)])
    );
  }
  return rewritten;
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
  nvidia: () => false, // NVIDIA model support varies; stay conservative by default
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

const MINIMAX_STREAM_MARKER_REGEX = /\]<(?:\|minimax\|>|\]minimax\[>)\[/g;
const MINIMAX_TOOL_BLOCK_START_REGEX = /<tool_call>|<invoke\b[^>]*name=/i;
const MINIMAX_TOOL_PREFIX_WINDOW = 32;
let syntheticToolUseCounter = 0;

function nextSyntheticToolUseId(name) {
  syntheticToolUseCounter += 1;
  const suffix = String(name || "tool").replace(/[^a-z0-9_-]/gi, "").slice(0, 12).toLowerCase() || "tool";
  return `toolu_${Date.now().toString(36)}_${syntheticToolUseCounter.toString(36)}_${suffix}`;
}

function parseXmlishAttributes(rawAttrs) {
  const attrs = {};
  const attrRegex = /([A-Za-z][\w-]*)="([^"]*)"/g;
  let match;
  while ((match = attrRegex.exec(String(rawAttrs || ""))) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function findMatchingXmlishCloseTag(source, tagName, startIndex) {
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let cursor = startIndex;
  while (depth > 0) {
    const nextClose = source.indexOf(closeTag, cursor);
    if (nextClose === -1) return -1;
    const nextOpen = source.indexOf(`<${tagName}`, cursor);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const boundaryChar = source[nextOpen + tagName.length + 1] || "";
      if (boundaryChar === ">" || /\s/.test(boundaryChar)) {
        depth += 1;
        cursor = nextOpen + tagName.length + 1;
        continue;
      }
    }
    depth -= 1;
    cursor = nextClose + closeTag.length;
  }
  return cursor;
}

function parseXmlishChildren(source) {
  const input = String(source || "").trim();
  if (!input) return [];

  const nodes = [];
  let cursor = 0;
  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor] || "")) cursor += 1;
    if (cursor >= input.length) break;
    if (input[cursor] !== "<" || input[cursor + 1] === "/") return null;

    const openEnd = input.indexOf(">", cursor);
    if (openEnd === -1) return null;

    const openTagBody = input.slice(cursor + 1, openEnd).trim();
    const separatorIndex = openTagBody.search(/\s/);
    const tagName = separatorIndex === -1 ? openTagBody : openTagBody.slice(0, separatorIndex);
    if (!/^[A-Za-z][\w-]*$/.test(tagName)) return null;

    const rawAttrs = separatorIndex === -1 ? "" : openTagBody.slice(separatorIndex + 1);
    const closeEnd = findMatchingXmlishCloseTag(input, tagName, openEnd + 1);
    if (closeEnd === -1) return null;

    const closeTag = `</${tagName}>`;
    const innerEnd = closeEnd - closeTag.length;
    nodes.push({
      name: tagName,
      attrs: parseXmlishAttributes(rawAttrs),
      inner: input.slice(openEnd + 1, innerEnd),
    });
    cursor = closeEnd;
  }

  return nodes;
}

function xmlishNodeToValue(node) {
  const children = parseXmlishChildren(node.inner);
  if (!children || children.length === 0) return String(node.inner || "").trim();
  if (children.every((child) => child.name === "item")) {
    return children.map((child) => xmlishNodeToValue(child));
  }

  const result = {};
  for (const child of children) {
    const value = xmlishNodeToValue(child);
    if (result[child.name] === undefined) {
      result[child.name] = value;
      continue;
    }
    if (Array.isArray(result[child.name])) {
      result[child.name].push(value);
      continue;
    }
    result[child.name] = [result[child.name], value];
  }
  return result;
}

function normalizeMinimaxToolMarkup(rawText) {
  return String(rawText || "")
    .replace(MINIMAX_STREAM_MARKER_REGEX, "")
    .replace(/^\s*<tool_call>\s*/i, "")
    .replace(/\s*<\/tool_call>\s*$/i, "")
    .trim();
}

function parseMinimaxToolCallBlock(rawText) {
  const normalized = normalizeMinimaxToolMarkup(rawText);
  if (!normalized || !/<invoke\b[^>]*name=/i.test(normalized)) return null;
  const nodes = parseXmlishChildren(normalized);
  if (!nodes || nodes.length === 0) return null;

  const toolUses = [];
  for (const node of nodes) {
    if (node.name !== "invoke") continue;
    const name = String(node.attrs.name || "").trim();
    if (!name) continue;
    const children = parseXmlishChildren(node.inner);
    const value = !children || children.length === 0
      ? {}
      : xmlishNodeToValue({ name: "input", attrs: {}, inner: node.inner });
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { value };
    toolUses.push({
      id: nextSyntheticToolUseId(name),
      name,
      input,
    });
  }

  return toolUses.length > 0 ? toolUses : null;
}

function consumeMinimaxToolCallBuffer(buffer, options = {}) {
  const flush = Boolean(options.flush);
  const events = [];
  let remaining = String(buffer || "");

  while (remaining.length > 0) {
    const match = remaining.match(MINIMAX_TOOL_BLOCK_START_REGEX);
    if (!match || match.index === undefined) {
      if (flush) {
        if (remaining) events.push({ type: "text", text: remaining });
        remaining = "";
      } else {
        const safeLength = Math.max(0, remaining.length - MINIMAX_TOOL_PREFIX_WINDOW);
        if (safeLength > 0) {
          events.push({ type: "text", text: remaining.slice(0, safeLength) });
          remaining = remaining.slice(safeLength);
        }
      }
      break;
    }

    if (match.index > 0) {
      events.push({ type: "text", text: remaining.slice(0, match.index) });
      remaining = remaining.slice(match.index);
      continue;
    }

    const closingTag = remaining.startsWith("<tool_call>") ? "</tool_call>" : "</invoke>";
    const blockEnd = remaining.indexOf(closingTag);
    if (blockEnd === -1) break;

    const rawBlock = remaining.slice(0, blockEnd + closingTag.length);
    const toolUses = parseMinimaxToolCallBlock(rawBlock);
    if (!toolUses) {
      events.push({ type: "text", text: rawBlock });
    } else {
      for (const toolUse of toolUses) {
        events.push({ type: "tool_use", toolUse });
      }
    }
    remaining = remaining.slice(blockEnd + closingTag.length);
  }

  return {
    events: events.filter((event) => event.type !== "text" || event.text),
    remainder: remaining,
  };
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

function hasImageInLastUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user") return false;
  return Array.isArray(lastMsg.content) && lastMsg.content.some((block) => block?.type === "image_url");
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

async function probeApiKeyProviderModel({ provider, apiKey, model, fetchFn = fetch, proxyUrl }) {
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
  const probeFetch = makeProxyFetch(fetchFn, proxyUrl || "");
  let lastFailure = { ok: false, status: 0, error: "request_failed" };

  for (const url of urls) {
    let response;
    try {
      response = await probeFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastFailure = { ok: false, status: 0, error: error.message };
      continue;
    }

    if (response.ok || response.status === 429 || response.status === 402) return { ok: true, status: response.status };
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
        const shorthandModel = entry.slice(matchedProvider.length + 1).trim();
        return {
          provider: matchedProvider,
          model: matchedProvider === "nvidia" && /^glm-/i.test(shorthandModel)
            ? `z-ai/${shorthandModel}`
            : shorthandModel,
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

function isMeteringInlineEnabled(override = null) {
  if (typeof override === "boolean") return override;
  const raw = String(process.env.LLMPROXY_METERING_INLINE || "").trim();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  if (raw === "true" || raw === "1") return true;
  const creditRaw = String(process.env.LLMPROXY_PROVIDER_CREDIT_INLINE || "").trim();
  // Credit-only intent should NOT enable the full metering footer.
  return false;
}

function isCreditInlineEnabled(override = null) {
  if (typeof override === "boolean") return override;
  const raw = String(process.env.LLMPROXY_PROVIDER_CREDIT_INLINE || "").trim();
  return raw === "true" || raw === "1";
}

function isInferenceInfoInlineEnabled(override = null) {
  if (typeof override === "boolean") return override;
  const raw = String(process.env.LLMPROXY_INFERENCE_INFO_INLINE || "").trim();
  return raw === "true" || raw === "1";
}

function buildInferenceHeader(providerId, modelUsed, inlineInferenceInfo = null, selectionReason = null, proxyUrl) {
  if (!isInferenceInfoInlineEnabled(inlineInferenceInfo)) return "";
  const provider = String(providerId || "").trim();
  const model = String(modelUsed || "").trim();
  if (!provider && !model) return "";
  let header = `[llmproxy] provider: ${provider || "unknown"} | model: ${model || "unknown"}`;
  const proxyLabel = proxyUrl ? ` | proxy: ${new URL(proxyUrl).hostname}` : "";
  header += proxyLabel;
  if (selectionReason) {
    header += ` : ${selectionReason}`;
  }
  return header;
}

function buildSelectionReason(providerAttempts, finalProvider, finalModel, preferredReason = null, hasImages = false) {
  const defaultReason = hasImages
    ? "First in order from provider list WITH VISION"
    : "First in order from provider list";
  if (!Array.isArray(providerAttempts) || providerAttempts.length === 0) {
    return preferredReason || defaultReason;
  }
  // Trova i tentativi falliti che hanno coinvolto provider diversi da quello finale
  const failedAttempts = providerAttempts.filter(
    (a) => a.success === false && a.provider !== finalProvider && a.provider,
  );
  // Se non ci sono fallimenti di altri provider, controlla fallimenti dello stesso provider con modelli diversi
  const failedModelAttempts = providerAttempts.filter(
    (a) => a.success === false && a.provider === finalProvider && a.effective_model !== finalModel && a.effective_model,
  );
  // Unisci e deduplica per (provider + effective_model)
  const seen = new Set();
  const allFailures = [];
  for (const a of [...failedAttempts, ...failedModelAttempts]) {
    const key = `${a.provider}:${a.effective_model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allFailures.push(a);
  }
  if (allFailures.length === 0) return preferredReason || defaultReason;

  const ordinalMap = ["First", "Second", "Third", "Fourth", "Fifth"];
  // Conta i provider unici falliti (per calcolare l'ordinale del provider corrente)
  const uniqueFailedProviderKeys = new Set(allFailures.map((a) => a.provider));
  const failedProviderCount = uniqueFailedProviderKeys.size;
  const ordinal = ordinalMap[failedProviderCount] || `${failedProviderCount + 1}th`;

  // Il primo fallimento spiega il motivo
  const firstFail = allFailures[0];
  let reason = `${ordinal} in order`;
  if (firstFail.effective_model) {
    reason += ` because ${firstFail.effective_model}`;
    if (firstFail.provider && firstFail.provider !== finalProvider) {
      reason += ` (${firstFail.provider})`;
    }
    if (firstFail.status) {
      reason += ` is returning: ${firstFail.status}`;
    } else if (firstFail.error) {
      reason += ` is returning: ${firstFail.error.slice(0, 80)}`;
    }
  } else if (firstFail.provider) {
    reason += ` because ${firstFail.provider} is returning: ${firstFail.status || firstFail.error || "unknown error"}`;
  } else if (firstFail.effective_model) {
    reason += ` because ${firstFail.effective_model} is returning: ${firstFail.status || firstFail.error || "unknown error"}`;
  }
  return reason;
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

function buildInferenceFooter(opts = {}) {
  const {
    usageStats = null,
    inlineMetering = null,
    creditInfo = null,
    inlineCredit = null,
    inferenceProviderId = null,
    inferenceModelName = null,
  } = opts;
  const meteringEnabled = isMeteringInlineEnabled(inlineMetering);
  const creditEnabled = isCreditInlineEnabled(inlineCredit);
  if (!meteringEnabled && !creditEnabled) return "";

  const requestInput = Number(usageStats?.requestInputTokens || 0);
  const requestOutput = Number(usageStats?.requestOutputTokens || 0);
  const modelBreakdown = usageStats?.modelBreakdown || { today: {}, week: {} };

  // Combined format per-model: "{provider}/{model} (in: X/d, out: Y/d - in: Z/w, out: W/w)"
  function formatModelStats(todayInfo, weekInfo) {
    const allModels = new Set([
      ...Object.keys(todayInfo || {}),
      ...Object.keys(weekInfo || {}),
    ]);
    if (allModels.size === 0) return "";
    const providerLabel = inferenceProviderId ? `${inferenceProviderId}/` : "";
    return Array.from(allModels)
      .map(model => {
        const today = todayInfo?.[model] || { inputTokens: 0, outputTokens: 0 };
        const week = weekInfo?.[model] || { inputTokens: 0, outputTokens: 0 };
        const wkIn = Math.max(0, Number(week.inputTokens || 0) - Number(today.inputTokens || 0));
        const wkOut = Math.max(0, Number(week.outputTokens || 0) - Number(today.outputTokens || 0));
        const total = today.inputTokens + today.outputTokens + wkIn + wkOut;
        return { model, total, today, wkIn, wkOut };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 2)
      .map(({ model, today, wkIn, wkOut }) =>
        `${providerLabel}${model} (in: ${today.inputTokens}/d, out: ${today.outputTokens}/d - in: ${wkIn}/w, out: ${wkOut}/w)`
      )
      .join(" | ");
  }

  const modelLine = formatModelStats(modelBreakdown.today, modelBreakdown.week);

  const creditLabel = creditInfo?.label ? String(creditInfo.label).trim() : "n/a";
  const showCredit = creditEnabled;
  const showMeter = meteringEnabled;

  const parts = [];
  if (showMeter) {
    if (inferenceProviderId || inferenceModelName) {
      const tag = inferenceProviderId && inferenceModelName
        ? `${inferenceProviderId}/${inferenceModelName}`
        : (inferenceProviderId || inferenceModelName);
      parts.push(`${tag} (req ${requestInput + requestOutput}, in ${requestInput}, out ${requestOutput})`);
    } else {
      parts.push(`req ${requestInput + requestOutput} (in ${requestInput}, out ${requestOutput})`);
    }
    if (modelLine) parts.push(modelLine);
  }
  if (showCredit) {
    parts.push(`credito residuo: ${creditLabel}`);
  }
  if (!parts.length) return "";
  return `\n\n[llmproxy] ${parts.join(" | ")}`;
}

function buildUsageStats(logger, promptTokens, completionTokens, providerId, modelUsed) {
  const requestInputTokens = Number(promptTokens || 0);
  const requestOutputTokens = Number(completionTokens || 0);
  const requestTotalTokens = requestInputTokens + requestOutputTokens;
  const modelBreakdown = logger && typeof logger.getModelBreakdownTotals === "function"
    ? logger.getModelBreakdownTotals()
    : { today: {}, week: {} };
  // Add current request tokens to the breakdown for the model being used
  if (modelUsed) {
    modelBreakdown.today[modelUsed] = modelBreakdown.today[modelUsed] || { inputTokens: 0, outputTokens: 0 };
    modelBreakdown.today[modelUsed].inputTokens += requestInputTokens;
    modelBreakdown.today[modelUsed].outputTokens += requestOutputTokens;
    modelBreakdown.week[modelUsed] = modelBreakdown.week[modelUsed] || { inputTokens: 0, outputTokens: 0 };
    modelBreakdown.week[modelUsed].inputTokens += requestInputTokens;
    modelBreakdown.week[modelUsed].outputTokens += requestOutputTokens;
  }
  return {
    requestInputTokens,
    requestOutputTokens,
    requestTotalTokens,
    modelBreakdown,
  };
}

function appendInferenceMetadataToMessage(
  message,
  providerId,
  modelUsed,
  usageStats = null,
  inlineMetering = null,
  inlineInferenceInfo = null,
  selectionReason = null,
  creditInfo = null,
  inlineCredit = null,
) {
  if (!message) return message;
  const header = buildInferenceHeader(providerId, modelUsed, inlineInferenceInfo, selectionReason);
  const footer = buildInferenceFooter({
    usageStats,

    inlineMetering,
    creditInfo,
    inlineCredit,
    inferenceProviderId: providerId,
    inferenceModelName: modelUsed,
  });
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
    if (header) content.unshift({ type: "text", text: header });
    if (footer) content.push({ type: "text", text: footer.trimStart() });
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
  const { proxyUrl: streamProxyUrl } = options;
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
  let indexOffset = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const maybeSendFooter = (stopReason) => {
    const footer = buildInferenceFooter({
      usageStats: buildUsageStats(options.logger, inputTokens, outputTokens, options.providerId, options.modelUsed),
      inlineMetering: options.inlineMetering,
      creditInfo: options.creditInfo || null,
      inferenceProviderId: options.providerId,
      inferenceModelName: options.modelUsed,
    });
    if (footerSent || !footer) return;
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
      if (payload?.content_block?.type === "text" && !prefixSent) {
        maxContentIndex = Math.max(maxContentIndex, payload.index + indexOffset);
        sendSse(res, eventName, payload);
        const header = buildInferenceHeader(options.providerId, options.modelUsed, options.inlineInferenceInfo, options.selectionReason);
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
      const header = buildInferenceHeader(options.providerId, options.modelUsed, options.inlineInferenceInfo, options.selectionReason);
      if (!prefixSent && header) {
        sendSse(res, "content_block_start", {
          type: "content_block_start",
          index: payload.index,
          content_block: { type: "text", text: "" },
        });
        sendSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: payload.index,
          delta: { type: "text_delta", text: header },
        });
        sendSse(res, "content_block_stop", {
          type: "content_block_stop",
          index: payload.index,
        });
        indexOffset = 1;
        prefixSent = true;
      }
    }
    if (Number.isInteger(payload?.index) && indexOffset > 0) {
      payload = {
        ...payload,
        index: payload.index + indexOffset,
      };
    }
    if (eventName === "content_block_start" && Number.isInteger(payload?.index)) {
      maxContentIndex = Math.max(maxContentIndex, payload.index);
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
  const { proxyUrl: streamProxyUrl } = options;
  const decoder = new TextDecoder();
  const reader = fetchResponse.body.getReader();
  let buffer = "";
  let structuredTextBuffer = "";
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

  const closeTextBlock = () => {
    if (textBlockIndex === -1) return;
    sendSse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    textBlockIndex = -1;
  };

  const closeThinkingBlock = () => {
    if (thinkingBlockIndex === -1) return;
    sendSse(res, "content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
    thinkingBlockIndex = -1;
  };

  const emitStandaloneHeader = () => {
    const header = buildInferenceHeader(options.providerId, actualModel || responseModel, options.inlineInferenceInfo, options.selectionReason, streamProxyUrl);
    if (!header || prefixSent) return;
    const headerIndex = nextBlockIndex++;
    sendSse(res, "content_block_start", {
      type: "content_block_start",
      index: headerIndex,
      content_block: { type: "text", text: "" },
    });
    sendSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: headerIndex,
      delta: { type: "text_delta", text: header },
    });
    sendSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: headerIndex,
    });
    prefixSent = true;
  };

  const emitTextChunk = (text) => {
    if (!text) return;
    closeThinkingBlock();
    if (textBlockIndex === -1) {
      textBlockIndex = nextBlockIndex++;
      sendSse(res, "content_block_start", {
        type: "content_block_start",
        index: textBlockIndex,
        content_block: { type: "text", text: "" },
      });
      const header = buildInferenceHeader(options.providerId, actualModel || responseModel, options.inlineInferenceInfo, options.selectionReason);
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
      delta: { type: "text_delta", text },
    });
  };

  const emitToolUse = (toolUse) => {
    emitStandaloneHeader();
    closeTextBlock();
    closeThinkingBlock();
    stopReason = "tool_use";
    const blockIndex = nextBlockIndex++;
    sendSse(res, "content_block_start", {
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUse.id,
        name: toolUse.name || "tool",
        input: {},
      },
    });
    sendSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input || {}) },
    });
    sendSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
  };

  const flushStructuredTextBuffer = (flush = false) => {
    if (!structuredTextBuffer) return;
    const parsed = consumeMinimaxToolCallBuffer(structuredTextBuffer, { flush });
    structuredTextBuffer = parsed.remainder;
    for (const event of parsed.events) {
      if (event.type === "text") {
        emitTextChunk(event.text);
        continue;
      }
      emitToolUse(event.toolUse);
    }
  };

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
      if (choice.finish_reason) {
        const resolvedStopReason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
        if (stopReason !== "tool_use" || resolvedStopReason === "tool_use") {
          stopReason = resolvedStopReason;
        }
      }

      if (delta.reasoning_content) {
        flushStructuredTextBuffer(true);
        emitStandaloneHeader();
        closeTextBlock();
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
        structuredTextBuffer += sanitizedContent;
        flushStructuredTextBuffer(false);
      }

      flushStructuredTextBuffer(true);
      for (const toolCall of delta.tool_calls || []) {
        emitStandaloneHeader();
        closeTextBlock();
        closeThinkingBlock();

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

  flushStructuredTextBuffer(true);
  closeThinkingBlock();
  closeTextBlock();
  for (const index of toolCalls.values()) {
    sendSse(res, "content_block_stop", { type: "content_block_stop", index });
  }
  const footer = buildInferenceFooter({
    usageStats: buildUsageStats(options.logger, inputTokens, outputTokens, options.providerId, actualModel || responseModel),
    inlineMetering: options.inlineMetering,
    creditInfo: options.creditInfo || null,
    inferenceProviderId: options.providerId,
    inferenceModelName: actualModel || responseModel,
  });
  if (footer) {
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
    inlineMetering = null,
    inlineInferenceInfo = null,
    creditInline = null,
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

  const creditCache = createCreditCache();
  const creditEnabled = isCreditInlineEnabled(creditInline);
  if (creditEnabled) {
    for (const provider of providers) {
      fetchProviderCreditInfo(provider, fetchFn, creditCache).catch(() => null);
    }
  }

  async function resolveCreditInfo(provider) {
    if (!creditEnabled || !provider) return null;
    try {
      return await fetchProviderCreditInfo(provider, fetchFn, creditCache);
    } catch {
      return null;
    }
  }

  const openaiBody = translateRequest(anthropicBody);
  const requestModel = String(configuredModel || anthropicBody.model || "").trim();
  const clientProvidedModel = Boolean(configuredModel || anthropicBody.model);
  const requestedMappedModel = clientProvidedModel ? openaiBody.model : "";
  const hasApiKeyProviderForRequestedModel = providers.some((provider) => providerSupportsRequestedModel(provider, requestedMappedModel));
  const hasProviderModelPreferences = parseProviderModelPreferences(requestModel).some((preference) => preference.provider);
  const hasImages = hasImageInLastUserMessage(openaiBody.messages || []);
  let runtimeSelectionReason = null;

  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const providerKind = getProviderKind(provider);
    const providerCreditInfo = await resolveCreditInfo(provider);
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

        const proxyUrl = resolveProviderProxyUrl(provider);
        const providerFetch = makeProxyFetch(fetchFn, proxyUrl);
        let response;
        try {
          response = await fetchWithNetworkRetry(async () => {
            if (apiKeyProviderConfig?.protocol === "anthropic-messages") {
              return providerFetch(apiKeyProviderConfig.messagesUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(providerAnthropicBody),
              });
            }
            if (apiKeyProviderConfig) {
              return providerFetch(activeApiKeyProviderUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(providerOpenaiBody),
              });
            }
            if (endpoint === "responses") {
              return providerFetch(`${COPILOT_API_URL}/responses`, {
                method: "POST",
                headers,
                body: JSON.stringify(translateOpenAiChatBodyToResponsesRequest(providerOpenaiBody)),
              });
            }
            return providerFetch(`${COPILOT_API_URL}/chat/completions`, {
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
          } else if (providerIndex < providers.length - 1 && shouldFallbackToNextProvider(0, error.message)) {
            break;
          } else {
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
          } else if (providerIndex < providers.length - 1 && shouldFallbackToNextProvider(response.status, errorText)) {
            break;
          } else {
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

              inlineMetering,
              inlineInferenceInfo,
              creditInfo: providerCreditInfo,
              selectionReason: buildSelectionReason(providerAttempts, provider.id, targetModel, runtimeSelectionReason, hasImages),
              proxyUrl,
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
            const selectionReason = buildSelectionReason(providerAttempts, provider.id, payload?.model || targetModel, runtimeSelectionReason, hasImages);
            res.json(
              appendInferenceMetadataToMessage(
                payload,
                provider.id,
                payload?.model || targetModel,
                buildUsageStats(logger, promptTokens, completionTokens, provider.id, payload?.model || targetModel),

                inlineMetering,
                inlineInferenceInfo,
                selectionReason,
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
          const selectionReason = buildSelectionReason(providerAttempts, provider.id, payload?.model || targetModel, runtimeSelectionReason, hasImages);
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

                inlineMetering,
                inlineInferenceInfo,
                selectionReason,
              ),
            );
          } else {
            res.json(
              appendInferenceMetadataToMessage(
                translated,
                provider.id,
                payload?.model || targetModel,
                buildUsageStats(logger, promptTokens, completionTokens, provider.id, payload?.model || targetModel),

                inlineMetering,
                inlineInferenceInfo,
                selectionReason,
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
          const streamingResult = await handleStreaming(response, res, targetModel, {
            providerId: provider.id,
            logger,

            inlineMetering,
            inlineInferenceInfo,
            creditInfo: providerCreditInfo,
            selectionReason: buildSelectionReason(providerAttempts, provider.id, targetModel, runtimeSelectionReason, hasImages),
          });
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
        const selectionReason = buildSelectionReason(providerAttempts, provider.id, payload?.model || targetModel, runtimeSelectionReason, hasImages);
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

            inlineMetering,
            inlineInferenceInfo,
            selectionReason,
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
  buildSelectionReason,
  hasImageInOpenAiMessages,
  hasImageInLastUserMessage,
  handleStreaming,
  consumeMinimaxToolCallBuffer,
  makeProxyFetch,
  resolveProviderProxyUrl,
  getProxyStore,
};
