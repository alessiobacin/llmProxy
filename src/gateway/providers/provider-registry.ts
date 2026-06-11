// V11 provider registry — scoped provider routing with encrypted credentials.
// Strict TypeScript replacement for provider-registry.js.
// File persistence is injected, keeping this a pure domain module.

import crypto from "node:crypto";

const SUPPORTED_PROVIDERS = [
  "copilot",
  "openrouter",
  "zai",
  "kimi",
  "qwen",
  "openai",
  "anthropic",
  "deepseek",
  "groq",
  "mistral",
  "xai",
  "perplexity",
  "together",
  "fireworks",
] as const;

const VALID_SCOPE_TYPES = ["master", "agency", "client", "project", "user"] as const;
const SCOPE_PRIORITY: Record<string, number> = { project: 4, client: 3, agency: 2, user: 1, master: 0 };
const ENC_PREFIX = "enc.v1:";

type ScopeType = (typeof VALID_SCOPE_TYPES)[number];

interface ProviderEntry {
  provider: string;
  scope_type: ScopeType;
  scope_id: string;
  default_model: string | null;
  priority: number;
  credentials: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface PublicView {
  id: string;
  provider: string;
  scope_type: string;
  scope_id: string;
  default_model: string | null;
  priority: number;
  metadata: Record<string, unknown>;
  has_credentials: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface ResolvedEntry extends PublicView {
  credentials: Record<string, string>;
}

interface HierarchyContext {
  project_id?: string | null;
  client_id?: string | null;
  tenant_id?: string | null;
  agency_id?: string | null;
  user_id?: string | null;
}

interface StoreFile {
  entries: ProviderEntry[];
}

interface PersistenceLayer {
  read(): StoreFile;
  write(store: StoreFile): void;
}

// ---------- crypto ----------

function deriveKey(secret: string | null): Buffer | null {
  if (!secret) return null;
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptString(plain: string, secret: string | null): string {
  const key = deriveKey(secret);
  if (!key) return String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptString(value: string, secret: string | null): string {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return value;
  const key = deriveKey(secret);
  if (!key) throw new Error("LLMPROXY_SECRET_REQUIRED");
  const raw = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function encryptCredentials(credentials: Record<string, string> | null | undefined, secret: string | null): Record<string, string> {
  if (!credentials || typeof credentials !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (v == null) continue;
    out[k] = secret ? encryptString(String(v), secret) : String(v);
  }
  return out;
}

function decryptCredentials(credentials: Record<string, string> | null | undefined, secret: string | null): Record<string, string> {
  if (!credentials || typeof credentials !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    out[k] = decryptString(v, secret);
  }
  return out;
}

// ---------- domain ----------

function validateEntry(input: Record<string, unknown>): ProviderEntry {
  if (!input || typeof input !== "object") {
    throw new Error("INVALID_PROVIDER_ENTRY");
  }
  const provider = String(input.provider ?? "").trim();
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`UNSUPPORTED_PROVIDER:${provider}`);
  }
  const scopeType = String(input.scope_type ?? "").trim();
  if (!(VALID_SCOPE_TYPES as readonly string[]).includes(scopeType)) {
    throw new Error(`INVALID_SCOPE_TYPE:${scopeType}`);
  }
  const scopeId = String(input.scope_id ?? "").trim();
  if (!scopeId) throw new Error("MISSING_SCOPE_ID");
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100;
  return {
    provider,
    scope_type: scopeType as ScopeType,
    scope_id: scopeId,
    default_model: input.default_model ? String(input.default_model) : null,
    priority,
    credentials: input.credentials && typeof input.credentials === "object" ? (input.credentials as Record<string, string>) : {},
    metadata: input.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>) : {},
  };
}

function entryId(entry: ProviderEntry): string {
  return `${entry.scope_type}:${entry.scope_id}:${entry.provider}`;
}

function publicView(entry: ProviderEntry): PublicView {
  return {
    id: entryId(entry),
    provider: entry.provider,
    scope_type: entry.scope_type,
    scope_id: entry.scope_id,
    default_model: entry.default_model,
    priority: entry.priority,
    metadata: entry.metadata || {},
    has_credentials: !!entry.credentials && Object.keys(entry.credentials).length > 0,
    created_at: entry.created_at || null,
    updated_at: entry.updated_at || null,
  };
}

function buildScopeMatchSet(hierarchyContext: HierarchyContext | null): Array<{ scope_type: ScopeType; scope_id: string }> {
  if (!hierarchyContext) return [];
  const matches: Array<{ scope_type: ScopeType; scope_id: string }> = [];
  if (hierarchyContext.project_id) matches.push({ scope_type: "project", scope_id: hierarchyContext.project_id });
  if (hierarchyContext.client_id) matches.push({ scope_type: "client", scope_id: hierarchyContext.client_id });
  if (hierarchyContext.tenant_id || hierarchyContext.agency_id) {
    matches.push({ scope_type: "agency", scope_id: hierarchyContext.tenant_id || hierarchyContext.agency_id! });
  }
  if (hierarchyContext.user_id) matches.push({ scope_type: "user", scope_id: hierarchyContext.user_id });
  matches.push({ scope_type: "master", scope_id: "*" });
  return matches;
}

// ---------- factory ----------

interface ProviderRegistry {
  list: (filter?: { scope_type?: string; scope_id?: string; provider?: string }) => PublicView[];
  upsert: (entry: ProviderEntry) => PublicView;
  remove: (id: string) => boolean;
  resolve: (hierarchyContext: HierarchyContext | null, requestedProvider: string | null | undefined) => ResolvedEntry | null;
}

function createProviderRegistry(options: { persistence: PersistenceLayer; secret?: string | null }): ProviderRegistry {
  const persistence = options.persistence;
  const secret = options.secret || null;

  function list(filter: { scope_type?: string; scope_id?: string; provider?: string } = {}): PublicView[] {
    const store = persistence.read();
    return store.entries
      .filter((e) => (filter.scope_type ? e.scope_type === filter.scope_type : true))
      .filter((e) => (filter.scope_id ? e.scope_id === filter.scope_id : true))
      .filter((e) => (filter.provider ? e.provider === filter.provider : true))
      .map(publicView);
  }

  function upsert(entry: ProviderEntry): PublicView {
    entry.credentials = encryptCredentials(entry.credentials, secret);
    const store = persistence.read();
    const id = entryId(entry);
    const now = new Date().toISOString();
    const idx = store.entries.findIndex((e) => entryId(e) === id);

    if (idx >= 0) {
      const existing = store.entries[idx]!;
      store.entries[idx] = {
        ...existing,
        ...entry,
        credentials: Object.keys(entry.credentials).length > 0 ? entry.credentials : existing.credentials,
        created_at: existing.created_at || now,
        updated_at: now,
      };
    } else {
      store.entries.push({ ...entry, created_at: now, updated_at: now });
    }

    persistence.write(store);

    const result = store.entries.find((e) => entryId(e) === id)!;
    return publicView(result);
  }

  function remove(id: string): boolean {
    const store = persistence.read();
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => entryId(e) !== id);
    persistence.write(store);
    return store.entries.length < before;
  }

  function resolve(hierarchyContext: HierarchyContext | null, requestedProvider: string | null | undefined): ResolvedEntry | null {
    const store = persistence.read();
    const matches = buildScopeMatchSet(hierarchyContext);
    const candidates: Array<{ entry: ProviderEntry; scopeRank: number }> = [];

    for (const match of matches) {
      const scopeRank = SCOPE_PRIORITY[match.scope_type] || 0;
      const found = store.entries.filter((e) => {
        if (e.scope_type !== match.scope_type) return false;
        if (match.scope_type === "master") return true;
        return e.scope_id === match.scope_id;
      });
      for (const entry of found) {
        candidates.push({ entry, scopeRank });
      }
    }

    if (requestedProvider && requestedProvider !== "auto") {
      const filtered = candidates.filter((c) => c.entry.provider === requestedProvider);
      if (filtered.length === 0) return null;
      filtered.sort((a, b) => b.scopeRank - a.scopeRank || a.entry.priority - b.entry.priority);
      const winner = filtered[0]!.entry;
      return {
        ...publicView(winner),
        credentials: decryptCredentials(winner.credentials || {}, secret),
      };
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.scopeRank - a.scopeRank || a.entry.priority - b.entry.priority);
    const winner = candidates[0]!.entry;
    return {
      ...publicView(winner),
      credentials: decryptCredentials(winner.credentials || {}, secret),
    };
  }

  return { list, upsert, remove, resolve };
}

export {
  SUPPORTED_PROVIDERS,
  VALID_SCOPE_TYPES,
  createProviderRegistry,
  validateEntry,
  entryId,
  publicView,
  buildScopeMatchSet,
  encryptCredentials,
  decryptCredentials,
};

export type {
  ProviderEntry,
  PublicView,
  ResolvedEntry,
  HierarchyContext as RegistryHierarchyContext,
  PersistenceLayer,
  ProviderRegistry,
  StoreFile,
};
