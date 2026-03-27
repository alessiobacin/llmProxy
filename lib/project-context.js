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
};