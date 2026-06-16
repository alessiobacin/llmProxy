"use strict";

function truthyEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isSharedProviderRegistryEnabled(env = process.env) {
  return truthyEnv(env.LLMPROXY_SHARED_PROVIDER_REGISTRY);
}

function resolveScopedProviderUser(env = process.env, osModule) {
  const explicit = String(env.LLMPROXY_SCOPE_USER || env.LLMPROXY_LOCAL_USER || "").trim();
  if (explicit) return explicit;
  try {
    const os = osModule || require("node:os");
    return String(os.userInfo().username || "").trim();
  } catch {
    return String(env.USER || env.LOGNAME || "").trim();
  }
}

function pickCredentialValue(credentials = {}) {
  return String(
    credentials.access_token
      || credentials.api_key
      || credentials.token
      || "",
  ).trim();
}

function normalizeProviderView(entry) {
  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const accessToken = pickCredentialValue(entry.credentials || {});
  const providerKind = String(entry.provider || "copilot").toLowerCase();
  const authType = String(metadata.auth_type || (providerKind === "copilot" ? "oauth" : "api_key")).toLowerCase();
  const tokenType = String(metadata.token_type || (authType === "api_key" ? "api_key" : "bearer"));
  const provider = {
    id: String(entry.provider || "").trim(),
    name: String(metadata.name || entry.provider || "").trim(),
    provider: providerKind,
    auth_type: authType,
    access_token: accessToken,
    token_type: tokenType,
    scope: String(metadata.scope || (authType === "api_key" ? "api_key" : "read:user")),
    default_model: entry.default_model ? String(entry.default_model).trim() : "",
    endpoint_variant: metadata.endpoint_variant ? String(metadata.endpoint_variant).trim() : "",
    created_at: entry.created_at ? Date.parse(entry.created_at) || Date.now() : Date.now(),
    updated_at: entry.updated_at ? Date.parse(entry.updated_at) || Date.now() : Date.now(),
    priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 100,
  };
  if (metadata.vision === true || metadata.vision === false) {
    provider.vision = metadata.vision;
  }
  return provider;
}

