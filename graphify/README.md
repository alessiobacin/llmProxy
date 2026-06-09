# graphify/

Knowledge graph artifacts for `llmProxy` (architecture v8, tool #45).

This directory is the canonical destination for outputs of the `graphify` skill:
clustered communities (HTML), structured graph data (JSON) and audit reports.

The directory is required by the v8 tool contract even when no graph has been
generated yet.

## Generate

Run the `/graphify` skill from the repository root. Outputs:

- `graph.html` — interactive view
- `graph.json` — nodes/edges, communities, metadata
- `GRAPH_REPORT.md` — quality, coverage, communities and god nodes report

For code-only refreshes without LLM cost you can also run:

```bash
graphify update .
```

## Why a tool needs a graph

`llmProxy` is a deterministic transport tool. The graph documents:

- module boundaries (transport vs auth vs metering vs CLI vs service manager)
- provider fallback chain
- public API surface (`/v1/messages`, `/v1/llm/*`, `/api/*`)
- dependencies declared in `manifest.json`

It is consumed by platform tooling (codebase intelligence, AI Orchestrator
routing, security review) and is not used at runtime.
