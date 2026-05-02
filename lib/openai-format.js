const crypto = require("node:crypto");

function openAIMessageToAnthropic(msg) {
  if (!msg) return null;
  const role = msg.role;
  if (role === "system") {
    return { _system: typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((b) => b.text || "").join("\n") : "" };
  }
  if (role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "") }],
    };
  }
  if (role === "assistant") {
    const content = [];
    if (msg.content) content.push({ type: "text", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input });
      }
    }
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] };
  }
  // user
  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content };
  }
  if (Array.isArray(msg.content)) {
    const blocks = [];
    for (const item of msg.content) {
      if (item.type === "text") blocks.push({ type: "text", text: item.text });
      else if (item.type === "image_url") {
        const url = item.image_url?.url || "";
        const m = url.match(/^data:([^;]+);base64,(.*)$/);
        if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
        else blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
    return { role: "user", content: blocks };
  }
  return { role: "user", content: String(msg.content || "") };
}

function openAIRequestToAnthropic(body) {
  const out = { model: body.model, messages: [] };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = [];
  for (const m of messages) {
    const translated = openAIMessageToAnthropic(m);
    if (!translated) continue;
    if (translated._system) {
      systemParts.push(translated._system);
      continue;
    }
    out.messages.push(translated);
  }
  if (systemParts.length) out.system = systemParts.join("\n");
  if (body.max_tokens || body.max_completion_tokens) out.max_tokens = body.max_tokens || body.max_completion_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  if (body.stream !== undefined) out.stream = body.stream;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      name: t.function?.name,
      description: t.function?.description || "",
      input_schema: t.function?.parameters || { type: "object", properties: {} },
    }));
  }
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      out.tool_choice = body.tool_choice === "required" ? { type: "any" } : { type: body.tool_choice };
    } else if (body.tool_choice.type === "function") {
      out.tool_choice = { type: "tool", name: body.tool_choice.function?.name };
    }
  }
  return out;
}

function anthropicResponseToOpenAI(anthropic) {
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const blocks = Array.isArray(anthropic?.content) ? anthropic.content : [];
  const textParts = [];
  const toolCalls = [];
  for (const b of blocks) {
    if (b.type === "text") textParts.push(b.text || "");
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      });
    }
  }
  const finishReason = anthropic?.stop_reason === "tool_use"
    ? "tool_calls"
    : anthropic?.stop_reason === "max_tokens"
      ? "length"
      : "stop";
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropic?.model || "unknown",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textParts.join("") || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: anthropic?.usage?.input_tokens || 0,
      completion_tokens: anthropic?.usage?.output_tokens || 0,
      total_tokens: (anthropic?.usage?.input_tokens || 0) + (anthropic?.usage?.output_tokens || 0),
    },
  };
}

module.exports = {
  openAIRequestToAnthropic,
  anthropicResponseToOpenAI,
};
