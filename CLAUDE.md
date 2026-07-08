# CLAUDE.md — V11 Modules-Platform

> [!WARNING]
> ## RELEASE RULE FOR `llmproxy`
> **EVERY TIME YOU DO `git commit` AND `git push`, YOU MUST ALSO BUMP THE `llmproxy` VERSION FIRST.**
> - No exceptions.
> - Do not create or push a commit without updating the project version.
> - Treat version bump as part of the same mandatory change set as the code you are committing.
> - If the version was not bumped yet, stop and bump it before committing.

## 1. What This File Is
This file is the canonical architectural and behavioral guide for the V11 platform. It is loaded automatically by Claude Code at the start of every session. Every tool implementation, API route, database schema, and agent execution must strictly comply with the specs summarized below.

---

## 2. Mandatory Spec Files (with paths)
Refer to these files directly in the codebase for detailed architectural authority. Do not guess behavior:
- **Core vision & structure:** [vision](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/02%20-%20README.md)
- **Architecture mapping:** [architecture](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/03%20-%20ARCHITECTURE.md)
- **High-level summary:** [summary](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/04%20-%20ARCHITECTURE-SUMMARY.md)
- **Deployment and port mapping:** [numbering](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/06%20-%20MODULE-NUMBERING.md)
- **Startup sequence:** [bootstrap](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/08%20-%20BOOTSTRAP-ORDER.md)
- **Tenancy and scope:** [multi-tenancy](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/16%20-%20MULTI-TENANCY.md)
- **Identity and JWT conventions:** [security](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/18%20-%20SECURITY-AUTH.md)
- **Tech stack mandates:** [stack](file://Users/alessiobacin/Documents/Claude/Projects/Modules Platform/v11/21%20-%20DEVELOPMENT-STACK.md)

---

## 3. Module & Port Registry
Exposed network services are assigned a stable module number `n`. Ports are allocated dynamically using these formulas:
* **Development:** `5000 + n`
* **Staging:** `6000 + n`
* **Production:** `7000 + n`

> [!CAUTION]
> ⚠️ CONFLICT: The runtime `db-layer` service operates on port `5046` in the development environment. However, `06 - MODULE-NUMBERING.md` officially assigns port `5046` to `localization-service`. `db-layer` is an infrastructure module and is not officially registered in the legacy numbering table.

### Port Registry Table (Development)

| Module (n) | Component | Category | Dev Port |
|---|---|---|---|
| 10 | `discovery-engine` | Control Plane | `5010` |
| 11 | `research-block` | Control Plane | `5011` |
| 12 | `marketing-planner-agent` | Agent | `5012` |
| 13 | `campaign-brief-agent` | Agent | `5013` |
| 14 | `promotion-engine` | Control Plane | `5014` |
| 15 | `creator-block` | Control Plane | `5015` |
| 16 | `orchestrator-agent` | Agent | `5016` |
| 17 | `builder-agent` | Agent | `5017` |
| 18 | `publishing-service` | Service | `5018` |
| 20 | `lead-management-service` | Service | `5020` |
| 21 | `debugger-agent` | Agent | `5021` |
| 22 | `catalog-service` | Service | `5022` |
| 23 | `outcome-intelligence-agent` | Agent | `5023` |
| 24 | `brand-guardian-agent` | Agent | `5024` |
| 25 | `identity-service` | Service | `5025` |
| 26 | `compliance-service` | Service | `5026` |
| 27 | `customer-voice-agent` | Agent | `5027` |
| 28 | `onboarding-agent` | Agent | `5028` |
| 29 | `product-analytics-service` | Service | `5029` |
| 30 | `notification-service` | Service | `5030` |
| 31 | `community-manager-agent` | Agent | `5031` |
| 32 | `conversational-agent` | Agent | `5032` |
| 33 | `knowledge-gap-detection-service` | Service | `5033` |
| 34 | `automation-detector-service` | Service | `5034` |
| 35 | `anomaly-detection-service` | Service | `5035` |
| 36 | `content-strategist-agent` | Agent | `5036` |
| 37 | `customer-health-service` | Service | `5037` |
| 38 | `policy-service` | Service | `5038` |
| 39 | `product-intelligence-agent` | Agent | `5039` |
| 40 | `social-listening-agent` | Agent | `5040` |
| 41 | `billing-service` | Service | `5041` |
| 42 | `global-layer-service` | Service | `5042` |
| 43 | `fullstack-developer-agent` | Agent | `5043` |
| 44 | `storage-service` | Service | `5044` |
| 45 | `llm-proxy` | Gateway | `5045` |
| 46 | `localization-service` (Officially Assigned) / `db-layer` (Active Runtime) | Service | `5046` |
| 47 | `knowledge-service` | Service | `5047` |
| 48 | `event-bus` | Service | `5048` |
| 49 | `search-insight-service` | Service | `5049` |
| 50 | `outcome-service` | Service | `5050` |
| 51 | `error-handling-service` | Service | `5051` |
| 52 | `auth-gateway` | Gateway | `5052` |
| 53 | `storage-gateway` | Gateway | `5053` |
| 54 | `notification-gateway` | Gateway | `5054` |
| 55 | `payment-gateway` | Gateway | `5055` |
| 56 | `crm-gateway` | Gateway | `5056` |
| 57 | `interview-service` | Service | `5057` |
| 58 | `approval-service` | Service | `5058` |
| 59 | `health-monitor-service` | Service | `5059` |
| 60 | `telemetry-service` | Service | `5060` |
| 61 | `qa-service` | Service | `5061` |
| 62 | `playbook-executor-service` | Service | `5062` |

---

## 4. Bootstrap Order
V11 requires a strict **creator-first** bootstrapping sequence for the MVP. You must not build Orchestration until the registries and persistence structures are verified:
1. Minimal Infrastructure (Supabase, MinIO, Redis, Event Bus)
2. Minimal Core Services (`identity-service`, `policy-service`, `storage-service`)
3. Minimal Stores (`asset-store`, `policy-store`, `project-state-store`, `audit-store`)
4. Registries (`Capability Registry` + category registries)
5. Minimal Procedure Engine (prompts, playbooks, policies)
6. Minimal Execution Runtime
7. `builder-agent`
8. `creator-block`
9. Minimal Monitoring
10. `research-block`
11. `discovery-engine`
12. `orchestrator-agent`
13. Complete Promotion & Feedback Loops

---

## 5. Tenancy Scope Hierarchy
V11 does not use a flat `tenantId`. Isolation is defined by a strict hierarchical scope path:
```text
Platform ──> Agency/Tenant (agencyId) ──> Client (clientId) ──> Project (projectId)
```
- **Materialized Path format:** `/mc:<masterCompanyId>/tenant:<tenantId>/client:<clientId>/project:<projectId>`
- **Hierarchical Database Constraints:** If a child ID is present, its parent ID **must** also be non-null:
  ```sql
  ("projectId" IS NULL OR "clientId" IS NOT NULL) AND ("clientId" IS NULL OR "agencyId" IS NOT NULL)
  ```
- **Administrative Override:** Platform-level operations and system service accounts operate at the `Platform` level. They are not bound to a specific tenant/agency, meaning `tenantId` is optional (`tenantId?: string`) in global JWT contexts to support cross-tenant orchestration.

---

## 6. Authentication & Authorization Rules
- **JWT Standard:** Handled strictly via the `jose` library. Access tokens must expire in 15 minutes; refresh tokens are single-use with rotation and expire in 7 days.
- **JWT Payload Claims:** Every token must carry:
  * `actorId` (the user, agent, or run identity)
  * `tenantId` (the scope anchor, optional for platform service accounts)
  * `scope` (array of connection/permission scopes)
  * `permissions` (array of structural access privileges)
- **Role Permissions (RBAC):** Scoped to specific roles (`tenant_admin`, `tenant_operator`, `tenant_viewer`, `platform_admin`, `platform_support`).
- **Cryptography Hashing:**
  * ✅ Mandated: Argon2 (specifically `@node-rs/argon2`) for all password hashing.
  * ⛔ Banned: bcrypt, MD5, plain SHA-1, hardcoded JWT secrets.
- **Tenancy Validation:** Every cross-cutting service must verify incoming requests against the caller's tenancy scope before performing SQL operations.

---

## 7. Tech Stack Mandates

| Concern | Mandated Technology Choice | Notes |
|---|---|---|
| **Runtime** | Node.js 22 LTS+ | Modern ESM execution |
| **Language** | TypeScript 5.x | Strict mode required |
| **API framework** | Next.js 15 (App Router) or Fastify | Fastify is preferred for pure infrastructure services like `db-layer` |
| **Validation** | Zod | Strict schema validation everywhere |
| **Argon2** | `@node-rs/argon2` | For secure hashing |
| **JWT** | `jose` | Cryptographic signature verification |
| **Primary Database** | PostgreSQL (via Supabase) | Structural relational storage |
| **Vector DB** | pgvector (via Supabase) | Semantic embeddings |
| **Caching** | Redis | Session state and concurrency locking |
| **Event Bus** | Redis Streams | Pub/Sub messaging backbone |
| **Testing** | Vitest | Fast, Vite-native (Must run in TDD mode) |
| **Browser E2E** | Playwright | Full E2E flows |

---

## 8. Coding Conventions
- **Homogeneity:** No mixing of styles. All services must be Next.js App Router or Fastify.
- **Zero-any Rule:** TypeScript strict mode is mandatory. Zero `@ts-ignore`, zero `any`.
- **Casing Protocol:**
  * Database schemas, tables, and columns **must** use `snake_case` (e.g. `agency_id`, `created_at`).
  * API JSON payloads, variables, and TypeScript domains **must** use `camelCase` (e.g. `agencyId`, `createdAt`).
  * **Defensive Mapping:** Mappers (e.g. `src/repositories/mappers.ts`) must map keys defensively using a `readField` utility that supports both casings:
    ```typescript
    function readField(row: Record<string, unknown>, camelCase: string, snakeCase?: string) {
      if (row[camelCase] !== undefined) return row[camelCase];
      if (snakeCase && row[snakeCase] !== undefined) return row[snakeCase];
      return undefined;
    }
    ```
- **Error Handling:** Centralized inside `mapErrorToEnvelope()`. Never leak raw server crashes or database constraint logs directly to the user. Translate everything into structural envelopes.

---

## 9. API Conventions
- **Routing:** All REST endpoints must reside under a versioned path: `/v1/...`
- **Synchronous vs Asynchronous:**
  * Synchronous operations use standard REST APIs.
  * Internal event-driven state updates must flow asynchronously via the `Event Bus` (`Redis Streams`), never through ad-hoc point-to-point connections.
- **REST Response Envelope:** Every response returned to an internal platform component (like `storage-service` calling `db-layer`) must follow this JSON envelope:
  ```json
  {
    "status": "ok | error",
    "operation": "read | write | tx | ...",
    "rows": [ ... ],
    "rowCount": number,
    "error": {
      "code": "DBLAYER_INTERNAL | DBLAYER_AUTH_FAILED | DBLAYER_DSL_INVALID",
      "message": "Human-readable description",
      "retryable": boolean
    }
  }
  ```
  > [!WARNING]
  > ⚠️ WARNING: When communicating with `db-layer`, do not read the database rows from `response.data`. The rows are nested inside the JSON envelope under `response.data.rows` (where `response.data` is the Axios HTTP response wrapper, and `response.data.rows` is the database result array).

---


## 10. Database Conventions
- **Naming:** Tables must be plural and lowercase `snake_case` (e.g. `assets`, `asset_versions`).
- **Primary Keys:** Every table must have a primary key named `id` of type `UUID`, generated automatically using `gen_random_uuid()`.
- **Foreign Keys:** Must reference parent primary keys strictly and utilize the `UUID` type (e.g. `asset_id`).
- **Audit Columns:** Every table must contain `created_at` (timestamp, default now) and `created_by` (text or UUID).
- **Soft Deletes:** Tables must support soft-deletion using a `deleted_at` timestamp. Query layers must default to excluding soft-deleted rows.
- **Migrations:** Sequential raw SQL scripts located under `supabase/migrations/` (e.g. `202605240001_create_asset_store.sql`).

---

## 11. Agent Behaviour Rules
- **Read Specs First:** You must read the relevant directories' `README.md` and `TECHNICAL-SPEC.md` before making edits.
- **TDD Requirement:** You must write Vitest tests *before* writing or modifying code.
- **No Wildcard Assumptions:** If a requirement or database schema is ambiguous, stop and ask. Never guess keys, ports, or roles.
- **No Direct DB Connection:** Every application component must communicate with PostgreSQL via the `db-layer` service DSL plane, never directly via raw PostgreSQL drivers.
- **Test Exits:** Always execute Vitest tests with the `--run` flag. Do not run in default watch mode as the background process will hang and time out.
- **Mandatory Version Bump Before Commit+Push:** For this repository, every `git commit` that will be followed by `git push` must include a version bump of `llmproxy` in the same change set. Never commit and push without updating the version first.

---

## 12. Confirmation Protocol
At the start of every coding session, you must state:
1. Which module/component you are working on.
2. The port number it is assigned to.
3. Any active spec conflicts or gaps you noticed.
You must wait for the human operator to type "proceed" or provide feedback before writing any files.

---

## 14. graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
