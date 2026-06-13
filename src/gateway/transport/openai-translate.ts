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

interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
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
  };
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

  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    for (const raw of choice.message.tool_calls) {
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

  const promptTokens = openai?.usage?.prompt_tokens ?? 0;
  const completionTokens = openai?.usage?.completion_tokens ?? 0;

  // Preserva reasoning_content come campo separato (per modelli come Kimi, DeepSeek R1, ecc.)
  const reasoningContent = choice.message?.reasoning_content;

  return {
    id: msgId(),
    type: "message",
    role: "assistant",
    content,
    model: String(openai?.model ?? responseModel ?? "unknown"),
    stop_reason: translateStopReason(choice.finish_reason),
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
  translateRequest,
  translateResponse,
};
