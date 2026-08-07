"use strict";
// Gateway transport service — provider selection and proxy execution.
// Wraps the existing JS copilot-proxy.js behind a typed seam.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMPLEMENTED_API_KEY_PROVIDERS = exports.SUPPORTED_PROVIDERS = void 0;
exports.parseProviderModelAtLabel = parseProviderModelAtLabel;
exports.resolveProviderSelection = resolveProviderSelection;
exports.executeGatewayRequest = executeGatewayRequest;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const copilotProxy = require("../../../copilot-proxy");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providerRegistryModule = require("../../../provider-registry");
const proxyAnthropicRequest = copilotProxy.proxyAnthropicRequest;
const API_KEY_PROVIDER_CONFIGS = copilotProxy.API_KEY_PROVIDER_CONFIGS;
const SUPPORTED_PROVIDERS = providerRegistryModule.SUPPORTED_PROVIDERS;
exports.SUPPORTED_PROVIDERS = SUPPORTED_PROVIDERS;
const IMPLEMENTED_API_KEY_PROVIDERS = new Set(Object.keys(API_KEY_PROVIDER_CONFIGS));
exports.IMPLEMENTED_API_KEY_PROVIDERS = IMPLEMENTED_API_KEY_PROVIDERS;
// ---------- provider selection ----------
/**
 * Extract an explicit provider from a `model@provider` label, e.g.
 * "deepseek-v4-flash-free@opencode-bacin" -> { model, provider }.
 * Returns provider === null when no `@provider` suffix is present.
 */
