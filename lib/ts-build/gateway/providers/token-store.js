"use strict";
// V11 token store — local provider token/credential registry.
// This is a legacy compatibility module. Provider credentials should
// eventually be governed by auth-gateway and runtime injection.
// File persistence is injected for testability and future replacement.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTokenStore = void 0;
const DEFAULT_PROVIDER_ID = "default";
const DEFAULT_PROVIDER_NAME = "Default GitHub Copilot";
function makeFilePersistence(filePath) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    return {
        read() {
            try {
                if (!fs.existsSync(filePath))
                    return null;
                return fs.readFileSync(filePath, "utf8");
            }
            catch {
                return null;
            }
        },
        write(data) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require("node:path");
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, data);
        },
        remove() {
            try {
                fs.rmSync(filePath, { force: true });
            }
            catch {
                // ignore
            }
        },
    };
}
function normalizeProviderId(providerId) {
    return String(providerId ?? "").trim();
}
function normalizeProvider(provider, index) {
    const idx = index ?? 0;
    const id = normalizeProviderId(provider?.id) || `${DEFAULT_PROVIDER_ID}-${idx + 1}`;
    const providerKind = String(provider?.provider ?? provider?.kind ?? "copilot").toLowerCase();
    const authType = String(provider?.auth_type ?? (providerKind === "copilot" ? "oauth" : "api_key")).toLowerCase();
    return {
        id,
        name: String(provider?.name ?? (id === DEFAULT_PROVIDER_ID ? DEFAULT_PROVIDER_NAME : id)),
        provider: providerKind,
        auth_type: authType,
        access_token: String(provider?.access_token ?? ""),
        token_type: String(provider?.token_type ?? (authType === "api_key" ? "api_key" : "bearer")),
        scope: String(provider?.scope ?? "read:user"),
        default_model: provider?.default_model ? String(provider.default_model).trim() : "",
        created_at: Number(provider?.created_at) || Date.now(),
        updated_at: Number(provider?.updated_at) || Date.now(),
    };
}
function normalizeRegistry(data) {
    if (data?.access_token) {
        const provider = normalizeProvider({ ...data, id: DEFAULT_PROVIDER_ID, name: DEFAULT_PROVIDER_NAME });
        return { version: 2, providers: [provider], order: [provider.id] };
    }
    const rawProviders = Array.isArray(data?.providers) ? data.providers : [];
    const providers = [];
    const providerMap = new Map();
    rawProviders.forEach((provider, index) => {
        const normalized = normalizeProvider(provider, index);
        if (!normalized.access_token)
            return;
        providerMap.set(normalized.id, normalized);
    });
    const rawOrder = Array.isArray(data?.order)
        ? data.order.map((id) => normalizeProviderId(id)).filter((id) => id.length > 0)
        : [];
    const orderedIds = [];
    for (const id of rawOrder) {
        if (providerMap.has(id) && !orderedIds.includes(id))
            orderedIds.push(id);
    }
    for (const id of providerMap.keys()) {
        if (!orderedIds.includes(id))
            orderedIds.push(id);
    }
    for (const id of orderedIds) {
        providers.push(providerMap.get(id));
    }
    return {
        version: 2,
        providers,
        order: providers.map((p) => p.id),
    };
}
function createTokenStore(options = {}) {
    const persistence = options.persistence || makeFilePersistence(options.filePath || "copilot-token.json");
    const filePath = options.filePath || "copilot-token.json";
    function persistRegistry(registry) {
        persistence.write(JSON.stringify(registry, null, 2));
        return registry;
    }
    function loadRegistry() {
        const raw = persistence.read();
        if (!raw)
            return normalizeRegistry(null);
        try {
            return normalizeRegistry(JSON.parse(raw));
        }
        catch {
            return normalizeRegistry(null);
        }
    }
    function load() {
        return listProviders()[0] || null;
    }
    function save(data) {
        return saveProvider(DEFAULT_PROVIDER_ID, data, { name: DEFAULT_PROVIDER_NAME });
    }
    function clear() {
        persistence.remove();
    }
    function listProviders() {
        return loadRegistry().providers;
    }
    function getProvider(providerId) {
        const targetId = normalizeProviderId(providerId);
        return listProviders().find((p) => p.id === targetId) || null;
    }
    function saveProvider(providerId, data, metadata = {}) {
        const targetId = normalizeProviderId(providerId);
        if (!targetId)
            throw new Error("Provider id richiesto");
        const registry = loadRegistry();
        const existing = registry.providers.find((p) => p.id === targetId) || null;
        const nextProvider = normalizeProvider({
            ...existing,
            ...data,
            id: targetId,
            name: metadata.name || existing?.name || (targetId === DEFAULT_PROVIDER_ID ? DEFAULT_PROVIDER_NAME : targetId),
            created_at: existing?.created_at || data?.created_at || Date.now(),
            updated_at: Date.now(),
        });
        registry.providers = registry.providers.filter((p) => p.id !== targetId);
        registry.providers.push(nextProvider);
        registry.order = registry.order.filter((id) => id !== targetId);
        registry.order.push(targetId);
        registry.providers.sort((a, b) => registry.order.indexOf(a.id) - registry.order.indexOf(b.id));
        persistRegistry(registry);
        return nextProvider;
    }
    function setProviderOrder(providerIds) {
        const registry = loadRegistry();
        const normalizedIds = Array.isArray(providerIds) ? providerIds.map(normalizeProviderId).filter((id) => id.length > 0) : [];
        const nextOrder = [];
        for (const pid of normalizedIds) {
            if (registry.providers.some((p) => p.id === pid) && !nextOrder.includes(pid))
                nextOrder.push(pid);
        }
        for (const p of registry.providers) {
            if (!nextOrder.includes(p.id))
                nextOrder.push(p.id);
        }
        registry.order = nextOrder;
        registry.providers.sort((a, b) => nextOrder.indexOf(a.id) - nextOrder.indexOf(b.id));
        persistRegistry(registry);
        return registry.providers;
    }
    function moveProvider(providerId, position) {
        const targetId = normalizeProviderId(providerId);
        const order = listProviders().map((p) => p.id);
        const currentIndex = order.indexOf(targetId);
        if (currentIndex === -1)
            throw new Error(`Provider non trovato: ${targetId}`);
        const targetIndex = Math.max(0, Math.min(order.length - 1, (Number(position) || 1) - 1));
        order.splice(currentIndex, 1);
        order.splice(targetIndex, 0, targetId);
        return setProviderOrder(order);
    }
    function clearProvider(providerId) {
        const targetId = normalizeProviderId(providerId);
        const registry = loadRegistry();
        registry.providers = registry.providers.filter((p) => p.id !== targetId);
        registry.order = registry.order.filter((id) => id !== targetId);
        if (registry.providers.length === 0) {
            clear();
            return null;
        }
        persistRegistry(registry);
        return registry.providers;
    }
    function renameProvider(providerId, nextName) {
        const targetId = normalizeProviderId(providerId);
        const normalizedName = String(nextName ?? "").trim();
        if (!targetId)
            throw new Error("Provider id richiesto");
        if (!normalizedName)
            throw new Error("Provider name richiesto");
        const existing = getProvider(targetId);
        if (!existing)
            throw new Error(`Provider non trovato: ${targetId}`);
        return saveProvider(targetId, existing, { name: normalizedName });
    }
    function getAccessToken(providerId) {
        if (providerId)
            return getProvider(providerId)?.access_token || null;
        return listProviders()[0]?.access_token || null;
    }
    return {
        filePath,
        load,
        save,
        clear,
        listProviders,
        getProvider,
        saveProvider,
        setProviderOrder,
        moveProvider,
        clearProvider,
        renameProvider,
        getAccessToken,
    };
}
exports.createTokenStore = createTokenStore;
