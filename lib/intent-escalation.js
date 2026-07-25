"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { getIntelligenceScore } = require("./model-capabilities");

// Intent extraction via cheapest provider (simple - last message only)
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

// Words that indicate the user is asking to fix/correct/rework the current task,
// NOT starting a new task. Both Italian and English.
const CORRECTION_WORDS = new Set([
  // Italiano
  "non", "funziona", "riparalo", "rifallo", "ricontrolla", "correggi",
  "sbagliato", "errore", "riprova", "revisiona", "aggiusta", "ripara",
  "rifa", "controlla", "riprovare", "rifare", "riparare",
  "ricontrollare", "correggere", "sistemare", "problema", "malfunzionamento",
  "ancora",
  // Inglese
  "not", "working", "doesnt", "dont", "broken", "error", "wrong",
  "incorrect", "fail", "failed", "failure", "fix", "repair", "correct",
  "rework", "redo", "retry", "revise", "debug", "retest", "bug", "rewrite",
  // Generici
  "fixa", "fixare", "refactor",
]);

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

/** Extract plain text from a message content (string or array of blocks). */
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((c) => c && c.type === "text" && c.text);
    return textBlock ? textBlock.text : "";
  }
  return "";
}

/** Format conversation messages for the context-aware prompt. */
function formatConversationForPrompt(messages, maxExchanges = 4) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  // Take the last N user/assistant exchanges
  const relevant = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
      const text = extractTextContent(msg.content).trim();
      if (text) {
        relevant.push({ role: msg.role, text: text.slice(0, 500) });
      }
    }
  }
  // Keep last maxExchanges*2 messages (user+assistant pairs)
  const tail = relevant.slice(-(maxExchanges * 2));
  return tail.map((m) => `${m.role}: ${m.text}`).join("\n");
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
   * Extract intent and continuation flag from user message.
   *
   * @param {string} userMessage - The last user message text.
   * @param {object} [options] - Optional.
   * @param {Array} [options.messages] - Full conversation messages (for context-aware LLM).
   * @returns {Promise<{intent: string, continuation: "same"|"new"|null}>}
   */
  async extractIntent(userMessage, options = {}) {
    if (!userMessage || !String(userMessage).trim()) return { intent: "unknown", continuation: null };

    const text = String(userMessage).trim().slice(0, 2000);

    // Try LLM-based extraction via cheapest provider
    if (this.enabled && this.tokenStore && this.fetchFn) {
      try {
        const llmResult = await this._extractViaLLM(text, options.messages);
        if (llmResult && llmResult.intent) {
          const rawIntent = llmResult.intent.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim();
          if (rawIntent.length > 0 && rawIntent.length < 30) {
            return { intent: rawIntent, continuation: llmResult.continuation || null };
          }
        }
      } catch {
        // Fall through to keyword
      }
    }

    // Fallback: keyword fingerprint
    return { intent: extractKeywordsFingerprint(text), continuation: null };
  }

  /**
   * Call the cheapest provider to extract intent AND determine if this
   * is a continuation of the previous conversation or a new task.
   * When fullMessages are provided, the prompt includes conversation
   * context so the LLM can make an informed "same task or new task" call.
   */
  async _extractViaLLM(text, fullMessages) {
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

    // Build messages for the classification request.
    // If conversation context is available, use the context-aware prompt.
    let messages;
    if (Array.isArray(fullMessages) && fullMessages.length > 0) {
      const conversationText = formatConversationForPrompt(fullMessages, 3);
      messages = [
        {
          role: "system",
          content: `Analyze the conversation below and the user's LATEST MESSAGE (at the end). Determine:

1. INTENT: What is the user asking for NOW? (1-3 words, lowercase)
2. SAME: Is this the SAME task as before, or a NEW task?
   - "yes" = the user is still working on the same task (fixing, debugging, iterating)
   - "no" = the user has moved to a completely different task

Output format EXACTLY: INTENT: <label> | SAME: yes|no

Examples:
INTENT: fix code | SAME: yes    (user said "it doesn't work" after "create validator")
INTENT: create login | SAME: no (user said "now create a login form" after fixing validator)
INTENT: debug deploy | SAME: yes (user said "still failing" after "fix deployment")`,
        },
        { role: "user", content: `Conversation:\n${conversationText}\n\n---\n\nUser's latest message: ${text}` },
      ];
    } else {
      // Fallback: original simple prompt
      messages = [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: text },
      ];
    }

    const body = JSON.stringify({
      model: modelId,
      messages,
      max_tokens: 30,
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
    const content = (data?.choices?.[0]?.message?.content || "").trim();
    if (!content) return null;

    // Parse the response for both intent and continuation
    // Expected format: "INTENT: <label> | SAME: yes|no"
    const intentMatch = content.match(/INTENT:\s*(.+?)(?:\s*\||\s*$)/i);
    const sameMatch = content.match(/SAME:\s*(yes|no)/i);

    const intent = intentMatch ? intentMatch[1].trim().toLowerCase() : content;
    const continuation = sameMatch ? (sameMatch[1].toLowerCase() === "yes" ? "same" : "new") : null;

    return { intent, continuation };
  }

  /**
   * Determine whether the new intent is a correction/fix of an existing task
   * rather than a genuinely new task. Fallback when LLM continuation is null.
   */
  _isCorrectionMessage(newIntent, currentIntent) {
    if (!currentIntent || !newIntent) return false;
    if (currentIntent === newIntent) return false;

    const newWords = newIntent.split(/[\s-]+/).filter((w) => w.length > 1);
    const oldWords = currentIntent.split(/[\s-]+/).filter((w) => w.length > 1);

    const correctionWords = newWords.filter((w) => CORRECTION_WORDS.has(w));
    const domainWords = newWords.filter((w) => !CORRECTION_WORDS.has(w));

    // If new intent is only correction words → sticky
    if (correctionWords.length >= 1 && domainWords.length === 0) return true;

    // If new intent shares domain words with old one → sticky
    if (domainWords.some((w) => oldWords.includes(w))) return true;

    return false;
  }

  /**
   * Track intent for a conversation session.
   * @param {string} intent - The intent label.
   * @param {string} currentModel - The current model name (for escalation).
   * @param {Array} availableProviders - Available providers (for escalation).
   * @param {"same"|"new"|null} [continuation] - LLM's judgment on whether this
   *   is the same task or a new one. If null, uses _isCorrectionMessage fallback.
   * @returns {{ count: number, escalated: boolean, escalationModel: string|null }}
   */
  track(intent, currentModel, availableProviders, continuation = null) {
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
      } else {
        // Intent changed — check if it's a continuation of the same task
        let isSame;
        if (continuation === "same") {
          isSame = true;
        } else if (continuation === "new") {
          // LLM says new task — but double-check with keyword fallback:
          // if _isCorrectionMessage detects correction/continuation, trust it
          // (protects against cheap LLM misclassifying frustrated users)
          isSame = this._isCorrectionMessage(intent, current.intent);
        } else {
          isSame = this._isCorrectionMessage(intent, current.intent);
        }
        if (isSame) {
          // Sticky: keep original intent, increment counter
          current.count += 1;
        } else {
          // Genuinely new task → reset
          current.intent = intent;
          current.count = 1;
          current.escalated = false;
          current.escalationModel = null;
          current.failedEscalationModels = [];
        }
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
    if (!current.escalated && current.count >= this.threshold && Array.isArray(availableProviders)) {
      escalationModel = this._findEscalationModel(currentModel, availableProviders, current.failedEscalationModels);
      if (escalationModel) {
        current.escalated = true;
        current.escalationModel = escalationModel;
      }
    }
    if (current.escalated && current.escalationModel) {
      escalationModel = current.escalationModel;
    }

    // Check re-escalation
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
    // ... unchanged ...
    const currentScore = getIntelligenceScore(currentModel);
    if (currentScore == null) return null;

    const excludeSet = new Set(excludeModels.map((m) => String(m).toLowerCase()));

    // Try configured gap first, then progressively lower to find ANY smarter model
    const startGap = this.gap;
    for (let gap = startGap; gap >= 1; gap--) {
      let bestModel = null;
      let bestScore = Infinity;

      for (const p of providers) {
        if (!p || !p.access_token || p.disabled) continue;
        const modelId = String(p.default_model || "").trim();
        if (!modelId || excludeSet.has(modelId.toLowerCase())) continue;

        const score = getIntelligenceScore(modelId);
        if (score == null) continue;
        if (score >= currentScore + gap && score < bestScore) {
          bestModel = modelId;
          bestScore = score;
        }
      }

      if (bestModel) return bestModel;
    }

    return null;
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
        // Skip messages that are only tool_result blocks (e.g. Claude Code tool outputs)
        const hasToolResult = content.some((c) => c && c.type === "tool_result");
        if (hasToolResult) continue;
        const textBlock = content.find((c) => c && c.type === "text" && c.text);
        if (textBlock) return textBlock.text;
      }
    }
  }
  return null;
}

function buildIntentPrompt() {
  return "\n\nBefore your main response, output a single line with exactly this format: [INTENT: <3-5 word summary of what the user wants>]\nThen skip a line and write your actual response.\n\nExample:\n[INTENT: create fibonacci function]\n\nWe need to create a function that generates Fibonacci numbers...";
}

function parseIntentFromResponse(content) {
  const text = String(content || "");
  const match = text.match(/^\[INTENT:\s*(.+?)\]\s*[\n\r]/im);
  if (match) return match[1].trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim();
  const inlineMatch = text.match(/\[INTENT:\s*(.+?)\]/im);
  if (inlineMatch) return inlineMatch[1].trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim();
  return null;
}

module.exports = { IntentTracker, extractKeywordsFingerprint, extractLastUserMessage, buildIntentPrompt, parseIntentFromResponse, CLASSIFY_SYSTEM_PROMPT, CORRECTION_WORDS };