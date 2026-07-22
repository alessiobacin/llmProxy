"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { getIntelligenceScore } = require("./model-capabilities");

// Intent extraction via cheapest provider
const CLASSIFY_SYSTEM_PROMPT = `Analyze the user's latest message and output a short intent label (1-3 words). Focus on the concrete action or feature the user wants. Examples:

"create a paginated API endpoint for users" → "create api"
"fix the login button alignment" → "fix login"
"add dark mode toggle to settings" → "add dark theme"
"the pagination on users page is broken" → "fix pagination"
"change the color scheme to blue" → "change colors"
"why is the deployment failing" → "debug deploy"
"how do I connect to the database" → "connect db"
"write a unit test for the auth service" → "test auth"
"the login still doesn't work, same error" → "fix login"
"optimize the database query for orders" → "optimize query"

Output ONLY the label, nothing else.`;

function extractKeywordsFingerprint(text) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","has","have","been","some","them","then","this","that","with","from","what","which","when","where","will","would","could","should","about","than","into","over","after","still","just","also","very","your","their","more","much","each","other","such","only","own","same","here","there","been","does","did","get","got","may","might"].includes(w))
    .slice(0, 6);
  const key = [...new Set(words)].sort().join("-");
  return key || "unknown";
}

function resolveIntentStorePath(env = process.env) {
  const home = String(env.LLMPROXY_HOME || env.HOME || os.homedir());
  return path.join(home, "intent-escalation");
}

function readStore(storePath) {
  const file = path.join(storePath, "tracking.json");
  if (!fs.existsSync(file)) return { conversations: {}, defaults: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { conversations: {}, defaults: {} };
  }
}