function createSharedProviderStore({ providerRegistry, scopeUser, providerNameResolver } = {}) {
  if (!providerRegistry) throw new Error("providerRegistry is required");
  const scopeId = String(scopeUser || "").trim();
  if (!scopeId) throw new Error("scopeUser is required");
  const resolveName = typeof providerNameResolver === "function"
    ? providerNameResolver
    : (providerId) => String(providerId || "").trim();

  function listEntries() {
    if (typeof providerRegistry.listResolved !== "function") {
      throw new Error("providerRegistry.listResolved is required");
    }
    return providerRegistry
      .listResolved({ scope_type: "user", scope_id: scopeId })
      .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100) || String(a.provider).localeCompare(String(b.provider)));
  }

  function listProviders() {
    return listEntries().map(normalizeProviderView);
  }

  function getProvider(providerId) {
    const targetId = String(providerId || "").trim();
    if (!targetId) return null;
    const entry = listEntries().find((candidate) => String(candidate.provider || "").trim() === targetId);
    return entry ? normalizeProviderView(entry) : null;
  }

  function saveProvider(providerId, data, metadata = {}) {
    const targetId = String(providerId || "").trim();
    if (!targetId) throw new Error("Provider id richiesto");
    const existing = getProvider(targetId);
    const currentEntries = listEntries();
    const nextPriority = existing?.priority || (currentEntries.length + 1);
    const nextVision = Object.prototype.hasOwnProperty.call(data || {}, "vision")
      ? data.vision
      : existing?.vision;
    const nextMetadata = {
      name: String(metadata.name || data?.name || existing?.name || resolveName(targetId)),
      auth_type: String(data?.auth_type || existing?.auth_type || (targetId === "copilot" ? "oauth" : "api_key")),
      token_type: String(data?.token_type || existing?.token_type || ((data?.auth_type || existing?.auth_type) === "api_key" ? "api_key" : "bearer")),
      scope: String(data?.scope || existing?.scope || ((data?.auth_type || existing?.auth_type) === "api_key" ? "api_key" : "read:user")),
      endpoint_variant: String(data?.endpoint_variant || existing?.endpoint_variant || ""),
    };
    if (nextVision === true || nextVision === false) {
      nextMetadata.vision = nextVision;
    }
    providerRegistry.upsert({
      provider: targetId,
      scope_type: "user",
      scope_id: scopeId,
      default_model: data?.default_model ? String(data.default_model).trim() : (existing?.default_model || null),
      priority: nextPriority,
      credentials: {
        access_token: String(data?.access_token || existing?.access_token || "").trim(),
      },
      metadata: nextMetadata,
    });
    return getProvider(targetId);
  }

  function setProviderOrder(providerIds) {
    const order = Array.isArray(providerIds)
      ? providerIds.map((id) => String(id || "").trim()).filter((id) => id.length > 0)
      : [];
    const providers = listProviders();
    const orderedIds = [];
    for (const providerId of order) {
      if (providers.some((provider) => provider.id === providerId) && !orderedIds.includes(providerId)) {
        orderedIds.push(providerId);
      }
    }
    for (const provider of providers) {
      if (!orderedIds.includes(provider.id)) orderedIds.push(provider.id);
    }
    orderedIds.forEach((providerId, index) => {
      const current = getProvider(providerId);
      providerRegistry.upsert({
        provider: providerId,
        scope_type: "user",
        scope_id: scopeId,
        default_model: current?.default_model || null,
        priority: index + 1,
        credentials: {
          access_token: String(current?.access_token || "").trim(),
        },
        metadata: {
          name: String(current?.name || resolveName(providerId)),
          auth_type: String(current?.auth_type || (providerId === "copilot" ? "oauth" : "api_key")),
          token_type: String(current?.token_type || ((current?.auth_type || "") === "api_key" ? "api_key" : "bearer")),
          scope: String(current?.scope || ((current?.auth_type || "") === "api_key" ? "api_key" : "read:user")),
          endpoint_variant: String(current?.endpoint_variant || ""),
          ...(current && (current.vision === true || current.vision === false) ? { vision: current.vision } : {}),
        },
      });
    });
    return listProviders();
  }

  function moveProvider(providerId, position) {
    const targetId = String(providerId || "").trim();
    const order = listProviders().map((provider) => provider.id);
    const currentIndex = order.indexOf(targetId);
    if (currentIndex === -1) throw new Error(`Provider non trovato: ${targetId}`);
    const targetIndex = Math.max(0, Math.min(order.length - 1, (Number(position) || 1) - 1));
    order.splice(currentIndex, 1);
    order.splice(targetIndex, 0, targetId);
    return setProviderOrder(order);
  }

  function renameProvider(providerId, nextName) {
    const targetId = String(providerId || "").trim();
    const normalizedName = String(nextName || "").trim();
    if (!targetId) throw new Error("Provider id richiesto");
    if (!normalizedName) throw new Error("Provider name richiesto");
    const existing = getProvider(targetId);
    if (!existing) throw new Error(`Provider non trovato: ${targetId}`);
    return saveProvider(targetId, existing, { name: normalizedName });
  }

  function clearProvider(providerId) {
    const targetId = String(providerId || "").trim();
    if (!targetId) return null;
    providerRegistry.remove(`user:${scopeId}:${targetId}`);
    return listProviders();
  }

  function getAccessToken(providerId) {
    if (providerId) return getProvider(providerId)?.access_token || null;
    return listProviders()[0]?.access_token || null;
  }

  return {
    listProviders,
    getProvider,
    saveProvider,
    setProviderOrder,
    moveProvider,
    renameProvider,
    clearProvider,
    getAccessToken,
    scopeUser: scopeId,
  };
}

module.exports = {
  isSharedProviderRegistryEnabled,
  resolveScopedProviderUser,
  createSharedProviderStore,
};
