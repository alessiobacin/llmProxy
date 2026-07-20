# Multi-Harness Setup — Design Doc

## Context

llmProxy è un gateway LLM (modulo V11 n=45) che funge da proxy locale per vari
AI coding assistant (harness). Serve un comando per bootstrap rapido della
configurazione minima per ogni harness, in modo che puntino a llmProxy come
backend.

## Stato Attuale

| Comando | Harness | Files generati | Stato |
|---------|---------|----------------|-------|
| `claude:setup` | Claude Code | `.claude/settings.json` | ✅ Esistente |
| `pi:setup` | PI Agent | `.pi/models.json`, `.pi/settings.json` | ✅ Implementato (v0.3.71) |
| `codex:setup` | Codex CLI | — | ⏳ |
| `gemini:setup` | Gemini CLI | — | ⏳ |
| `copilot:setup` | Copilot CLI | — | ⏳ |
| `amazonq:setup` | Amazon Q | — | ⏳ |

## Pattern Comune

Ogni comando `{harness}:setup` segue:

```
CLI: llmp {abbreviazione}:setup
  → POST /api/{harness}/setup
  → CLI handler locale scrive i config file
```

Regole:
- Config SOLO a livello progetto (mai ~/.config globali)
- baseUrl risolta via `getProxyBaseUrl()` (stessa logica di `claude:setup`)
- apiKey `"proxy-local"` per auth locale
- `--yes` per esecuzione non interattiva

## PI Agent

### File generati

`.pi/models.json`:
```json
{
  "providers": {
    "llmproxy": {
      "api": "anthropic-messages",
      "baseUrl": "http://127.0.0.1:7045",
      "apiKey": "proxy-local",
      "models": [
        { "id": "llmproxy", "name": "llmProxy", "contextWindow": 1000000 }
      ]
    }
  }
}
```

`.pi/settings.json`:
```json
{
  "defaultProvider": "llmproxy",
  "defaultModel": "llmproxy"
}
```

### Comandi

```
llmproxy pi:setup     (full)
llmp pi:s             (alias breve)
```

## Prossimi harness (da implementare)

- **Codex CLI**: `.codex/config.json` (ricerca configurazione necessaria)
- **Gemini CLI**: `GEMINI.md` + eventuali env (ricerca necessaria)
- **Copilot CLI**: `.github/copilot-instructions.md` ? (ricerca necessaria)
- **Amazon Q Developer**: `.qdeveloper/config.json` ? (ricerca necessaria)