function writeStore(storePath, data) {
  fs.mkdirSync(storePath, { recursive: true });
  const file = path.join(storePath, "tracking.json");
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

class IntentTracker {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.tokenStore = options.tokenStore || null;
    this.fetchFn = options.fetchFn || null;
    this.storePath = resolveIntentStorePath(this.env);
    this.threshold = parseInt(String(this.env.LLMPROXY_INTENT_ESCALATION || "0"), 10);
    this.gap = parseInt(String(this.env.LLMPROXY_INTENT_ESCALATION_GAP || "8"), 10);
    this.enabled = this.threshold > 0;
  }

  /**
   * Extract intent from user message using cheapest available provider (LLM-based).
   * Falls back to keyword extraction if no provider available or extraction fails.
   */
  async extractIntent(userMessage, options = {}) {
    if (!userMessage || !String(userMessage).trim()) return "unknown";

    const text = String(userMessage).trim().slice(0, 2000);

    // Try LLM-based extraction via cheapest provider
    if (this.enabled && this.tokenStore && this.fetchFn) {
      try {
        const llmIntent = await this._extractViaLLM(text);
        if (llmIntent && llmIntent.length > 0 && llmIntent.length < 30) {
          return llmIntent.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim();
        }
      } catch {
        // Fall through to keyword
      }
    }

    // Fallback: keyword fingerprint
    return extractKeywordsFingerprint(text);
  }

  async _extractViaLLM(text) {
    const providers = this.tokenStore.listProviders && this.tokenStore.listProviders();
    if (!Array.isArray(providers) || providers.length === 0) return null;

    // Find cheapest available provider (first with an access_token)
    let classifierProvider = null;
    for (const p of providers) {
      if (p && p.access_token && !p.disabled) {
        classifierProvider = p;
        break;
      }
    }
    if (!classifierProvider) return null;

    const providerKind = String(classifierProvider.provider || "copilot").toLowerCase();
    let baseUrl = "";
    let modelId = String(classifierProvider.default_model || "").trim();
    let authHeader = "";

    // Resolve provider URL and auth based on provider type
    if (providerKind === "copilot") {
      baseUrl = "https://api.githubcopilot.com/v1/chat/completions";
      authHeader = `Bearer ${classifierProvider.access_token}`;
    } else if (providerKind && typeof providerKind === "string") {
      // For API key providers, use their chat completions URL
      const { API_KEY_PROVIDER_CONFIGS } = require("./copilot-proxy");
      const config = API_KEY_PROVIDER_CONFIGS[providerKind];
      if (!config || !config.chatCompletionsUrl) return null;
      baseUrl = config.chatCompletionsUrl;
      authHeader = `Bearer ${classifierProvider.access_token}`;
    }

    if (!baseUrl) return null;
    if (!modelId) modelId = "deepseek-v4-flash";

    const body = JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      max_tokens: 20,
      temperature: 0,
    });

    const response = await this.fetchFn(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return String(content).trim();
  }

  /**
   * Track intent for a conversation session.
   * Returns: { count, escalated, escalationModel }
   */
  track(intent, currentModel, availableProviders) {
    if (!this.enabled || !intent) return { count: 0, escalated: false, escalationModel: null };

    const store = readStore(this.storePath);
    const convStore = store.conversations;
    const now = Date.now();

    // Find current conversation by matching recent entries
    const entries = Object.entries(convStore);
    const sorted = entries
      .filter(([, v]) => v.lastSeen && now - v.lastSeen < 600000) // 10 min session window
      .sort(([, a], [, b]) => b.lastSeen - a.lastSeen);

    let current;
    if (sorted.length > 0) {
      const key = sorted[0][0];
      current = convStore[key];
      current.conversationId = key;

      if (current.intent === intent) {
        current.count += 1;
        if (current.currentModel !== currentModel) {
          // Model was already escalated externally — keep counting
        }
      } else {
        // Intent changed — reset
        current.intent = intent;
        current.count = 1;
        current.escalated = false;
        current.escalationModel = null;
        current.failedEscalationModels = [];
      }
    } else {
      // New conversation
      const convId = crypto.randomBytes(4).toString("hex");
      current = {
        conversationId: convId,
        intent,
        count: 1,
        currentModel: currentModel || null,
        escalated: false,
        escalationModel: null,
        failedEscalationModels: [],
        lastSeen: now,
        created: now,
      };
      convStore[convId] = current;
    }

    current.lastSeen = now;
    current.currentModel = currentModel || current.currentModel;

    // Check escalation
    let escalationModel = null;
    if (current.count >= this.threshold && !current.escalated && Array.isArray(availableProviders)) {
      escalationModel = this._findEscalationModel(currentModel, availableProviders, current.failedEscalationModels);
      if (escalationModel) {
        current.escalated = true;
        current.escalationModel = escalationModel;
      }
    }

    // Check if current escalated model also exhausted its tries
    if (current.escalated && current.escalationModel && current.count >= this.threshold + 3 && Array.isArray(availableProviders)) {
      const nextEscalation = this._findEscalationModel(
        current.escalationModel,
        availableProviders,
        [...(current.failedEscalationModels || []), current.escalationModel]
      );
      if (nextEscalation) {
        current.failedEscalationModels = [...(current.failedEscalationModels || []), current.escalationModel];
        current.escalationModel = nextEscalation;
        escalationModel = nextEscalation;
      } else {
        // No more models to escalate to — fall back to original
        current.escalated = false;
        current.escalationModel = null;
        escalationModel = null;
      }
    }

    writeStore(this.storePath, store);

    return {
      count: current.count,
      escalated: current.escalated || escalationModel !== null,
      escalationModel,
    };
  }

  _findEscalationModel(currentModel, providers, excludeModels = []) {
    const currentScore = getIntelligenceScore(currentModel);
    if (currentScore == null) return null;

    const excludeSet = new Set(excludeModels.map((m) => String(m).toLowerCase()));

    let bestModel = null;
    let bestScore = Infinity;

    for (const p of providers) {
      if (!p || !p.access_token || p.disabled) continue;
      const modelId = String(p.default_model || "").trim();
      if (!modelId || excludeSet.has(modelId.toLowerCase())) continue;

      const score = getIntelligenceScore(modelId);
      if (score == null) continue;
      if (score >= currentScore + this.gap && score < bestScore) {
        bestModel = modelId;
        bestScore = score;
      }
    }

    return bestModel;
  }

  reset(conversationId) {
    const store = readStore(this.storePath);
    if (conversationId) {
      delete store.conversations[conversationId];
    } else {
      store.conversations = {};
    }
    writeStore(this.storePath, store);
  }
}

function extractLastUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && (msg.role === "user" || msg.role === "human")) {
      const content = msg.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const textBlock = content.find((c) => c && c.type === "text" && c.text);
        if (textBlock) return textBlock.text;
      }
    }
  }
  return null;
}

module.exports = { IntentTracker, extractKeywordsFingerprint, extractLastUserMessage, CLASSIFY_SYSTEM_PROMPT };
