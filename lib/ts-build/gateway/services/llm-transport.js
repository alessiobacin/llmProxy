"use strict";
// Gateway transport service — provider selection and proxy execution.
// Wraps the existing JS copilot-proxy.js behind a typed seam.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMPLEMENTED_API_KEY_PROVIDERS = exports.SUPPORTED_PROVIDERS = void 0;
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
function resolveProviderSelection({ requestedProvider, hierarchyContext, traceId, tokenStore, providerRegistry, }) {
    const provider = requestedProvider && requestedProvider !== "auto" ? requestedProvider : null;
    const localTokenStore = tokenStore;
    if (provider) {
        const exactLocalProvider = localTokenStore.getProvider?.(provider);
        if (exactLocalProvider?.access_token) {
            return {
                provider,
                defaultModel: exactLocalProvider.default_model || null,
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
                        ...(exactLocalProvider.proxy_url ? { proxy_url: String(exactLocalProvider.proxy_url) } : {}),
                        ...(exactLocalProvider.proxy_api_key ? { proxy_api_key: String(exactLocalProvider.proxy_api_key) } : {}),
                    }],
            };
        }
    }
    if (provider && !SUPPORTED_PROVIDERS.includes(provider)) {
        const localProvider = localTokenStore.getProvider?.(provider);
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
            defaultModel: localProvider.default_model || null,
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
            defaultModel: firstCandidate.default_model || null,
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
        creditInline: params.creditInline,
        pricePerformanceRouting: params.pricePerformanceRouting,
        pricePerformanceTieBreaker: params.pricePerformanceTieBreaker,
        tokenStore: params.tokenStore,
        logger: params.logger,
        fetchFn: params.fetchFn,
        endpointPreferences: params.endpointPreferences,
        availableModels: params.availableModels,
        providerCandidates: params.providerCandidates,
        smartRouteInfo: params.smartRouteInfo,
    });
}
