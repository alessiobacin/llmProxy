type OpenAITextBlock = {
  type: "text";
  text?: string;
};

type OpenAIImageUrlBlock = {
  type: "image_url";
  image_url?: {
    url?: string;
  };
};

type OpenAIContentBlock = OpenAITextBlock | OpenAIImageUrlBlock;

type OpenAIToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIMessage = {
  role?: "system" | "user" | "assistant" | "tool" | string;
  content?: string | OpenAIContentBlock[] | unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

type OpenAITool = {
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type OpenAIToolChoice =
  | string
  | {
      type?: string;
      function?: {
        name?: string;
      };
    };

type OpenAIChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
};

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicImageBlock = {
  type: "image";
  source:
    | {
        type: "base64";
        media_type: string;
        data: string;
      }
    | {
        type: "url";
        url: string;
      };
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type AnthropicUserContent = string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock>;

type AnthropicMessage =
  | {
      _system: string;
    }
  | {
      role: "assistant";
      content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
    }
  | {
      role: "user";
      content: AnthropicUserContent;
    };

type AnthropicTool = {
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
};

type AnthropicToolChoice =
  | {
      type: string;
    }
  | {
      type: "tool";
      name?: string;
    };

type AnthropicRequest = {
  model?: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
};

type AnthropicResponseBlock =
  | {
      type: "text";
      text?: string;
    }
  | {
      type: "tool_use";
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };

type AnthropicResponse = {
  content?: AnthropicResponseBlock[];
  stop_reason?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  reasoning_content?: string;
};

import crypto from "node:crypto";

type OpenAIChatResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id?: string;
        type: "function";
        function: {
          name?: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: "tool_calls" | "length" | "stop";
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

function openAIMessageToAnthropic(msg: OpenAIMessage | null | undefined): AnthropicMessage | null {
  if (!msg) return null;

  const role = msg.role;
  if (role === "system") {
    const content = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("\n")
        : "";
    return { _system: content };
  }

  if (role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      }],
    };
  }

  if (role === "assistant") {
    const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
    if (msg.content) {
      content.push({
        type: "text",
        text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(toolCall.function?.arguments ?? "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: toolCall.id ?? "",
          name: toolCall.function?.name ?? "",
          input,
        });
      }
    }
    return {
      role: "assistant",
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
    };
  }

  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content };
  }

  if (Array.isArray(msg.content)) {
    const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
    for (const item of msg.content) {
      if (item.type === "text") {
        blocks.push({ type: "text", text: item.text ?? "" });
        continue;
      }
      if (item.type === "image_url") {
        const url = item.image_url?.url ?? "";
        const match = url.match(/^data:([^;]+);base64,(.*)$/);
        if (match) {
          const mediaType = match[1] ?? "application/octet-stream";
          const data = match[2] ?? "";
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data,
            },
          });
        } else {
          blocks.push({
            type: "image",
            source: {
              type: "url",
              url,
            },
          });
        }
      }
    }
    return { role: "user", content: blocks };
  }

  return { role: "user", content: String(msg.content ?? "") };
}

function openAIRequestToAnthropic(body: OpenAIChatRequest): AnthropicRequest {
  const out: AnthropicRequest = {
    messages: [],
  };
  if (body.model !== undefined) out.model = body.model;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];

  for (const message of messages) {
    const translated = openAIMessageToAnthropic(message);
    if (!translated) continue;
    if ("_system" in translated) {
      systemParts.push(translated._system);
      continue;
    }
    out.messages.push(translated);
  }

  if (systemParts.length > 0) out.system = systemParts.join("\n");
  const maxTokens = body.max_tokens || body.max_completion_tokens;
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  if (body.stream !== undefined) out.stream = body.stream;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => {
      const anthropicTool: AnthropicTool = {
        description: tool.function?.description ?? "",
        input_schema: tool.function?.parameters ?? { type: "object", properties: {} },
      };
      if (tool.function?.name !== undefined) anthropicTool.name = tool.function.name;
      return anthropicTool;
    });
  }

  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      out.tool_choice = body.tool_choice === "required"
        ? { type: "any" }
        : { type: body.tool_choice };
    } else if (body.tool_choice.type === "function") {
      out.tool_choice = { type: "tool", name: body.tool_choice.function?.name };
    }
  }

  return out;
}

function anthropicResponseToOpenAI(anthropic: AnthropicResponse): OpenAIChatResponse {
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
  const textParts: string[] = [];
  const toolCalls: OpenAIChatResponse["choices"][number]["message"]["tool_calls"] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      textParts.push(block.text ?? "");
      continue;
    }
    if (block.type === "tool_use") {
      const toolCall: NonNullable<OpenAIChatResponse["choices"][number]["message"]["tool_calls"]>[number] = {
        type: "function",
        function: {
          arguments: JSON.stringify(block.input ?? {}),
        },
      };
      if (block.id !== undefined) toolCall.id = block.id;
      if (block.name !== undefined) toolCall.function.name = block.name;
      toolCalls.push(toolCall);
    }
  }

  const finishReason: "tool_calls" | "length" | "stop" = anthropic.stop_reason === "tool_use"
    ? "tool_calls"
    : anthropic.stop_reason === "max_tokens"
      ? "length"
      : "stop";

  const promptTokens = anthropic.usage?.input_tokens ?? 0;
  const completionTokens = anthropic.usage?.output_tokens ?? 0;

  // Estrai reasoning_content se presente (per modelli come Kimi, DeepSeek R1, ecc.)
  const reasoningContent = anthropic.reasoning_content;

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropic.model ?? "unknown",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textParts.join("") || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export {
  openAIRequestToAnthropic,
  anthropicResponseToOpenAI,
};
