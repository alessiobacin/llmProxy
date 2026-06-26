import crypto from "node:crypto";
import { translateAssistant } from "./message-translate";

const MODEL_MAP: Record<string, string> = {
  "claude-opus-4-6-20250820": "claude-opus-4-6",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4.5",
  haiku: "claude-haiku-4.5",
  gpt: "gpt-5",
};

const DEFAULT_COPILOT_MODEL = "claude-sonnet-4.5";

// ---------- Anthropic input types ----------

interface AnthropicTextBlock {
  type: "text";
  text?: string;
}
interface AnthropicImageBlock {
  type: "image";
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[] | unknown;
  is_error?: boolean | unknown;
}
interface AnthropicThinkingBlock {
  type: "thinking";
  thinking?: string;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

interface AnthropicToolDef {
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicAssistantMsg {
  role: string;
  content?: string | AnthropicContentBlock[];
}
interface AnthropicUserMsg {
  role: string;
  content: string | AnthropicContentBlock[];
}
interface AnthropicToolMsg {
  role: "tool";
  tool_call_id?: string;
  content: string;
}
interface AnthropicSystemMsg {
  role: "system";
  content: string;
}
interface AnthropicGenericMsg {
  role: string;
  content: string;
}
type AnthropicMessage =
  | AnthropicAssistantMsg
  | AnthropicUserMsg
  | AnthropicToolMsg
  | AnthropicSystemMsg
  | AnthropicGenericMsg;

interface AnthropicRequest {
  model?: string;
  system?: string | AnthropicContentBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDef[];
  tool_choice?: string | { type?: string; name?: string };
}

// ---------- Translated output types ----------

interface OpenAIToolCall {
  id?: string;
  type: "function";
  function: {
    name?: string;
    arguments: string;
  };
}

interface OpenAIToolParam {
  type: "function";
  function: {
    name?: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIMessageContentText {
  type: "text";
  text: string;
}
interface OpenAIMessageContentImage {
  type: "image_url";
  image_url: { url: string };
}
type OpenAIMessageContentPart = OpenAIMessageContentText | OpenAIMessageContentImage;

interface OpenAIUserMessage {
  role: "user";
  content: string | OpenAIMessageContentPart[];
}
interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
interface OpenAIAssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
}
interface OpenAISystemMessage {
  role: "system";
  content: string;
}

type TranslatedMessage =
  | OpenAIUserMessage
  | OpenAIToolMessage
  | OpenAIAssistantMessage
  | OpenAISystemMessage
  | { role: string; content: string };

interface TranslatedRequest {
  model: string;
  messages: TranslatedMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAIToolParam[];
  tool_choice?: string | { type: "function"; function: { name?: string } };
}

// ---------- Anthropic response output type ----------

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  reasoning_content?: string;
}

type OpenAIMessageContent =
  | string
  | Array<string | { type?: string; text?: string; content?: string }>;

interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: OpenAIMessageContent;
      reasoning_content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface ParsedToolUse {
  name: string;
  input: Record<string, unknown>;
}

interface XmlishNode {
  name: string;
  attrs: Record<string, string>;
  inner: string;
}

// ---------- type guards ----------

function isText(b: AnthropicContentBlock): b is AnthropicTextBlock {
  return b.type === "text";
}
function isImage(b: AnthropicContentBlock): b is AnthropicImageBlock {
  return b.type === "image";
}
function isToolResult(b: AnthropicContentBlock): b is AnthropicToolResultBlock {
  return b.type === "tool_result";
}

// ---------- functions ----------

function msgId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function mapModel(name: string | null | undefined): string {
  const value = String(name ?? "").trim();
  if (!value) return DEFAULT_COPILOT_MODEL;
  if (MODEL_MAP[value] !== undefined) return MODEL_MAP[value]!;
  const stripped = value.replace(/-\d{8}$/, "");
  return MODEL_MAP[stripped] ?? value;
}

function getAvailableModels(): string[] {
  return [
    ...new Set(
      Object.values(MODEL_MAP)
        .map((model) => String(model).trim())
        .filter((m) => m.length > 0),
    ),
  ];
}

function resolveSupportedModel(
  name: string | null | undefined,
  fallbackModel: string = DEFAULT_COPILOT_MODEL,
  availableModels?: string[],
): string {
  const mappedModel = mapModel(name);
  const supportedModels = new Set([
    ...getAvailableModels(),
    ...(Array.isArray(availableModels)
      ? availableModels.map((model) => String(model ?? "").trim()).filter((m) => m.length > 0)
      : []),
  ]);
  if (supportedModels.has(mappedModel)) return mappedModel;

  const fallbackCandidate = mapModel(fallbackModel);
  if (supportedModels.has(fallbackCandidate)) return fallbackCandidate;

  return DEFAULT_COPILOT_MODEL;
}

function isClaude(model: string | null | undefined): boolean {
  return String(model ?? "").includes("claude");
}

function translateTool(tool: AnthropicToolDef): OpenAIToolParam {
  const fn: OpenAIToolParam["function"] = {
    description: tool.description ?? "",
    parameters: tool.input_schema ?? { type: "object", properties: {} },
  };
  if (tool.name !== undefined) fn.name = tool.name;
  return {
    type: "function",
    function: fn,
  };
}

function translateToolChoice(
  choice: string | { type?: string; name?: string } | null | undefined,
): TranslatedRequest["tool_choice"] {
  if (!choice) return undefined;
  if (typeof choice === "string") {
    if (choice === "required") return "required";
    if (choice === "auto") return "auto";
    if (choice === "none") return "none";
    return "auto";
  }
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const result: TranslatedRequest["tool_choice"] = { type: "function", function: {} };
      if (choice.name !== undefined) result.function.name = choice.name;
      return result;
    }
    default:
      return "auto";
  }
}

