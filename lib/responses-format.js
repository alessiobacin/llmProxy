"use strict";

// ---------------------------------------------------------------------------
// OpenAI Responses API ⇄ Anthropic translation layer (T3)
//
// Adapter per POST /v1/responses (usato da Codex CLI >= 0.152, che richiede
// la Responses API e non supporta piu' wire_api = "chat").
//
// Direzione INBOUND:  Responses request  -> OpenAI chat request -> Anthropic
//   (riusa openAIRequestToAnthropic di lib/openai-format)
// Direzione OUTBOUND: Anthropic response -> Responses response
//   (non-streaming: { object: "response", output: [...] })
//   (streaming:     eventi SSE response.created / response.output_text.delta /
//                   response.output_item.done / response.completed + [DONE])
// ---------------------------------------------------------------------------

const crypto = require("node:crypto");

function responsesId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeResponsesContent(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" || part.type === "text") {
      parts.push(String(part.text ?? ""));
    } else if (part.type === "input_image" || part.type === "image_url") {
      // Immagini non supportate dal canale Anthropic testuale: ignorate.
      continue;
    }
  }
  return parts.join("");
}

/**
 * Traduce una richiesta Responses API in una richiesta OpenAI chat
 * (che a sua volta verra' convertita in Anthropic da openAIRequestToAnthropic).
 *
 * Mapping:
 *   instructions            -> messaggio system
 *   input[].role user       -> messaggio user (content normalizzato)
 *   input[].role assistant  -> messaggio assistant
 *   input[].type function_call        -> messaggio assistant con tool_calls
 *   input[].type function_call_output -> messaggio tool
 *   max_output_tokens       -> max_tokens
 *   tools[]                 -> tools OpenAI (type function + function.name/...)
 *   tool_choice             -> tool_choice OpenAI
 */
function responsesRequestToOpenAIChat(responsesBody = {}) {
  const input = Array.isArray(responsesBody.input) ? responsesBody.input : [];
  const messages = [];

  const instructions = String(responsesBody.instructions ?? "").trim();
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: String(item.call_id ?? item.id ?? "").trim() || `call_${messages.length}`,
          type: "function",
          function: {
            name: String(item.name ?? "tool").trim(),
            arguments: String(item.arguments ?? "{}"),
          },
        }],
      });
      continue;
    }

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? "").trim(),
        content: String(item.output ?? ""),
      });
      continue;
    }

    const role = String(item.role ?? "").trim();
    if (role === "system") {
      const systemText = normalizeResponsesContent(item.content);
      if (systemText) messages.push({ role: "system", content: systemText });
      continue;
    }
    if (role === "assistant") {
      messages.push({ role: "assistant", content: normalizeResponsesContent(item.content) });
      continue;
    }
    if (role === "user") {
      messages.push({ role: "user", content: normalizeResponsesContent(item.content) });
      continue;
    }
  }

  const out = {
    model: responsesBody.model,
    messages,
  };

  if (responsesBody.max_output_tokens != null) out.max_tokens = responsesBody.max_output_tokens;
  if (responsesBody.temperature !== undefined) out.temperature = responsesBody.temperature;
  if (responsesBody.top_p !== undefined) out.top_p = responsesBody.top_p;
  if (responsesBody.stream !== undefined) out.stream = responsesBody.stream;

  if (Array.isArray(responsesBody.tools) && responsesBody.tools.length > 0) {
    out.tools = responsesBody.tools.map((tool) => {
      const fn = tool?.function || {};
      return {
        type: tool?.type || "function",
        function: {
          name: String(fn.name ?? tool?.name ?? "tool").trim(),
          description: String(fn.description ?? tool?.description ?? "").trim(),
          parameters: fn.parameters ?? tool?.parameters ?? { type: "object", properties: {} },
        },
      };
    });
  }

  if (responsesBody.tool_choice !== undefined) {
    out.tool_choice = responsesBody.tool_choice;
  }

  return out;
}

function safeParseJson(rawValue) {
  try {
    return JSON.parse(String(rawValue ?? "{}"));
  } catch {
    return {};
  }
}

function extractUsageCounts(rawUsage = {}) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const firstFinite = (...values) => {
    for (const value of values) {
      const normalized = Number(value);
      if (Number.isFinite(normalized) && normalized >= 0) return normalized;
    }
    return null;
  };

  const inputTokens = firstFinite(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.promptTokens);
  const outputTokens = firstFinite(usage.output_tokens, usage.completion_tokens, usage.outputTokens, usage.completionTokens);
  const totalTokens = firstFinite(usage.total_tokens, usage.totalTokens);

  return {
    inputTokens: inputTokens ?? Math.max(0, Number(totalTokens || 0) - Number(outputTokens || 0)),
    outputTokens: outputTokens ?? Math.max(0, Number(totalTokens || 0) - Number(inputTokens || 0)),
  };
}

