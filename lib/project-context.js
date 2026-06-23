const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function expandHome(input) {
  const value = String(input || "").trim();
  if (!value.startsWith("~/")) return value;
  return path.join(os.homedir(), value.slice(2));
}

function normalizeProjectPath(input) {
  const value = expandHome(input);
  if (!value) return "";
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(value);
}

function extractSystemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function extractFromText(text, source) {
  const patterns = [
    /(?:Primary\s+)?working\s+directory:\s*([^\n]+)/i,
    /cwd:\s*([^\n]+)/i,
    /current\s+directory:\s*([^\n]+)/i,
    /project\s+(?:path|directory):\s*([^\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (!match || !match[1]) continue;
    const projectPath = normalizeProjectPath(match[1]);
    if (!projectPath) continue;
    return { projectPath, source };
  }

  return null;
}

function readPackageName(packageFile) {
  try {
    const payload = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    const name = String(payload?.name || "").trim();
    return name || "";
  } catch {
    return "";
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isProxyModelLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "llmproxy"
    || normalized === "llm-proxy"
    || normalized === "proxy-local";
}

function isLikelyLocalProxyBaseUrl(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.startsWith("http://127.0.0.1:")
    || normalized.startsWith("http://localhost:")
    || normalized.startsWith("https://127.0.0.1:")
    || normalized.startsWith("https://localhost:");
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function resolveProjectMetadata(projectPath) {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) {
    return {
      projectPath: "",
      projectName: null,
      projectNameSource: "unknown",
    };
  }

  let currentPath = normalizedPath;
  while (true) {
    const packageFile = path.join(currentPath, "package.json");
    if (fs.existsSync(packageFile)) {
      const packageName = readPackageName(packageFile);
      if (packageName) {
        return {
          projectPath: normalizedPath,
          projectName: packageName,
          projectNameSource: "package.json",
        };
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }

  return {
    projectPath: normalizedPath,
    projectName: path.basename(normalizedPath),
    projectNameSource: "path",
  };
}

function parseSmartRouteMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["rules", "llm", "hybrid"].includes(normalized)) return normalized;
  return null;
}

function parseSmartRoutePreference(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["economy", "balanced", "quality"].includes(normalized)) return normalized;
  return "balanced";
}

function parseSmartRouteCacheTtl(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 300_000;
}

function resolveSmartRouteSettings(env) {
  return {
    smartRoute: parseSmartRouteMode(env.LLMPROXY_SMART_ROUTE),
    smartPreference: parseSmartRoutePreference(env.LLMPROXY_SMART_PREFERENCE),
    smartCacheTtl: parseSmartRouteCacheTtl(env.LLMPROXY_SMART_CACHE_TTL),
  };
}

function resolveClaudeProjectSettings(projectPath) {
  const normalizedPath = normalizeProjectPath(projectPath);
  if (!normalizedPath) {
    return {
      configuredModel: null,
      configuredModelSource: "unknown",
      proxyControlsModel: false,
      shortAnswer: null,
      smartRoute: null,
      smartPreference: "balanced",
      smartCacheTtl: 300_000,
    };
  }

  let currentPath = normalizedPath;
  while (true) {
    const settingsFile = path.join(currentPath, ".claude", "settings.json");
    if (fs.existsSync(settingsFile)) {
      const payload = readJsonFile(settingsFile);
      const env = payload?.env && typeof payload.env === "object" ? payload.env : {};
      const claudeModel = String(payload?.model || "").trim();
      const configuredModel = String(env.ANTHROPIC_DEFAULT_MODEL || "").trim();
      const anthropicBaseUrl = String(env.ANTHROPIC_BASE_URL || "").trim();
      const shortAnswer = parseBooleanLike(env.LLMPROXY_SHORT_ANSWER);
      const smart = resolveSmartRouteSettings(env);
      const usesLocalProxy = isProxyModelLabel(claudeModel) || isLikelyLocalProxyBaseUrl(anthropicBaseUrl);
      const configuredModelLooksLikeFallbackList = configuredModel.includes(",")
        || /^(copilot|openrouter|zai|z\.ai|kimi|qwen|opencode(?:-go)?|openai|anthropic|deepseek|groq|mistral|xai|perplexity|together|fireworks|commandcode)[:\-]/i.test(configuredModel);
      if (usesLocalProxy && configuredModel && configuredModelLooksLikeFallbackList) {
        return {
          configuredModel,
          configuredModelSource: "settings.json",
          proxyControlsModel: false,
          shortAnswer,
          ...smart,
        };
      }
      if (usesLocalProxy && isProxyModelLabel(claudeModel)) {
        return {
          configuredModel: null,
          configuredModelSource: "settings.json:model",
          proxyControlsModel: true,
          shortAnswer,
          ...smart,
        };
      }
      if (usesLocalProxy && claudeModel) {
        return {
          configuredModel: claudeModel,
          configuredModelSource: "settings.json:model",
          proxyControlsModel: false,
          shortAnswer,
          ...smart,
        };
      }
      if (usesLocalProxy && configuredModel) {
        return {
          configuredModel,
          configuredModelSource: "settings.json",
          proxyControlsModel: false,
          shortAnswer,
          ...smart,
        };
      }
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }

  return {
    configuredModel: null,
    configuredModelSource: "unknown",
    proxyControlsModel: false,
    shortAnswer: null,
    smartRoute: null,
    smartPreference: "balanced",
    smartCacheTtl: 300_000,
  };
}

function detectProjectContext(req = {}) {
  const headers = req.headers || {};
  const body = req.body || {};

  const headerProjectPath = headers["x-project-path"] || headers["x-workspace-path"];
  if (headerProjectPath) {
    const normalized = normalizeProjectPath(headerProjectPath);
    if (normalized) return { projectPath: normalized, source: "header" };
  }

  const metadataProjectPath = body?.metadata?.project_path || body?.metadata?.projectPath;
  if (metadataProjectPath) {
    const normalized = normalizeProjectPath(metadataProjectPath);
    if (normalized) return { projectPath: normalized, source: "metadata" };
  }

  const fromSystem = extractFromText(extractSystemText(body.system), "system");
  if (fromSystem) return fromSystem;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (typeof message?.content === "string") {
      const fromString = extractFromText(message.content, "messages");
      if (fromString) return fromString;
    }
    if (!Array.isArray(message?.content)) continue;
    const mergedText = message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const fromBlocks = extractFromText(mergedText, "messages");
    if (fromBlocks) return fromBlocks;
  }

  return { projectPath: "", source: "unknown" };
}

module.exports = {
  normalizeProjectPath,
  detectProjectContext,
  resolveProjectMetadata,
  resolveClaudeProjectSettings,
};
