// Gateway transport service — provider selection and proxy execution.
// Wraps the existing JS copilot-proxy.js behind a typed seam.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const copilotProxy: any = require("../../../copilot-proxy");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providerRegistryModule: any = require("../../../provider-registry");

const proxyAnthropicRequest = copilotProxy.proxyAnthropicRequest;
const API_KEY_PROVIDER_CONFIGS = copilotProxy.API_KEY_PROVIDER_CONFIGS;
const SUPPORTED_PROVIDERS = providerRegistryModule.SUPPORTED_PROVIDERS;

const IMPLEMENTED_API_KEY_PROVIDERS = new Set<string>(Object.keys(API_KEY_PROVIDER_CONFIGS));

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

interface ProviderSelection {
  provider: string;
  defaultModel: string | null;
  source: string;
  providerCandidates?: Record<string, unknown>[];
}

interface LocalProviderEntry {
  id?: string;
  provider?: string;
  default_model?: string;
  access_token?: string;
  auth_type?: string;
  token_type?: string;
  scope?: string;
  endpoint_variant?: string;
  vision?: boolean;
  free_model?: boolean;
  proxy_rotation?: boolean;
  proxy_order?: string[];
  proxy_url?: string;
  proxy_api_key?: string;
  name?: string;
}

interface ProviderSelectionError {
  error: {
    status: number;
    body: {
      code: string;
      message: string;
      trace_id: string | null;
    };
  };
}

interface MeteringContext {
  caller_module: string | null;
  operation_id: string | null;
  request_purpose: string | null;
  cost_accounting_required: boolean;
  custom_dimensions: Record<string, unknown> | null;
}

interface GatewayRequestParams {
  anthropicBody: Record<string, unknown>;
  req: unknown;
  res: unknown;
  requestId: string;
  traceId: string | null;
  hierarchyContext: HierarchyContext | null;
  meteringContext: MeteringContext | null;
  meteringSink: unknown;
  eventBusSink: unknown;
  provider: string;
  projectName: string | null;
  configuredModel: string | null;
  inlineMetering?: boolean | null;
  inlineInferenceInfo?: boolean | null;
  tokenStore: unknown;
  logger: unknown;
  fetchFn: typeof fetch;
  endpointPreferences: unknown;
  availableModels: string[];
  providerCandidates?: Record<string, unknown>[] | null;
  proxyRegistryFile?: string;
}

// ---------- provider selection ----------

/**
 * Extract an explicit provider from a `model@provider` label, e.g.
 * "deepseek-v4-flash-free@opencode-bacin" -> { model, provider }.
 * Returns provider === null when no `@provider` suffix is present.
 */
function parseProviderModelAtLabel(value: unknown): { model: string; provider: string | null } {
  const raw = String(value || "").trim();
  const atIndex = raw.lastIndexOf("@");
  if (atIndex < 0) {
    return { model: raw, provider: null };
  }
  return {
    model: raw.slice(0, atIndex).trim(),
    provider: raw.slice(atIndex + 1).trim(),
  };
}

function resolveProviderSelection({
  requestedProvider,
  requestedModel,
  hierarchyContext,
  traceId,
  tokenStore,
  providerRegistry,
}: {
  requestedProvider: string;
  requestedModel?: string | null;
  hierarchyContext: HierarchyContext | null;
  traceId: string | null;
  tokenStore: unknown;
  providerRegistry: unknown;
}): ProviderSelection | ProviderSelectionError {
  const provider = requestedProvider && requestedProvider !== "auto" ? requestedProvider : null;
  const localTokenStore = tokenStore as {
    getProvider?: (id: string) => LocalProviderEntry | null;
    listProviders?: () => LocalProviderEntry[];
  };

  if (provider) {
    const exactLocalProvider = localTokenStore.getProvider?.(provider);
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
      defaultModel: requestedModel && requestedModel.trim() ? requestedModel.trim() : (localProvider.default_model || null),
      source: "local",
    };
  }

  const resolved = (providerRegistry as {
    resolveCandidates: (hc: HierarchyContext | null, req: string) => Array<{
      provider: string;
      default_model?: string;
      credentials?: Record<string, string>;
      metadata?: Record<string, unknown>;
      priority?: number;
    }>;
  }).resolveCandidates(hierarchyContext, requestedProvider);

  if (resolved.length > 0) {
    const implementedCandidates = resolved.filter((entry) => entry.provider === "copilot" || IMPLEMENTED_API_KEY_PROVIDERS.has(entry.provider));
    const firstCandidate = implementedCandidates[0];
    if (!firstCandidate) {
      return {
        error: {
          status: 501,
          body: {
            code: "PROVIDER_NOT_IMPLEMENTED",
            message: `provider adapter not implemented yet: ${resolved[0]!.provider}`,
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
          id: String((entry as { id?: string }).id || entry.provider),
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

async function executeGatewayRequest(params: GatewayRequestParams): Promise<void> {
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

export {
  parseProviderModelAtLabel,
  resolveProviderSelection,
  executeGatewayRequest,
  SUPPORTED_PROVIDERS,
  IMPLEMENTED_API_KEY_PROVIDERS,
};

export type {
  HierarchyContext,
  MeteringContext,
  ProviderSelection,
  ProviderSelectionError,
  GatewayRequestParams,
};