function normalizeProviderAlias(value) {
    return value === "openrouter-openai" ? "openrouter" : value;
}
function parseProviderModelAtLabel(value) {
    const raw = String(value || "").trim();
    const atIndex = raw.lastIndexOf("@");
    if (atIndex < 0) {
        return { model: raw, provider: null };
    }
    return {
        model: raw.slice(0, atIndex).trim(),
        provider: normalizeProviderAlias(raw.slice(atIndex + 1).trim()),
    };
}
function resolveProviderSelection({ requestedProvider, requestedModel, hierarchyContext, traceId, tokenStore, providerRegistry, }) {
    const provider = requestedProvider && requestedProvider !== "auto" ? requestedProvider : null;
    const canonicalProvider = provider ? normalizeProviderAlias(provider) : null;
    const localTokenStore = tokenStore;
    if (provider) {
        const exactLocalProvider = localTokenStore.getProvider?.(provider) || (canonicalProvider ? localTokenStore.getProvider?.(canonicalProvider) : null);
        if (exactLocalProvider?.access_token) {
            return {
                provider,
                defaultModel: requestedModel && requestedModel.trim() ? requestedModel.trim() : (exactLocalProvider.default_model || null),
                source: "local",
                providerCandidates: [{
                        id: exactLocalProvider.id || provider,
                        name: String(exactLocalProvider.name || exactLocalProvider.provider || provider),
                        provider: String(exactLocalProvider.provider || provider),
                        access_token: String(exactLocalProvider.access_token || ""),
                        auth_type: String(exactLocalProvider.auth_type || (exactLocalProvider.provider === "copilot" ? "oauth" : "api_key")),
                        token_type: String(exactLocalProvider.token_type || (exactLocalProvider.provider === "copilot" ? "bearer" : "api_key")),
                        scope: String(exactLocalProvider.scope || (exactLocalProvider.provider === "copilot" ? "read:user" : "api_key")),
                        default_model: exactLocalProvider.default_model || "",
                        endpoint_variant: String(exactLocalProvider.endpoint_variant || ""),
                        ...(exactLocalProvider.vision === true || exactLocalProvider.vision === false ? { vision: exactLocalProvider.vision } : {}),
                        ...(exactLocalProvider.free_model === true || exactLocalProvider.free_model === false ? { free_model: exactLocalProvider.free_model } : {}),
                        ...(exactLocalProvider.proxy_rotation === true || exactLocalProvider.proxy_rotation === false ? { proxy_rotation: exactLocalProvider.proxy_rotation } : {}),
                        ...(Array.isArray(exactLocalProvider.proxy_order) ? { proxy_order: exactLocalProvider.proxy_order.map((entry) => String(entry || "").trim()).filter((entry) => entry.length > 0) } : {}),
                        ...(exactLocalProvider.proxy_url ? { proxy_url: String(exactLocalProvider.proxy_url) } : {}),
                        ...(exactLocalProvider.proxy_api_key ? { proxy_api_key: String(exactLocalProvider.proxy_api_key) } : {}),
                    }],
            };
        }
    }
    if (provider && !SUPPORTED_PROVIDERS.includes(canonicalProvider || provider)) {
        const localProvider = localTokenStore.getProvider?.(provider) || (canonicalProvider ? localTokenStore.getProvider?.(canonicalProvider) : null);
        if (!localProvider) {
            return {
                error: {
                    status: 400,
                    body: {
                        code: "UNSUPPORTED_PROVIDER",
                        message: `unknown provider: ${provider}`,
                        trace_id: traceId,
                    },
                },
            };
        }
        return {
            provider,
            defaultModel: requestedModel && requestedModel.trim() ? requestedModel.trim() : (localProvider.default_model || null),
            source: "local",
        };
    }
    const resolved = providerRegistry.resolveCandidates(hierarchyContext, requestedProvider);
    if (resolved.length > 0) {
        const implementedCandidates = resolved.filter((entry) => entry.provider === "copilot" || IMPLEMENTED_API_KEY_PROVIDERS.has(entry.provider));
        const firstCandidate = implementedCandidates[0];
        if (!firstCandidate) {
            return {
                error: {
                    status: 501,
                    body: {
                        code: "PROVIDER_NOT_IMPLEMENTED",
                        message: `provider adapter not implemented yet: ${resolved[0].provider}`,
                        trace_id: traceId,
                    },
                },
            };
        }
        return {
            provider: provider && provider !== "auto" ? firstCandidate.provider : "auto",
            defaultModel: requestedModel && requestedModel.trim() ? requestedModel.trim() : (firstCandidate.default_model || null),
            source: "registry",
            providerCandidates: implementedCandidates.map((entry) => {
                const authType = String(entry.metadata?.auth_type || (entry.provider === "copilot" ? "oauth" : "api_key"));
                return {
                    id: String(entry.id || entry.provider),
                    name: String(entry.metadata?.name || entry.provider),
                    provider: entry.provider,
                    access_token: String(entry.credentials?.access_token || entry.credentials?.api_key || ""),
                    auth_type: authType,
                    token_type: String(entry.metadata?.token_type || (authType === "api_key" ? "api_key" : "bearer")),
                    scope: String(entry.metadata?.scope || (authType === "api_key" ? "api_key" : "read:user")),
                    default_model: entry.default_model || "",
                    endpoint_variant: entry.metadata?.endpoint_variant ? String(entry.metadata.endpoint_variant) : "",
                    ...(entry.metadata?.vision === true || entry.metadata?.vision === false ? { vision: entry.metadata.vision } : {}),
                    ...(entry.metadata?.free_model === true || entry.metadata?.free_model === false ? { free_model: entry.metadata.free_model } : {}),
                    ...(entry.metadata?.proxy_url ? { proxy_url: String(entry.metadata.proxy_url) } : {}),
                    ...(entry.metadata?.proxy_api_key ? { proxy_api_key: String(entry.metadata.proxy_api_key) } : {}),
                };
            }),
        };
    }
    if (provider && provider !== "copilot" && !IMPLEMENTED_API_KEY_PROVIDERS.has(provider)) {
        return {
            error: {
                status: 501,
                body: {
                    code: "PROVIDER_NOT_IMPLEMENTED",
                    message: `provider adapter not implemented yet: ${provider}`,
                    trace_id: traceId,
                },
            },
        };
    }
    // Fallback: use token store providers when registry is empty
    const tokenStoreProviders = localTokenStore.listProviders?.();
    if (Array.isArray(tokenStoreProviders) && tokenStoreProviders.length > 0) {
        const validProviders = tokenStoreProviders.filter((p) => p && p.access_token && !p.disabled);
        if (validProviders.length > 0) {
            // Sort by registry order (user-defined priority) before picking first
            const providerOrder = localTokenStore.getProviderOrder?.() ?? [];
            if (providerOrder.length > 0) {
                validProviders.sort((a, b) => {
                    const aId = a.id || "";
                    const bId = b.id || "";
                    const aIdx = providerOrder.indexOf(aId);
                    const bIdx = providerOrder.indexOf(bId);
                    const aPos = aIdx === -1 ? Number.MAX_SAFE_INTEGER : aIdx;
                    const bPos = bIdx === -1 ? Number.MAX_SAFE_INTEGER : bIdx;
                    return aPos - bPos;
                });
            }
            const first = validProviders[0];
            return {
                provider: provider && provider !== "auto" ? provider : "auto",
                defaultModel: requestedModel && requestedModel.trim() ? requestedModel.trim() : (first.default_model || null),
                source: "token-store",
                providerCandidates: validProviders.map((p) => ({
                    id: p.id || p.provider || "unknown",
                    name: String(p.name || p.provider || "unknown"),
                    provider: String(p.provider || "copilot"),
                    access_token: String(p.access_token || ""),
                    auth_type: String(p.auth_type || (p.provider === "copilot" ? "oauth" : "api_key")),
                    token_type: String(p.token_type || (p.provider === "copilot" ? "bearer" : "api_key")),
                    scope: String(p.scope || (p.provider === "copilot" ? "read:user" : "api_key")),
                    default_model: p.default_model || "",
                    endpoint_variant: String(p.endpoint_variant || ""),
                    ...(p.vision === true || p.vision === false ? { vision: p.vision } : {}),
                    ...(p.free_model === true || p.free_model === false ? { free_model: p.free_model } : {}),
                    ...(p.proxy_rotation === true || p.proxy_rotation === false ? { proxy_rotation: p.proxy_rotation } : {}),
                    ...(p.proxy_url ? { proxy_url: String(p.proxy_url) } : {}),
                    ...(p.proxy_api_key ? { proxy_api_key: String(p.proxy_api_key) } : {}),
                })),
            };
        }
    }
    return {
        provider: provider && provider !== "auto" ? provider : "copilot",
        defaultModel: null,
        source: "default",
    };
}
// ---------- proxy execution ----------
async function executeGatewayRequest(params) {
    await proxyAnthropicRequest({
        anthropicBody: params.anthropicBody,
        req: params.req,
        res: params.res,
        requestId: params.requestId,
        traceId: params.traceId,
        hierarchyContext: params.hierarchyContext,
        meteringContext: params.meteringContext,
        meteringSink: params.meteringSink,
        eventBusSink: params.eventBusSink,
        provider: params.provider,
        projectName: params.projectName,
        configuredModel: params.configuredModel,
        inlineMetering: params.inlineMetering,
        inlineInferenceInfo: params.inlineInferenceInfo,
        tokenStore: params.tokenStore,
        logger: params.logger,
        fetchFn: params.fetchFn,
        endpointPreferences: params.endpointPreferences,
        availableModels: params.availableModels,
        providerCandidates: params.providerCandidates,
        proxyRegistryFile: params.proxyRegistryFile,
    });
}