/**
 * Traduce una risposta Anthropic (non-streaming) in una risposta Responses API.
 */
function anthropicResponseToResponses(anthropic, model) {
  const blocks = Array.isArray(anthropic?.content) ? anthropic.content : [];
  const output = [];
  const textParts = [];

  for (const block of blocks) {
    if (block?.type === "text") {
      textParts.push(String(block.text ?? ""));
      continue;
    }
    if (block?.type === "tool_use") {
      output.push({
        type: "function_call",
        id: responsesId("fc"),
        call_id: String(block.id ?? responsesId("call")),
        name: String(block.name ?? "tool"),
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  if (textParts.length > 0) {
    output.unshift({
      type: "message",
      id: responsesId("msg"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: textParts.join("") }],
    });
  }

  const usageCounts = extractUsageCounts(anthropic?.usage);
  const inputTokens = usageCounts.inputTokens;
  const outputTokens = usageCounts.outputTokens;

  return {
    id: responsesId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: String(anthropic?.model ?? model ?? "unknown"),
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming: Anthropic SSE -> Responses SSE
// ---------------------------------------------------------------------------

function serializeResponsesEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createResponsesStreamTranslator(options = {}) {
  return {
    id: responsesId("resp"),
    model: String(options.model || "unknown"),
    created: Math.floor(Date.now() / 1000),
    sentCreated: false,
    sentCompleted: false,
    outputItemId: null,
    outputIndex: 0,
    buffer: "",
  };
}

function buildResponseObject(state, extra = {}) {
  return {
    id: state.id,
    object: "response",
    created_at: state.created,
    status: "in_progress",
    model: state.model,
    ...extra,
  };
}

/**
 * Consuma uno (possibile) write SSE grezzo dal canale Anthropic e restituisce
 * gli eventi Responses API da inoltrare. Mantiene un buffer interno per gestire
 * eventi spezzati tra write successivi.
 */
function anthropicSseWriteToResponsesEvents(state, rawWrite) {
  if (state.sentCompleted) return [];
  state.buffer += String(rawWrite ?? "");
  const events = [];

  let boundary = state.buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const rawEvent = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    boundary = state.buffer.indexOf("\n\n");

    let dataLine = null;
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data:")) {
        dataLine = line.slice(5).trim();
        break;
      }
    }
    if (dataLine === null || dataLine === "[DONE]") continue;

    let event;
    try {
      event = JSON.parse(dataLine);
    } catch {
      continue;
    }

    events.push(...handleAnthropicSseEventForResponses(state, event));
  }

  return events;
}

function handleAnthropicSseEventForResponses(state, event) {
  const type = String(event.type ?? "");
  const out = [];

  if (type === "message_start") {
    if (!state.sentCreated) {
      state.sentCreated = true;
      out.push(serializeResponsesEvent("response.created", {
        type: "response.created",
        response: buildResponseObject(state),
      }));
    }
    return out;
  }

  if (type === "content_block_start") {
    const block = event.content_block;
    if (block?.type === "tool_use") {
      state.outputItemId = String(block.id ?? responsesId("fc"));
      out.push(serializeResponsesEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: {
          id: state.outputItemId,
          type: "function_call",
          status: "in_progress",
          call_id: state.outputItemId,
          name: String(block.name ?? "tool"),
          arguments: "",
        },
      }));
    } else {
      state.outputItemId = responsesId("msg");
      out.push(serializeResponsesEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: {
          id: state.outputItemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }));
    }
    return out;
  }

  if (type === "content_block_delta") {
    const delta = event.delta;
    if (!delta) return out;
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      out.push(serializeResponsesEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: state.outputItemId || responsesId("msg"),
        output_index: state.outputIndex,
        delta: delta.text,
      }));
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
      out.push(serializeResponsesEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: state.outputItemId || responsesId("fc"),
        output_index: state.outputIndex,
        delta: delta.partial_json,
      }));
    }
    return out;
  }

  if (type === "message_delta") {
    const usage = event.usage;
    const usageCounts = extractUsageCounts(usage);
    const inputTokens = usageCounts.inputTokens;
    const outputTokens = usageCounts.outputTokens;
    out.push(serializeResponsesEvent("response.completed", {
      type: "response.completed",
      response: buildResponseObject(state, {
        status: "completed",
        output: [],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      }),
    }));
    return out;
  }

  if (type === "message_stop") {
    state.sentCompleted = true;
    out.push("data: [DONE]\n\n");
    return out;
  }

  return out;
}

module.exports = {
  responsesRequestToOpenAIChat,
  anthropicResponseToResponses,
  createResponsesStreamTranslator,
  anthropicSseWriteToResponsesEvents,
};