"use strict";
// V11 gateway metering attribution — record building and emission.
// Strict TypeScript replacement for the core metering logic.
// Persistence (sinks, query, stats) remains in JS for now and will be cut later.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SENSITIVE_KEYS = void 0;
exports.buildMeteringRecord = buildMeteringRecord;
exports.emitMetering = emitMetering;
exports.redactObject = redactObject;
const SENSITIVE_KEYS = new Set([
    "messages",
    "prompt",
    "system",
    "input",
    "content",
    "tools",
    "authorization",
    "api_key",
    "apiKey",
    "token",
    "access_token",
    "refresh_token",
]);
exports.SENSITIVE_KEYS = SENSITIVE_KEYS;
// ---------- redaction ----------
function redactObject(value, depth) {
    const d = depth ?? 0;
    if (value === null || value === undefined)
        return value;
    if (d > 6)
        return "[redacted-depth]";
    if (Array.isArray(value))
        return value.map((item) => redactObject(item, d + 1));
    if (typeof value !== "object")
        return value;
    const output = {};
    for (const [key, raw] of Object.entries(value)) {
        if (SENSITIVE_KEYS.has(key)) {
            output[key] = "[redacted]";
            continue;
        }
        output[key] = redactObject(raw, d + 1);
    }
    return output;
}
// ---------- record builder ----------
function buildMeteringRecord(input = {}) {
    const now = input.timestamp ?? new Date().toISOString();
    const hierarchyContext = input.hierarchyContext ?? null;
    const meteringContext = input.meteringContext ?? null;
    const customDimensions = input.customDimensions ?? meteringContext?.custom_dimensions ?? null;
    const agent = customDimensions?.agent ?? null;
    const mansione = customDimensions?.mansione ?? null;
    const taskId = customDimensions?.task_id ?? null;
    const promptTokens = typeof input.promptTokens === "number" ? input.promptTokens : null;
    const completionTokens = typeof input.completionTokens === "number" ? input.completionTokens : null;
    const totalTokens = typeof input.totalTokens === "number"
        ? input.totalTokens
        : ((promptTokens ?? 0) + (completionTokens ?? 0)) || null;
    const providerAttempts = Array.isArray(input.providerAttempts) ? input.providerAttempts : [];
    return {
        event_schema_version: "2026.1",
        event_version: 1,
        idempotency_key: input.idempotencyKey ?? input.requestId ?? null,
        timestamp: now,
        request_id: input.requestId ?? null,
        trace_id: input.traceId ?? null,
        provider: input.provider ?? null,
        provider_attempts: providerAttempts,
        fallback_count: typeof input.fallbackCount === "number"
            ? input.fallbackCount
            : Math.max(0, providerAttempts.length - 1),
        model_requested: input.modelRequested ?? null,
        model_used: input.modelUsed ?? null,
        endpoint: input.endpoint ?? null,
        duration_ms: typeof input.durationMs === "number" ? input.durationMs : null,
        success: input.success !== false,
        error_code: input.errorCode ?? null,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        tokens_input: promptTokens,
        tokens_output: completionTokens,
        master_company: hierarchyContext?.master_company ?? null,
        tenant_id: hierarchyContext?.tenant_id ?? null,
        client_id: hierarchyContext?.client_id ?? null,
        project_id: hierarchyContext?.project_id ?? null,
        user_id: hierarchyContext?.user_id ?? null,
        scope_type: hierarchyContext?.scope_type ?? null,
        scope_id: hierarchyContext?.scope_id ?? null,
        master_user_id: hierarchyContext?.master_user_id ?? null,
        tenant_user_id: hierarchyContext?.tenant_user_id ?? null,
        client_user_id: hierarchyContext?.client_user_id ?? null,
        project_user_id: hierarchyContext?.project_user_id ?? null,
        company_id: hierarchyContext?.master_company ?? null,
        caller_module: meteringContext?.caller_module ?? null,
        operation_id: meteringContext?.operation_id ?? null,
        request_purpose: meteringContext?.request_purpose ?? null,
        cost_accounting_required: Boolean(meteringContext?.cost_accounting_required),
        custom_dimensions: customDimensions,
        agent,
        mansione,
        task_id: taskId,
        hierarchy_context: hierarchyContext,
        metering_context: meteringContext,
    };
}
// ---------- emission ----------
async function emitMetering(sink, record) {
    if (!sink || typeof sink.record !== "function")
        return { ok: true, skipped: true };
    try {
        await sink.record(record);
        return { ok: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { code: "METERING_SINK_FAILED", message } };
    }
}