function formatContent(blocks: string | AnthropicContentBlock[] | null | undefined): string | OpenAIMessageContentPart[] {
  if (!Array.isArray(blocks)) return String(blocks ?? "");
  const hasImages = blocks.some(isImage);
  if (hasImages) {
    const result: OpenAIMessageContentPart[] = [];
    for (const block of blocks) {
      if (isText(block)) {
        result.push({ type: "text", text: block.text ?? "" });
        continue;
      }
      if (isImage(block)) {
        const source = block.source;
        const url =
          source?.type === "base64"
            ? `data:${source.media_type ?? ""};base64,${source.data ?? ""}`
            : source?.url ?? "";
        result.push({ type: "image_url", image_url: { url } });
      }
    }
    return result;
  }

  return blocks
    .filter(isText)
    .map((block) => block.text ?? "")
    .join("\n");
}

function translateUser(message: AnthropicUserMsg): OpenAIUserMessage | OpenAIToolMessage | Array<OpenAIUserMessage | OpenAIToolMessage> {
  if (!Array.isArray(message.content)) {
    return { role: "user", content: String(message.content ?? "") };
  }

  const blocks = message.content;
  const toolResults = blocks.filter(isToolResult);
  const otherBlocks = blocks.filter((b) => !isToolResult(b) && b.type !== "thinking");
  const messages: Array<OpenAIUserMessage | OpenAIToolMessage> = [];

  for (const toolResult of toolResults) {
    let contentStr = "";
    const toolContent = toolResult.content;
    if (typeof toolContent === "string") {
      contentStr = toolContent;
    } else if (Array.isArray(toolContent)) {
      contentStr = toolContent
        .filter((b): b is AnthropicTextBlock & { text: string } => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
    } else if (toolContent) {
      contentStr = JSON.stringify(toolContent);
    }

    if (toolResult.is_error) contentStr = `[ERROR] ${contentStr}`;
    messages.push({
      role: "tool" as const,
      tool_call_id: toolResult.tool_use_id ?? "",
      content: contentStr,
    });
  }

  if (otherBlocks.length > 0) {
    messages.push({ role: "user" as const, content: formatContent(otherBlocks) });
  }

  if (messages.length === 1) return messages[0]!;
  return messages;
}

function stringifyContent(content: string | AnthropicContentBlock[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter(isText)
    .map((block) => block.text ?? "")
    .join("\n");
}

function translateMessage(message: AnthropicMessage): TranslatedMessage | TranslatedMessage[] {
  if (message.role === "assistant") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return translateAssistant(message as any) as TranslatedMessage;
  }
  if (message.role === "user") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return translateUser(message as any) as TranslatedMessage | TranslatedMessage[];
  }
  return { role: message.role, content: stringifyContent((message as AnthropicGenericMsg).content) };
}

