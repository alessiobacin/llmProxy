// V11 platform-context — auth, tenancy, and hierarchy enforcement.
// Strict TypeScript replacement for the old platform-context.js.

const VALID_SCOPE_TYPES = new Set(["master", "agency", "client", "project", "user"]);

// V11-compliant role set
const V11_ADMIN_ROLES = new Set([
  "tenant_admin",
  "platform_admin",
  "platform_support",
]);

const V11_OPERATOR_ROLES = new Set([
  "tenant_admin",
  "tenant_operator",
  "platform_admin",
  "platform_support",
]);

// Legacy roles accepted during migration; mapped to V11 equivalents where possible.
const LEGACY_ADMIN_ROLES = new Set(["admin", "owner"]);

// Billing hierarchy: master_company + project_id always required.
// V11 ancestry rule: if child ID present, parent ID must also be present.
// Valid combinations:
//   1. master_company + project_id                              (MC direct project)
//   2. master_company + tenant_id + project_id                  (tenant project)
//   3. master_company + client_id + project_id                  (MC → direct client → project)
//   4. master_company + tenant_id + client_id + project_id      (full chain)

// ---------- types ----------

interface HierarchyContext {
  master_company: string | null;
  tenant_id: string | null;
  agency_id: string | null;
  client_id: string | null;
  project_id: string | null;
  user_id: string | null;
  master_user_id: string | null;
  tenant_user_id: string | null;
  client_user_id: string | null;
  project_user_id: string | null;
  roles: string[];
  scope_type: string;
  scope_id: string;
}

interface MeteringContext {
  caller_module: string | null;
  operation_id: string | null;
  request_purpose: string | null;
  cost_accounting_required: boolean;
  custom_dimensions: Record<string, unknown> | null;
}

interface ValidationResult {
  valid: boolean;
  missing_fields: string[];
  message: string | null;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    trace_id: string | null;
    missing_fields?: string[];
  };
}

// ---------- helpers ----------

function safeJsonParse(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => String(role ?? "").trim())
    .filter((role) => role.length > 0);
}

