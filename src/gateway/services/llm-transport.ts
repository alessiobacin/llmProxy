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
  tokenStore: unknown;
  logger: unknown;
  fetchFn: typeof fetch;
  endpointPreferences: unknown;
  availableModels: string[];
  providerCandidates?: Record<string, unknown>[] | null;
  smartRouteInfo?: Record<string, unknown> | null;
}

// ---------- provider selection ----------

function resolveProviderSelection({
  requestedProvider,
  hierarchyContext,
  traceId,
  tokenStore,
  providerRegistry,
}: {
  requestedProvider: string;
  hierarchyContext: HierarchyContext | null;
  traceId: string | null;
  tokenStore: unknown;
  providerRegistry: unknown;
}): ProviderSelection | ProviderSelectionError {
  const provider = requestedProvider && requestedProvider !== "auto" ? requestedProvider : null;

  if (provider && !SUPPORTED_PROVIDERS.includes(provider)) {
    const localProvider = (tokenStore as { getProvider?: (id: string) => { default_model?: string } | null }).getProvider?.(provider);
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
      defaultModel: firstCandidate.default_model || null,
      source: "registry",
      providerCandidates: implementedCandidates.map((entry) => {
        const authType = String(entry.metadata?.auth_type || (entry.provider === "copilot" ? "oauth" : "api_key"));
        return {
          id: entry.provider,
          name: String(entry.metadata?.name || entry.provider),
          provider: entry.provider,
          access_token: String(entry.credentials?.access_token || entry.credentials?.api_key || ""),
          auth_type: authType,
          token_type: String(entry.metadata?.token_type || (authType === "api_key" ? "api_key" : "bearer")),
          scope: String(entry.metadata?.scope || (authType === "api_key" ? "api_key" : "read:user")),
          default_model: entry.default_model || "",
          endpoint_variant: entry.metadata?.endpoint_variant ? String(entry.metadata.endpoint_variant) : "",
          ...(entry.metadata?.vision === true || entry.metadata?.vision === false ? { vision: entry.metadata.vision } : {}),
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
    tokenStore: params.tokenStore,
    logger: params.logger,
    fetchFn: params.fetchFn,
    endpointPreferences: params.endpointPreferences,
    availableModels: params.availableModels,
    providerCandidates: params.providerCandidates,
    smartRouteInfo: params.smartRouteInfo,
  });
}

export {
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
