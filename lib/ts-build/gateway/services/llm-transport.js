"use strict";
// Gateway transport service — provider selection and proxy execution.
// Wraps the existing JS copilot-proxy.js behind a typed seam.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IMPLEMENTED_API_KEY_PROVIDERS = exports.SUPPORTED_PROVIDERS = exports.executeGatewayRequest = exports.resolveProviderSelection = void 0;
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
    if (provider && !SUPPORTED_PROVIDERS.includes(provider)) {
        const localProvider = tokenStore.getProvider?.(provider);
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
    const resolved = providerRegistry.resolve(hierarchyContext, requestedProvider);
    if (resolved) {
        if (resolved.provider !== "copilot" && !IMPLEMENTED_API_KEY_PROVIDERS.has(resolved.provider)) {
            return {
                error: {
                    status: 501,
                    body: {
                        code: "PROVIDER_NOT_IMPLEMENTED",
                        message: `provider adapter not implemented yet: ${resolved.provider}`,
                        trace_id: traceId,
                    },
                },
            };
        }
        return {
            provider: resolved.provider,
            defaultModel: resolved.default_model || null,
            source: "registry",
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
exports.resolveProviderSelection = resolveProviderSelection;
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
        tokenStore: params.tokenStore,
        logger: params.logger,
        fetchFn: params.fetchFn,
        endpointPreferences: params.endpointPreferences,
        availableModels: params.availableModels,
        smartRouteInfo: params.smartRouteInfo,
    });
}
exports.executeGatewayRequest = executeGatewayRequest;
