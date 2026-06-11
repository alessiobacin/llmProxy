"use strict";

const { findBestModel } = require("./model-capabilities");

function estimateTotalChars(messages) {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          total += block.text.length;
        }
      }
    }
  }
  return total;
}

function hasImageContent(messages) {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "image") return true;
    }
  }
  return false;
}

function classifyComplexity(messageCount, totalChars, toolCount) {
  if (messageCount <= 4 && totalChars < 2000 && toolCount === 0) return "simple";
  if (messageCount > 20 || totalChars > 10000 || toolCount > 5) return "complex";
  return "moderate";
}

function recommendTier(needsVision, needsTools, complexity) {
  if (needsVision) return "standard";
  if (needsTools && complexity === "complex") return "premium";
  if (complexity === "complex") return "premium";
  if (complexity === "simple" && !needsTools) return "economy";
  return "standard";
}

function analyzeRequest(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  const needsVision = hasImageContent(messages);
  const needsTools = tools.length > 0;
  const totalChars = estimateTotalChars(messages);
  const messageCount = messages.length;
  const toolCount = tools.length;
  const complexity = classifyComplexity(messageCount, totalChars, toolCount);
  const recommendedTier = recommendTier(needsVision, needsTools, complexity);

  return {
    needsVision,
    needsTools,
    complexity,
    totalChars,
    messageCount,
    toolCount,
    recommendedTier,
  };
}

function routeRequest(analysis, activeProviders, preference) {
  if (!Array.isArray(activeProviders) || activeProviders.length === 0) return null;

  const registeredModels = [];
  for (const p of activeProviders) {
    if (!p.active) continue;
    if (!Array.isArray(p.models)) continue;
    for (const model of p.models) {
      registeredModels.push({
        model,
        provider: p.provider,
        scope_type: p.scope_type,
        scope_id: p.scope_id,
      });
    }
  }

  if (registeredModels.length === 0) return null;

  const requirements = {
    needsVision: analysis.needsVision === true,
    needsTools: analysis.needsTools === true,
    recommendedTier: analysis.recommendedTier || "standard",
  };

  return findBestModel(requirements, registeredModels, preference || "balanced");
}

function buildClassifierPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  const lastUserMessage = messages
    .filter((m) => m.role === "user")
    .slice(-1)[0];

  let userContent = "";
  if (lastUserMessage) {
    if (typeof lastUserMessage.content === "string") {
      userContent = lastUserMessage.content.slice(0, 500);
    } else if (Array.isArray(lastUserMessage.content)) {
      userContent = lastUserMessage.content
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join(" ")
        .slice(0, 500);
    }
  }

  const hasImages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "image"),
  );

  return [
    "Analyze this LLM request and classify it.",
    `Message count: ${messages.length}`,
    `Tool definitions: ${tools.length}`,
    `Has images: ${hasImages}`,
    `Last user message (truncated): "${userContent}"`,
    "",
    "Respond ONLY with valid JSON:",
    '{"vision":bool,"tools":bool,"complexity":"simple|moderate|complex","type":"coding|creative|reasoning|qa"}',
  ].join("\n");
}

async function classifyWithLLM(body, routerConfig, fetchFn) {
  try {
    const prompt = buildClassifierPrompt(body);

    const response = await fetchFn({
      model: routerConfig.classifierModel,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0,
    });

    if (!response?.ok) return null;

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    return {
      vision: parsed.vision === true,
      tools: parsed.tools === true,
      complexity: ["simple", "moderate", "complex"].includes(parsed.complexity) ? parsed.complexity : "moderate",
      type: ["coding", "creative", "reasoning", "qa"].includes(parsed.type) ? parsed.type : "unknown",
    };
  } catch {
    return null;
  }
}

module.exports = {
  analyzeRequest,
  routeRequest,
  classifyWithLLM,
};
