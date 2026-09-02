# ═══════════════════════════════════════════════════════════════════════════════
# llmProxy — Codex CLI (configurazione per-progetto)
# ═══════════════════════════════════════════════════════════════════════════════
# Codex CLI legge SOLO ~/.codex/config.toml (globale) o profili
# ($CODEX_HOME/<name>.config.toml). Non esiste un config.toml per-progetto.
#
# Per usare llmProxy con Codex, aggiungi al tuo ~/.codex/config.toml:
#
#   model = "llmproxy"
#   model_provider = "llmproxy"
#
#   [model_providers.llmproxy]
#   name = "llmProxy"
#   base_url = "http://127.0.0.1:7045/v1"
#   env_key = "LLMPROXY_API_KEY"
#   wire_api = "chat"
#
# ed esporta nella shell (es. ~/.zshrc):
#
#   export LLMPROXY_API_KEY=proxy-local
#
# Alternativa senza toccare il config globale (profilo dedicato):
#
#   codex -p llmproxy
#
# con un file ~/.codex/llmproxy.config.toml contenente la sezione sopra.
#
# Variabili LLMPROXY_* client-side (short answer, metering, inference info,
# sendgrid): esportale nella shell prima di lanciare codex, oppure impostale
# con `llmproxy config:set <key> <value> --scope project` (il proxy le legge
# dal .claude/settings.json del progetto a runtime).
# ═══════════════════════════════════════════════════════════════════════════════