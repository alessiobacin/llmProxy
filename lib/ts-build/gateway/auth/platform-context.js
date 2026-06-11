"use strict";
// V11 platform-context — auth, tenancy, and hierarchy enforcement.
// Strict TypeScript replacement for the old platform-context.js.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOperatorOrAbove = exports.isAdmin = exports.buildEventBusHierarchyContext = exports.buildHierarchyContextInvalidError = exports.buildHierarchyContextRequiredError = exports.resolveMode = exports.resolveTraceId = exports.parseMeteringContext = exports.validateHierarchyContextForBilling = exports.parseHierarchyContext = exports.V11_OPERATOR_ROLES = exports.V11_ADMIN_ROLES = exports.VALID_SCOPE_TYPES = void 0;
const VALID_SCOPE_TYPES = new Set(["master", "agency", "client", "project", "user"]);
exports.VALID_SCOPE_TYPES = VALID_SCOPE_TYPES;
// V11-compliant role set
const V11_ADMIN_ROLES = new Set([
    "tenant_admin",
    "platform_admin",
    "platform_support",
]);
exports.V11_ADMIN_ROLES = V11_ADMIN_ROLES;
const V11_OPERATOR_ROLES = new Set([
    "tenant_admin",
    "tenant_operator",
    "platform_admin",
    "platform_support",
]);
exports.V11_OPERATOR_ROLES = V11_OPERATOR_ROLES;
// Legacy roles accepted during migration; mapped to V11 equivalents where possible.
const LEGACY_ADMIN_ROLES = new Set(["admin", "owner"]);
// ---------- helpers ----------
function safeJsonParse(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === "object")
        return value;
    const text = String(value).trim();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function normalizeRoles(roles) {
    if (!Array.isArray(roles))
        return [];
    return roles
        .map((role) => String(role ?? "").trim())
        .filter((role) => role.length > 0);
}
function hasField(hierarchyContext, field) {
    const v = hierarchyContext[field];
    return v !== null && v !== undefined && String(v).trim() !== "";
}
function hasAnyRole(roles, allowed) {
    return roles.some((r) => allowed.has(r.toLowerCase()));
}
// ---------- V11 hierarchy validation ----------
function validateHierarchyContextForBilling(hierarchyContext) {
    if (!hierarchyContext) {
        return {
            valid: false,
            missing_fields: ["hierarchy_context"],
            message: "HierarchyContext is required for platform API billing attribution.",
        };
    }
    const missingFields = [];
    const hc = hierarchyContext;
    if (!hasField(hc, "master_company"))
        missingFields.push("master_company");
    if (!hasField(hc, "project_id"))
        missingFields.push("project_id");
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
exports.validateHierarchyContextForBilling = validateHierarchyContextForBilling;
// ---------- role authorization ----------
function isAdmin(hierarchyContext) {
    if (!hierarchyContext)
        return false;
    const roles = hierarchyContext.roles.map((r) => r.toLowerCase());
    return hasAnyRole(roles, V11_ADMIN_ROLES) || hasAnyRole(roles, LEGACY_ADMIN_ROLES);
}
exports.isAdmin = isAdmin;
function isOperatorOrAbove(hierarchyContext) {
    if (!hierarchyContext)
        return false;
    const roles = hierarchyContext.roles.map((r) => r.toLowerCase());
    return hasAnyRole(roles, V11_OPERATOR_ROLES) || hasAnyRole(roles, LEGACY_ADMIN_ROLES);
}
exports.isOperatorOrAbove = isOperatorOrAbove;
// ---------- context parsing ----------
function parseHierarchyContext(req) {
    if (!req)
        return null;
    const headers = (req.headers ?? {});
    const body = (req.body ?? {});
    const headerValue = headers["x-hierarchy-context"] ?? headers["X-Hierarchy-Context"];
    const fromHeader = safeJsonParse(headerValue);
    const fromBody = body && typeof body === "object"
        ? (body.hierarchy_context ?? body.hierarchyContext)
        : null;
    const raw = (fromHeader || fromBody);
    if (!raw || typeof raw !== "object")
        return null;
    const scopeType = String(raw.scope_type ?? "").trim();
    const scopeId = String(raw.scope_id ?? "").trim();
    if (!VALID_SCOPE_TYPES.has(scopeType) || !scopeId)
        return null;
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
exports.parseHierarchyContext = parseHierarchyContext;
function parseMeteringContext(req) {
    if (!req)
        return null;
    const headers = (req.headers ?? {});
    const body = (req.body ?? {});
    const headerValue = headers["x-metering-context"] ?? headers["X-Metering-Context"];
    const fromHeader = safeJsonParse(headerValue);
    const fromBody = body && typeof body === "object"
        ? (body.metering_context ?? body.meteringContext)
        : null;
    const raw = (fromHeader || fromBody);
    if (!raw || typeof raw !== "object")
        return null;
    const customDimensions = raw.custom_dimensions ?? raw.customDimensions ?? raw.attributes;
    return {
        caller_module: raw.caller_module ? String(raw.caller_module) : null,
        operation_id: raw.operation_id ? String(raw.operation_id) : null,
        request_purpose: raw.request_purpose ? String(raw.request_purpose) : null,
        cost_accounting_required: Boolean(raw.cost_accounting_required),
        custom_dimensions: customDimensions && typeof customDimensions === "object" && !Array.isArray(customDimensions)
            ? customDimensions
            : null,
    };
}
exports.parseMeteringContext = parseMeteringContext;
function resolveTraceId(req) {
    if (!req)
        return null;
    const headers = (req.headers ?? {});
    const value = headers["x-trace-id"] ?? headers["X-Trace-Id"] ?? headers["traceparent"];
    const text = value ? String(value).trim() : "";
    return text || null;
}
exports.resolveTraceId = resolveTraceId;
function resolveMode(env) {
    const e = env ?? process.env;
    const value = String(e.LLMPROXY_MODE ?? "standalone").toLowerCase().trim();
    return value === "platform" ? "platform" : "standalone";
}
exports.resolveMode = resolveMode;
function buildHierarchyContextRequiredError(traceId) {
    return {
        error: {
            code: "HIERARCHY_CONTEXT_REQUIRED",
            message: "HierarchyContext is required in platform mode. Provide X-Hierarchy-Context header or hierarchy_context in body with valid scope_type and scope_id.",
            trace_id: traceId ?? null,
        },
    };
}
exports.buildHierarchyContextRequiredError = buildHierarchyContextRequiredError;
function buildHierarchyContextInvalidError(traceId, validationResult) {
    return {
        error: {
            code: "HIERARCHY_CONTEXT_INVALID",
            message: validationResult?.message || "HierarchyContext is invalid for platform API billing attribution.",
            missing_fields: Array.isArray(validationResult?.missing_fields) ? validationResult.missing_fields : [],
            trace_id: traceId ?? null,
        },
    };
}
exports.buildHierarchyContextInvalidError = buildHierarchyContextInvalidError;
function buildEventBusHierarchyContext(hc) {
    if (!hc) {
        throw new Error("HIERARCHY_CONTEXT_MISSING_TENANT: tenant_id is required for event-bus publication");
    }
    const tenantId = hc.tenant_id || hc.tenantId || hc.agency_id || hc.agency || null;
    if (!tenantId) {
        throw new Error("HIERARCHY_CONTEXT_MISSING_TENANT: tenant_id is required for event-bus publication");
    }
    const result = { tenantId };
    if (hc.client_id || hc.clientId)
        result.clientId = String(hc.client_id || hc.clientId);
    if (hc.project_id || hc.projectId)
        result.projectId = String(hc.project_id || hc.projectId);
    if (hc.master_company || hc.masterCompany)
        result.masterCompany = String(hc.master_company || hc.masterCompany);
    if (hc.user_id || hc.userId)
        result.userId = String(hc.user_id || hc.userId);
    if (hc.scope_type || hc.scopeType)
        result.scopeType = String(hc.scope_type || hc.scopeType);
    if (hc.scope_id || hc.scopeId)
        result.scopeId = String(hc.scope_id || hc.scopeId);
    return result;
}
exports.buildEventBusHierarchyContext = buildEventBusHierarchyContext;
