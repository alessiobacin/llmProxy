"use strict";

// Contratto /v1/models per Codex CLI (models-manager) — ModelInfo decoding:
//   - Codex 0.152.x decodifica ogni entry con lo schema STRICT `ModelInfo`
//     (codex-rs/protocol/src/openai_models.rs): un solo campo assente
//     abortisce il refresh con "failed to decode models response: missing
//     field `X`". Questo test verifica la presenza (chiave E tipo) di TUTTI
//     i campi richiesti su OGNI entry restituita.
//   - `service_tiers` deve pubblicizzare il tier "priority" (ServiceTier::Fast),
//     altrimenti un utente con `service_tier = "priority"` in ~/.codex/config.toml
//     riceve un warning e il tier non è valido.
//   - `model_messages.instructions_template` deve essere una stringa: senza,
//     Codex rifiuta l'intero catalogo ("missing both base_instructions and
//     model_messages.instructions_template").
//   - La risposta /v1/models deve contenere sia `data` sia `models`.
//   - GET /v1/models/llmproxy deve restare coerente con l'entry virtuale.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const { createTokenStore } = require("../lib/token-store");
const { createProviderRegistry } = require("../lib/provider-registry");

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      Promise.resolve(fn(`http://127.0.0.1:${port}`))
        .then(() => { server.close(); resolve(); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

function makeApp(tempRoot) {
  const tokenStore = createTokenStore({ filePath: path.join(tempRoot, "copilot-token.json") });
  tokenStore.saveProvider("openai", {
    access_token: "sk-openai-test",
    token_type: "api_key",
    scope: "api_key",
    provider: "openai",
    auth_type: "api_key",
    default_model: "gpt-4o-mini",
  }, { name: "OpenAI" });
  return createApp({
    dataRoot: tempRoot,
    tokenStore,
    providerRegistry: createProviderRegistry({ filePath: path.join(tempRoot, "provider-registry.json") }),
  });
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llmp-codex-models-"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Ogni asserzione è [fieldName, validator]. Un campo assente o col tipo
// sbagliato deve far fallire il test (Codex farebbe esattamente lo stesso).
function assertModelInfoContract(entry, label) {
  const prefix = `[${label}]`;
  assert.ok(isPlainObject(entry), `${prefix} entry is an object`);

  // Identity / OpenAI-compat surface
  assert.equal(typeof entry.slug, "string", `${prefix} slug string`);
  assert.ok(entry.slug.length > 0, `${prefix} slug non-empty`);
  assert.equal(typeof entry.display_name, "string", `${prefix} display_name string`);
  assert.ok(
    entry.description === null || typeof entry.description === "string",
    `${prefix} description string|null`,
  );

  // Reasoning levels
  assert.ok(Array.isArray(entry.supported_reasoning_levels), `${prefix} supported_reasoning_levels array`);
  for (const level of entry.supported_reasoning_levels) {
    assert.equal(typeof level.effort, "string", `${prefix} reasoning level.effort string`);
    assert.equal(typeof level.description, "string", `${prefix} reasoning level.description string`);
  }
  if (entry.default_reasoning_level !== undefined && entry.default_reasoning_level !== null) {
    assert.equal(typeof entry.default_reasoning_level, "string", `${prefix} default_reasoning_level string`);
  }

  // Core flags
  assert.equal(typeof entry.shell_type, "string", `${prefix} shell_type string`);
  assert.equal(typeof entry.visibility, "string", `${prefix} visibility string`);
  assert.equal(typeof entry.supported_in_api, "boolean", `${prefix} supported_in_api bool`);
  assert.equal(typeof entry.priority, "number", `${prefix} priority number`);
  assert.ok(Array.isArray(entry.additional_speed_tiers), `${prefix} additional_speed_tiers array`);

  // Service tiers: "priority" must be advertised
  assert.ok(Array.isArray(entry.service_tiers), `${prefix} service_tiers array`);
  const tierIds = entry.service_tiers.map((t) => t && t.id);
  assert.ok(tierIds.includes("priority"), `${prefix} service_tiers advertises "priority" (got ${JSON.stringify(tierIds)})`);
  for (const tier of entry.service_tiers) {
    assert.equal(typeof tier.id, "string", `${prefix} service tier.id string`);
    assert.equal(typeof tier.name, "string", `${prefix} service tier.name string`);
    assert.ok(
      tier.description === null || typeof tier.description === "string",
      `${prefix} service tier.description string|null`,
    );
  }
  assert.ok(
    entry.default_service_tier === undefined || entry.default_service_tier === null,
    `${prefix} default_service_tier absent|null`,
  );

  // Context
  assert.ok(
    typeof entry.context_window === "number" || entry.context_window === null,
    `${prefix} context_window number|null`,
  );
  assert.ok(
    typeof entry.max_context_window === "number" || entry.max_context_window === null,
    `${prefix} max_context_window number|null`,
  );
  assert.ok(
    typeof entry.effective_context_window_percent === "number",
    `${prefix} effective_context_window_percent number`,
  );
  assert.equal(entry.auto_compact_token_limit, null, `${prefix} auto_compact_token_limit null`);
  assert.equal(entry.comp_hash, null, `${prefix} comp_hash null`);

  // Modalities / tools
  assert.ok(Array.isArray(entry.input_modalities), `${prefix} input_modalities array`);
  assert.equal(typeof entry.supports_search_tool, "boolean", `${prefix} supports_search_tool bool`);
  assert.equal(typeof entry.use_responses_lite, "boolean", `${prefix} use_responses_lite bool`);
  assert.ok(
    typeof entry.include_skills_usage_instructions === "boolean",
    `${prefix} include_skills_usage_instructions bool`,
  );
  assert.equal(typeof entry.support_verbosity, "boolean", `${prefix} support_verbosity bool`);
  assert.ok(Array.isArray(entry.experimental_supported_tools), `${prefix} experimental_supported_tools array`);
  assert.equal(entry.tool_mode, null, `${prefix} tool_mode null`);
  assert.equal(entry.multi_agent_version, null, `${prefix} multi_agent_version null`);
  assert.equal(entry.multi_agent_reasoning_effort, null, `${prefix} multi_agent_reasoning_effort null`);
  assert.equal(entry.auto_review_model_override, null, `${prefix} auto_review_model_override null`);
  assert.ok(
    entry.model_specialty === null || typeof entry.model_specialty === "string",
    `${prefix} model_specialty null|string`,
  );
  assert.equal(entry.availability_nux, null, `${prefix} availability_nux null`);
  assert.equal(entry.upgrade, null, `${prefix} upgrade null`);
  assert.equal(entry.apply_patch_tool_type, null, `${prefix} apply_patch_tool_type null`);
  assert.ok(
    entry.default_verbosity === null || typeof entry.default_verbosity === "string",
    `${prefix} default_verbosity null|string`,
  );

  // Truncation policy
  assert.ok(isPlainObject(entry.truncation_policy), `${prefix} truncation_policy object`);
  assert.ok(
    entry.truncation_policy.mode === "tokens" || entry.truncation_policy.mode === "bytes",
    `${prefix} truncation_policy.mode "tokens"|"bytes" (got ${JSON.stringify(entry.truncation_policy.mode)})`,
  );
  assert.equal(typeof entry.truncation_policy.limit, "number", `${prefix} truncation_policy.limit number`);

  // ModelMessages: instructions_template is the make-or-break field
  assert.ok(isPlainObject(entry.model_messages), `${prefix} model_messages object`);
  assert.equal(
    typeof entry.model_messages.instructions_template,
    "string",
    `${prefix} model_messages.instructions_template string`,
  );
  assert.ok(
    entry.model_messages.instructions_template.length > 0,
    `${prefix} model_messages.instructions_template non-empty`,
  );
  for (const nullField of [
    "persistent_instructions",
    "tools",
    "instructions_variables",
    "approvals",
    "collaboration_modes",
    "auto_review",
    "permissions",
    "multi_agent",
    "token_budget",
    "confirmation_policies",
    "guardian_v2",
  ]) {
    assert.equal(
      entry.model_messages[nullField],
      null,
      `${prefix} model_messages.${nullField} explicit null`,
    );
  }
}

test("GET /v1/models returns data + models arrays", async (t) => {
  const root = makeTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = makeApp(root);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data), "data is an array");
    assert.ok(Array.isArray(body.models), "models is an array");
    assert.equal(body.models.length, body.data.length, "models mirrors data");
    assert.ok(body.data.length >= 1, "at least the virtual llmproxy model is listed");
  });
});