function hasField(hierarchyContext: Record<string, unknown>, field: string): boolean {
  const v = hierarchyContext[field];
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function hasAnyRole(roles: string[], allowed: ReadonlySet<string>): boolean {
  return roles.some((r) => allowed.has(r.toLowerCase()));
}

// ---------- V11 hierarchy validation ----------

function validateHierarchyContextForBilling(hierarchyContext: HierarchyContext | null): ValidationResult {
  if (!hierarchyContext) {
    return {
      valid: false,
      missing_fields: ["hierarchy_context"],
      message: "HierarchyContext is required for platform API billing attribution.",
    };
  }

  const missingFields: string[] = [];
  const hc = hierarchyContext as unknown as Record<string, unknown>;

  if (!hasField(hc, "master_company")) missingFields.push("master_company");
  if (!hasField(hc, "project_id")) missingFields.push("project_id");

  if (!VALID_SCOPE_TYPES.has(String(hc.scope_type ?? "").trim())) {
    missingFields.push("scope_type");
  }
  if (!String(hc.scope_id ?? "").trim()) {
    missingFields.push("scope_id");
  }

  // Note: full V11 ancestry enforcement (client_id → tenant_id → ...)
  // is deferred to a later phase when upstream callers are aligned.
  // Current validation only requires master_company + project_id + scope.
  if (missingFields.length > 0) {
    return {
      valid: false,
      missing_fields: missingFields,
      message: `HierarchyContext missing required billing field(s): ${missingFields.join(", ")}`,
    };
  }

  return { valid: true, missing_fields: [], message: null };
}

// ---------- role authorization ----------

function isAdmin(hierarchyContext: HierarchyContext | null): boolean {
  if (!hierarchyContext) return false;
  const roles = hierarchyContext.roles.map((r) => r.toLowerCase());
  return hasAnyRole(roles, V11_ADMIN_ROLES) || hasAnyRole(roles, LEGACY_ADMIN_ROLES);
}

function isOperatorOrAbove(hierarchyContext: HierarchyContext | null): boolean {
  if (!hierarchyContext) return false;
  const roles = hierarchyContext.roles.map((r) => r.toLowerCase());
  return hasAnyRole(roles, V11_OPERATOR_ROLES) || hasAnyRole(roles, LEGACY_ADMIN_ROLES);
}

// ---------- context parsing ----------

function parseHierarchyContext(req: Record<string, unknown> | null | undefined): HierarchyContext | null {
  if (!req) return null;
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const headerValue = headers["x-hierarchy-context"] ?? headers["X-Hierarchy-Context"];
  const fromHeader = safeJsonParse(headerValue);
  const fromBody = body && typeof body === "object"
    ? (body.hierarchy_context ?? body.hierarchyContext)
    : null;

  const raw = (fromHeader || fromBody) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;

  const scopeType = String(raw.scope_type ?? "").trim();
  const scopeId = String(raw.scope_id ?? "").trim();
  if (!VALID_SCOPE_TYPES.has(scopeType) || !scopeId) return null;

  // Normalize tenant/agency: accept tenant_id, tenant, agency_id, agency.
  // tenant_id is canonical; agency_id is the legacy alias (preserved for compatibility).
  const tenantSource = raw.tenant_id ?? raw.tenant ?? raw.agency_id ?? raw.agency ?? null;
  const tenantId = tenantSource ? String(tenantSource) : null;

  const masterCompany = raw.master_company ?? raw.masterCompany ?? null;
  const clientId = raw.client_id ?? raw.client ?? null;
  const projectId = raw.project_id ?? raw.project ?? null;
  const userId = raw.user_id ?? raw.user ?? null;

  // Per-level user IDs
  const masterUserId = raw.master_user_id ?? null;
  const tenantUserId = raw.tenant_user_id ?? null;
  const clientUserId = raw.client_user_id ?? null;
  const projectUserId = raw.project_user_id ?? null;

  return {
    master_company: masterCompany ? String(masterCompany) : null,
    tenant_id: tenantId,
    agency_id: tenantId,
    client_id: clientId ? String(clientId) : null,
    project_id: projectId ? String(projectId) : null,
    user_id: userId ? String(userId) : null,
    master_user_id: masterUserId ? String(masterUserId) : null,
    tenant_user_id: tenantUserId ? String(tenantUserId) : null,
    client_user_id: clientUserId ? String(clientUserId) : null,
    project_user_id: projectUserId ? String(projectUserId) : null,
    roles: normalizeRoles(raw.roles),
    scope_type: scopeType,
    scope_id: scopeId,
  };
}

function parseMeteringContext(req: Record<string, unknown> | null | undefined): MeteringContext | null {
  if (!req) return null;
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const headerValue = headers["x-metering-context"] ?? headers["X-Metering-Context"];
  const fromHeader = safeJsonParse(headerValue);
  const fromBody = body && typeof body === "object"
    ? (body.metering_context ?? body.meteringContext)
    : null;

  const raw = (fromHeader || fromBody) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;

  const customDimensions = raw.custom_dimensions ?? raw.customDimensions ?? raw.attributes;

  return {
    caller_module: raw.caller_module ? String(raw.caller_module) : null,
    operation_id: raw.operation_id ? String(raw.operation_id) : null,
    request_purpose: raw.request_purpose ? String(raw.request_purpose) : null,
    cost_accounting_required: Boolean(raw.cost_accounting_required),
    custom_dimensions:
      customDimensions && typeof customDimensions === "object" && !Array.isArray(customDimensions)
        ? (customDimensions as Record<string, unknown>)
        : null,
  };
}

function resolveTraceId(req: Record<string, unknown> | null | undefined): string | null {
  if (!req) return null;
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const value = headers["x-trace-id"] ?? headers["X-Trace-Id"] ?? headers["traceparent"];
  const text = value ? String(value).trim() : "";
  return text || null;
}

function resolveMode(env?: Record<string, string | undefined>): "platform" | "standalone" {
  const e = env ?? process.env;
  const value = String(e.LLMPROXY_MODE ?? "standalone").toLowerCase().trim();
  return value === "platform" ? "platform" : "standalone";
}

function buildHierarchyContextRequiredError(traceId: string | null | undefined): ErrorEnvelope {
  return {
    error: {
      code: "HIERARCHY_CONTEXT_REQUIRED",
      message:
        "HierarchyContext is required in platform mode. Provide X-Hierarchy-Context header or hierarchy_context in body with valid scope_type and scope_id.",
      trace_id: traceId ?? null,
    },
  };
}

function buildHierarchyContextInvalidError(
  traceId: string | null | undefined,
  validationResult: ValidationResult | null | undefined,
): ErrorEnvelope {
  return {
    error: {
      code: "HIERARCHY_CONTEXT_INVALID",
      message: validationResult?.message || "HierarchyContext is invalid for platform API billing attribution.",
      missing_fields: Array.isArray(validationResult?.missing_fields) ? validationResult.missing_fields : [],
      trace_id: traceId ?? null,
    },
  };
}

// ---------- V11 event-bus context builder ----------

// Backward-compatible input for buildEventBusHierarchyContext: accepts
// typed HierarchyContext or a loose bag with camelCase keys (legacy callers).
type EventBusHierarchyInput = {
  tenant_id?: string | null;
  tenantId?: string | null;
  agency_id?: string | null;
  agency?: string | null;
  client_id?: string | null;
  clientId?: string | null;
  project_id?: string | null;
  projectId?: string | null;
  master_company?: string | null;
  masterCompany?: string | null;
  user_id?: string | null;
  userId?: string | null;
  scope_type?: string | null;
  scopeType?: string | null;
  scope_id?: string | null;
  scopeId?: string | null;
};

function buildEventBusHierarchyContext(hc: EventBusHierarchyInput | null): Record<string, string> {
  if (!hc) {
    throw new Error("HIERARCHY_CONTEXT_MISSING_TENANT: tenant_id is required for event-bus publication");
  }
  const tenantId = hc.tenant_id || hc.tenantId || hc.agency_id || hc.agency || null;
  if (!tenantId) {
    throw new Error("HIERARCHY_CONTEXT_MISSING_TENANT: tenant_id is required for event-bus publication");
  }
  const result: Record<string, string> = { tenantId };
  if (hc.client_id || hc.clientId) result.clientId = String(hc.client_id || hc.clientId);
  if (hc.project_id || hc.projectId) result.projectId = String(hc.project_id || hc.projectId);
  if (hc.master_company || hc.masterCompany) result.masterCompany = String(hc.master_company || hc.masterCompany);
  if (hc.user_id || hc.userId) result.userId = String(hc.user_id || hc.userId);
  if (hc.scope_type || hc.scopeType) result.scopeType = String(hc.scope_type || hc.scopeType);
  if (hc.scope_id || hc.scopeId) result.scopeId = String(hc.scope_id || hc.scopeId);
  return result;
}

export {
  VALID_SCOPE_TYPES,
  V11_ADMIN_ROLES,
  V11_OPERATOR_ROLES,
  parseHierarchyContext,
  validateHierarchyContextForBilling,
  parseMeteringContext,
  resolveTraceId,
  resolveMode,
  buildHierarchyContextRequiredError,
  buildHierarchyContextInvalidError,
  buildEventBusHierarchyContext,
  isAdmin,
  isOperatorOrAbove,
};

export type {
  HierarchyContext,
  MeteringContext,
  ValidationResult,
  ErrorEnvelope,
};