function translateRequest(body: AnthropicRequest): TranslatedRequest {
  const output: TranslatedRequest = {
    model: mapModel(body.model),
    messages: [],
  };

  if (body.system) {
    const systemText =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system
            .filter((block): block is AnthropicTextBlock & { text: string } => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n")
          : "";
    if (systemText) output.messages.push({ role: "system", content: systemText });
  }

  const messages: AnthropicMessage[] = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const translated = translateMessage(message);
    if (Array.isArray(translated)) {
      for (const t of translated) output.messages.push(t);
    } else {
      output.messages.push(translated);
    }
  }

  if (body.max_tokens) {
    const usesCompletionTokens = /^(gpt-5|o1|o3|o4)/.test(output.model ?? "");
    if (usesCompletionTokens) {
      output.max_completion_tokens = body.max_tokens;
    } else {
      output.max_tokens = body.max_tokens;
    }
  }
  if (body.temperature !== undefined) output.temperature = body.temperature;
  if (body.top_p !== undefined) output.top_p = body.top_p;
  if (body.stop_sequences) output.stop = body.stop_sequences;
  if (body.stream !== undefined) output.stream = body.stream;
  if (body.stream) output.stream_options = { include_usage: true };
  if (body.tools !== undefined && body.tools.length > 0) {
    output.tools = body.tools.map(translateTool);
  }
  if (body.tool_choice) {
    const tc = translateToolChoice(body.tool_choice);
    if (tc !== undefined) output.tool_choice = tc;
  }

  return output;
}

function translateStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

const MINIMAX_STREAM_MARKER_REGEX = /\]<(?:\|minimax\|>|\]minimax\[>)\[/g;
const MINIMAX_TOOL_BLOCK_START_REGEX = /<tool_call>|<invoke\b[^>]*name=/i;

function parseXmlishAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z][\w-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(rawAttrs)) !== null) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    attrs[key] = value;
  }
  return attrs;
}

