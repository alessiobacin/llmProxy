---
name: cm
description: Persistent project memory via `cm` CLI, with optional global memory. Save project facts, typed memories, retrieval plans, graph relationships, search conversations, watch daemon, and semantic recall.
---

# cm - Code-Mem Tool

Local, persistent memory for a repository. Start substantial work by recalling
the relevant context; save only durable, evidence-backed outcomes.

## Initialize and update

```bash
cm init --deep                    # detect harnesses, index everything, build graph + 3D HTML
cm update --memory --deep         # repeat after repository changes
cm init pi         # init + project-local Pi skill and non-blocking hook
cm init claude     # init + Claude instructions/hooks
cm init codex      # init + Codex instructions/hooks
cm init copilot    # init + generate .github/copilot-instructions.md
cm init cursor     # explicit legacy-compatible Cursor integration
```

## Core commands

- `cm version`
- `cm save --kind decision "Use Vitest for unit tests"`
- `cm save --kind procedure --global "Deploy with Docker from the repository .env file"`
- `cm recall "fix flaky tests" --level 2 --mode hybrid` — retrieve prior evidence
- `cm recall-auto` — auto-recall based on git context (used by SessionStart hook)
- `cm watch [--interval 30] [--daemon]` — continuous embedding + consolidation daemon
- `cm plan "deploy preview build"`
- `cm backup` — save project memories to `./cm/memories/<timestamp>/project-memory.md`
- `cm backup --global` — export global memories to a backup file in the current directory
- `cm restore --global [file]` — merge a global backup into `~/.cm/state.db`
- `cm update`
- `cm recent`
- `cm consolidate`

## Legacy commands

- `cm add "text"` -> fact
- `cm add-user "text"` -> preference
- `cm ls`
- `cm ls-user`

## Agent protocol

1. At the start of a non-trivial task run `cm recall "<goal>" --level 2 --mode hybrid`; use `cm plan` to see why context was selected and `cm sq` only for exact prior conversation text.
2. Save a decision, procedure, issue, or artifact only after it is durable and evidence-backed. Include paths, commands, tests, ticket IDs, and consequences where available.
3. Never store secrets, access tokens, personal data, unverified hypotheses, or disposable status chatter.
4. `cm save --global` is only for learning valid across projects; project-specific facts stay local.
5. `MEMORY.md` and `USER.md` are generated projections from `state.db`: inspect them, but do not hand-edit them as the source of truth.
6. The Pi hook is best-effort: it recalls at session start and captures completed agent responses without ever blocking a session.
7. `cm recall --mode hybrid` uses Ollama when available and a local fallback otherwise; missing embeddings do not stop work.
8. Run `cm consolidate` after a completed debugging or implementation cycle; use `cm project` when projections look stale.
9. Run `cm setup` only from a project directory. It installs global harness skills; `cm init pi` is the project-local Pi integration.
