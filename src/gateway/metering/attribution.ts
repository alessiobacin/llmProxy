// V11 gateway metering attribution — record building and emission.
// Strict TypeScript replacement for the core metering logic.
// Persistence (sinks, query, stats) remains in JS for now and will be cut later.

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

// ---------- types ----------

interface ProviderAttempt {
  provider: string | null;
  provider_kind: string | null;
  endpoint: string | null;
  status: number | null;
  success: boolean;
  duration_ms: number | null;
  requested_model: string | null;
  effective_model: string | null;
  actual_model: string | null;
  error: string | null;
}

interface HierarchyContext {
  master_company?: string | null;
  tenant_id?: string | null;
  client_id?: string | null;
  project_id?: string | null;
  user_id?: string | null;
  master_user_id?: string | null;
  tenant_user_id?: string | null;
  client_user_id?: string | null;
  project_user_id?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
}

interface MeteringContext {
  caller_module?: string | null;
  operation_id?: string | null;
  request_purpose?: string | null;
  cost_accounting_required?: boolean;
  custom_dimensions?: Record<string, unknown> | null;
}

interface MeteringRecordInput {
  idempotencyKey?: string | null;
  requestId?: string | null;
  timestamp?: string | null;
  traceId?: string | null;
  provider?: string | null;
  providerAttempts?: ProviderAttempt[];
  fallbackCount?: number;
  modelRequested?: string | null;
  modelUsed?: string | null;
  endpoint?: string | null;
  durationMs?: number | null;
  success?: boolean;
  errorCode?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  hierarchyContext?: HierarchyContext | null;
  meteringContext?: MeteringContext | null;
  customDimensions?: Record<string, unknown> | null;
}

interface MeteringRecord {
  event_schema_version: string;
  event_version: number;
  idempotency_key: string | null;
  timestamp: string;
  request_id: string | null;
  trace_id: string | null;
  provider: string | null;
  provider_attempts: ProviderAttempt[];
  fallback_count: number;
  model_requested: string | null;
  model_used: string | null;
  endpoint: string | null;
  duration_ms: number | null;
  success: boolean;
  error_code: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  master_company: string | null;
  tenant_id: string | null;
  client_id: string | null;
  project_id: string | null;
  user_id: string | null;
  scope_type: string | null;
  scope_id: string | null;
  master_user_id: string | null;
  tenant_user_id: string | null;
  client_user_id: string | null;
  project_user_id: string | null;
  company_id: string | null;
  caller_module: string | null;
  operation_id: string | null;
  request_purpose: string | null;
  cost_accounting_required: boolean;
  custom_dimensions: Record<string, unknown> | null;
  agent: string | null;
  mansione: string | null;
  task_id: string | null;
  hierarchy_context: HierarchyContext | null;
  metering_context: MeteringContext | null;
}

interface MeteringSink {
  name?: string;
  record: (rec: MeteringRecord) => Promise<void> | void;
}

interface EmitResult {
  ok: boolean;
  skipped?: boolean;
  error?: { code: string; message: string };
}

// ---------- redaction ----------

function redactObject(value: unknown, depth?: number): unknown {
  const d = depth ?? 0;
  if (value === null || value === undefined) return value;
  if (d > 6) return "[redacted-depth]";
  if (Array.isArray(value)) return value.map((item) => redactObject(item, d + 1));
  if (typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = redactObject(raw, d + 1);
  }
  return output;
}

// ---------- record builder ----------

function buildMeteringRecord(input: MeteringRecordInput = {}): MeteringRecord {
  const now = input.timestamp ?? new Date().toISOString();
  const hierarchyContext: HierarchyContext | null = input.hierarchyContext ?? null;
  const meteringContext: MeteringContext | null = input.meteringContext ?? null;
  const customDimensions: Record<string, unknown> | null =
    input.customDimensions ?? meteringContext?.custom_dimensions ?? null;

  const agent = (customDimensions?.agent as string) ?? null;
  const mansione = (customDimensions?.mansione as string) ?? null;
  const taskId = (customDimensions?.task_id as string) ?? null;

  const promptTokens = typeof input.promptTokens === "number" ? input.promptTokens : null;
  const completionTokens = typeof input.completionTokens === "number" ? input.completionTokens : null;
  const totalTokens = typeof input.totalTokens === "number"
    ? input.totalTokens
    : ((promptTokens ?? 0) + (completionTokens ?? 0)) || null;

  const providerAttempts: ProviderAttempt[] = Array.isArray(input.providerAttempts) ? input.providerAttempts : [];

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

async function emitMetering(sink: MeteringSink | null | undefined, record: MeteringRecord): Promise<EmitResult> {
  if (!sink || typeof sink.record !== "function") return { ok: true, skipped: true };
  try {
    await sink.record(record);
    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: "METERING_SINK_FAILED", message } };
  }
}

export {
  SENSITIVE_KEYS,
  buildMeteringRecord,
  emitMetering,
  redactObject,
};

export type {
  MeteringRecord,
  MeteringRecordInput,
  MeteringSink,
  ProviderAttempt,
  HierarchyContext as MeteringHierarchyContext,
  MeteringContext as MeteringMeteringContext,
  EmitResult,
};