function findMatchingXmlishCloseTag(source: string, tagName: string, startIndex: number): number {
  const closeTag = `</${tagName}>`;
  let depth = 1;
  let cursor = startIndex;
  while (depth > 0) {
    const nextClose = source.indexOf(closeTag, cursor);
    if (nextClose === -1) return -1;

    const nextOpen = source.indexOf(`<${tagName}`, cursor);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const boundaryChar = source[nextOpen + tagName.length + 1] ?? "";
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

function parseXmlishChildren(source: string): XmlishNode[] | null {
  const input = String(source ?? "").trim();
  if (!input) return [];

  const nodes: XmlishNode[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor] ?? "")) cursor += 1;
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

function xmlishNodeToValue(node: XmlishNode): unknown {
  const children = parseXmlishChildren(node.inner);
  if (!children || children.length === 0) return node.inner.trim();
  if (children.every((child) => child.name === "item")) {
    return children.map((child) => xmlishNodeToValue(child));
  }

  const result: Record<string, unknown> = {};
  for (const child of children) {
    const value = xmlishNodeToValue(child);
    if (result[child.name] === undefined) {
      result[child.name] = value;
      continue;
    }
    if (Array.isArray(result[child.name])) {
      (result[child.name] as unknown[]).push(value);
      continue;
    }
    result[child.name] = [result[child.name], value];
  }
  return result;
}

function normalizeMinimaxToolMarkup(rawText: string): string {
  return String(rawText ?? "")
    .replace(MINIMAX_STREAM_MARKER_REGEX, "")
    .replace(/^\s*<tool_call>\s*/i, "")
    .replace(/\s*<\/tool_call>\s*$/i, "")
    .trim();
}

function parseMinimaxToolCallBlock(rawText: string): ParsedToolUse[] | null {
  const normalized = normalizeMinimaxToolMarkup(rawText);
  if (!normalized || !/<invoke\b[^>]*name=/i.test(normalized)) return null;

  const nodes = parseXmlishChildren(normalized);
  if (!nodes || nodes.length === 0) return null;

  const toolUses: ParsedToolUse[] = [];
  for (const node of nodes) {
    if (node.name !== "invoke") continue;
    const name = String(node.attrs.name ?? "").trim();
    if (!name) continue;

    const children = parseXmlishChildren(node.inner);
    const value = !children || children.length === 0
      ? {}
      : xmlishNodeToValue({ name: "input", attrs: {}, inner: node.inner });
    const input = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { value };
    toolUses.push({ name, input });
  }

  return toolUses.length > 0 ? toolUses : null;
}

function parseMinimaxToolCallContent(rawText: string): AnthropicContentBlock[] | null {
  const text = String(rawText ?? "");
  if (!MINIMAX_TOOL_BLOCK_START_REGEX.test(text)) return null;

  const content: AnthropicContentBlock[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const match = remaining.match(MINIMAX_TOOL_BLOCK_START_REGEX);
    if (!match || match.index === undefined) {
      const trailingText = remaining.trim();
      if (trailingText) content.push({ type: "text", text: trailingText });
      break;
    }

    const start = match.index;
    const prefix = remaining.slice(0, start).trim();
    if (prefix) content.push({ type: "text", text: prefix });

    remaining = remaining.slice(start);
    const closingTag = remaining.startsWith("<tool_call>") ? "</tool_call>" : "</invoke>";
    const blockEnd = remaining.indexOf(closingTag);
    if (blockEnd === -1) return null;

    const rawBlock = remaining.slice(0, blockEnd + closingTag.length);
    const toolUses = parseMinimaxToolCallBlock(rawBlock);
    if (!toolUses) return null;

    for (const toolUse of toolUses) {
      content.push({
        type: "tool_use",
        id: msgId(),
        name: toolUse.name,
        input: toolUse.input,
      });
    }

    remaining = remaining.slice(blockEnd + closingTag.length);
  }

  return content.some((block) => block.type === "tool_use") ? content : null;
}

function extractOpenAIMessageText(content: OpenAIMessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter((value) => value.length > 0)
    .join("\n");
}

function translateResponse(openai: OpenAIResponse | null | undefined, responseModel?: string): AnthropicResponse {
  const choice = openai?.choices?.[0];
  if (!choice) {
    return {
      id: msgId(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: String(openai?.model ?? responseModel ?? "unknown"),
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content: AnthropicContentBlock[] = [];
  const messageText = extractOpenAIMessageText(choice.message?.content);
  const explicitToolCalls = Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0;
  const parsedMinimaxContent = !explicitToolCalls ? parseMinimaxToolCallContent(messageText) : null;
  if (parsedMinimaxContent) {
    content.push(...parsedMinimaxContent);
  } else if (messageText) {
    content.push({ type: "text", text: messageText });
  }

  if (explicitToolCalls) {
    for (const raw of choice.message?.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw.function?.arguments ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: raw.id ?? "",
        name: raw.function?.name ?? "",
        input,
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const promptTokens = openai?.usage?.prompt_tokens ?? openai?.usage?.input_tokens ?? 0;
  const completionTokens = openai?.usage?.completion_tokens ?? openai?.usage?.output_tokens ?? 0;

  // Preserva reasoning_content come campo separato (per modelli come Kimi, DeepSeek R1, ecc.)
  const reasoningContent = choice.message?.reasoning_content;

  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    content,
    model: String(openai?.model ?? responseModel ?? "unknown"),
    stop_reason: content.some((block) => block.type === "tool_use")
      ? "tool_use"
      : translateStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: completionTokens,
    },
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

export {
  DEFAULT_COPILOT_MODEL,
  msgId,
  getAvailableModels,
  mapModel,
  resolveSupportedModel,
  isClaude,
  parseMinimaxToolCallContent,
  translateRequest,
  translateResponse,
};
