"use strict";

const VALID_SCOPE_TYPES = new Set(["master", "agency", "client", "project", "user"]);

// Minimum required fields per scope_type.
// Optional parent IDs (tenant_id, client_id) signal the hierarchy level
// but are not mandatory — e.g. a project can live directly under master_company.
const REQUIRED_FIELDS_BY_SCOPE = {
  master: ["master_company"],
  agency: ["master_company", "tenant_id"],
  client: ["master_company", "client_id"],
  project: ["master_company", "project_id"],
  user: ["master_company", "user_id"],
};

// Optional parent IDs: if the caller includes them they must be non-empty.
const OPTIONAL_PARENT_IDS = ["tenant_id", "client_id", "project_id", "user_id"];

function safeJsonParse(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return value;
  const text = String(value).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => String(role || "").trim())
    .filter((role) => role.length > 0);
}

function parseHierarchyContext(req) {
  if (!req) return null;
  const headers = req.headers || {};
  const body = req.body || {};

  const headerValue = headers["x-hierarchy-context"] || headers["X-Hierarchy-Context"];
  const fromHeader = safeJsonParse(headerValue);
  const fromBody = body && typeof body === "object" ? body.hierarchy_context || body.hierarchyContext : null;

  const raw = fromHeader || fromBody;
  if (!raw || typeof raw !== "object") return null;

  const scopeType = String(raw.scope_type || "").trim();
  const scopeId = String(raw.scope_id || "").trim();
  if (!VALID_SCOPE_TYPES.has(scopeType) || !scopeId) return null;

  const masterCompany = raw.master_company || raw.masterCompany || null;
  const tenantId = raw.tenant_id || raw.tenant || raw.agency_id || raw.agency || null;
  const clientId = raw.client_id || raw.client || null;
  const projectId = raw.project_id || raw.project || null;
  const userId = raw.user_id || raw.user || null;

  return {
    master_company: masterCompany ? String(masterCompany) : null,
    tenant_id: tenantId ? String(tenantId) : null,
    agency_id: tenantId ? String(tenantId) : null,
    client_id: clientId ? String(clientId) : null,
    project_id: projectId ? String(projectId) : null,
    user_id: userId ? String(userId) : null,
    roles: normalizeRoles(raw.roles),
    scope_type: scopeType,
    scope_id: scopeId,
  };
}

function validateHierarchyContextForBilling(hierarchyContext) {
  if (!hierarchyContext) {
    return {
      valid: false,
      missing_fields: ["hierarchy_context"],
      message: "HierarchyContext is required for platform API billing attribution.",
    };
  }

  const requiredFields = REQUIRED_FIELDS_BY_SCOPE[hierarchyContext.scope_type] || ["master_company"];
  const missingFields = requiredFields.filter((field) => {
    const value = hierarchyContext[field];
    return value === null || value === undefined || String(value).trim() === "";
  });

  // Optional parent IDs: if provided (non-null/non-undefined) they must be non-empty.
  for (const field of OPTIONAL_PARENT_IDS) {
    if (requiredFields.includes(field)) continue;
    const value = hierarchyContext[field];
    if (value !== null && value !== undefined && String(value).trim() === "") {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    return {
      valid: false,
      missing_fields: missingFields,
      message: `HierarchyContext missing required field(s) for scope '${hierarchyContext.scope_type}': ${missingFields.join(", ")}`,
    };
  }

  return { valid: true, missing_fields: [], message: null };
}

function parseMeteringContext(req) {
  if (!req) return null;
  const headers = req.headers || {};
  const body = req.body || {};

  const headerValue = headers["x-metering-context"] || headers["X-Metering-Context"];
  const fromHeader = safeJsonParse(headerValue);
  const fromBody = body && typeof body === "object" ? body.metering_context || body.meteringContext : null;

  const raw = fromHeader || fromBody;
  if (!raw || typeof raw !== "object") return null;

  return {
    caller_module: raw.caller_module ? String(raw.caller_module) : null,
    operation_id: raw.operation_id ? String(raw.operation_id) : null,
    request_purpose: raw.request_purpose ? String(raw.request_purpose) : null,
    cost_accounting_required: Boolean(raw.cost_accounting_required),
  };
}

function resolveTraceId(req) {
  if (!req) return null;
  const headers = req.headers || {};
  const value = headers["x-trace-id"] || headers["X-Trace-Id"] || headers["traceparent"];
  const text = value ? String(value).trim() : "";
  return text || null;
}

function resolveMode(env = process.env) {
  const value = String(env.LLMPROXY_MODE || "standalone").toLowerCase().trim();
  return value === "platform" ? "platform" : "standalone";
}

function buildHierarchyContextRequiredError(traceId) {
  return {
    error: {
      code: "HIERARCHY_CONTEXT_REQUIRED",
      message: "HierarchyContext is required in platform mode. Provide X-Hierarchy-Context header or hierarchy_context in body with valid scope_type and scope_id.",
      trace_id: traceId || null,
    },
  };
}

function buildHierarchyContextInvalidError(traceId, validationResult) {
  return {
    error: {
      code: "HIERARCHY_CONTEXT_INVALID",
      message: validationResult?.message || "HierarchyContext is invalid for platform API billing attribution.",
      missing_fields: Array.isArray(validationResult?.missing_fields) ? validationResult.missing_fields : [],
      trace_id: traceId || null,
    },
  };
}

module.exports = {
  parseHierarchyContext,
  validateHierarchyContextForBilling,
  parseMeteringContext,
  resolveTraceId,
  resolveMode,
  buildHierarchyContextRequiredError,
  buildHierarchyContextInvalidError,
  VALID_SCOPE_TYPES: Array.from(VALID_SCOPE_TYPES),
};
