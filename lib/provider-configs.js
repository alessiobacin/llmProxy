/**
 * Provider configuration constants.
 */

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
  "vercel-ai-gateway": {
    displayName: "Vercel AI Gateway",
    protocol: "openai-chat",
    chatCompletionsUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
  },
};

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

module.exports = { API_KEY_PROVIDER_CONFIGS, VISION_CAPABLE_MODELS, COPILOT_API_URL, QWEN_PAYG_CHAT_COMPLETIONS_URL, QWEN_TOKEN_PLAN_CHAT_COMPLETIONS_URL };