test("GET /v1/models: every entry satisfies the Codex ModelInfo contract", async (t) => {
  const root = makeTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = makeApp(root);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const entry of body.data) {
      assertModelInfoContract(entry, entry.slug);
    }
    for (const entry of body.models) {
      assertModelInfoContract(entry, `models:${entry.slug}`);
    }
  });
});

test("GET /v1/models includes the virtual llmproxy model and routed provider models", async (t) => {
  const root = makeTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = makeApp(root);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const slugs = body.data.map((m) => m.slug);
    assert.ok(slugs.includes("llmproxy"), `virtual llmproxy listed (got ${JSON.stringify(slugs)})`);
    assert.ok(slugs.includes("openai:gpt-4o-mini"), "routed provider model listed from tokenStore");
  });
});

test("GET /v1/models/llmproxy: coherent single entry with priority tier", async (t) => {
  const root = makeTempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = makeApp(root);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/models/llmproxy`);
    assert.equal(res.status, 200);
    const entry = await res.json();
    assert.equal(entry.slug, "llmproxy");
    assert.equal(entry.id, "llmproxy");
    assert.equal(entry.object, "model");
    assertModelInfoContract(entry, "llmproxy (single)");

    const listRes = await fetch(`${baseUrl}/v1/models`);
    const listed = (await listRes.json()).data.find((m) => m.slug === "llmproxy");
    assert.deepEqual(entry.service_tiers, listed.service_tiers, "same service_tiers as listed entry");
    assert.deepEqual(entry.truncation_policy, listed.truncation_policy, "same truncation_policy as listed entry");
    assert.deepEqual(entry.model_messages, listed.model_messages, "same model_messages as listed entry");
  });
});
