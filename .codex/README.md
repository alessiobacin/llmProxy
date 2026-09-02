# ═══════════════════════════════════════════════════════════════════════════════
# llmProxy — Codex CLI (configurazione per-progetto)
# ═══════════════════════════════════════════════════════════════════════════════
# Codex CLI legge SOLO ~/.codex/config.toml (globale) o profili
# ($CODEX_HOME/<name>.config.toml). Non esiste un config.toml per-progetto.
#
# Per usare llmProxy con Codex devi usare il profilo dedicato di questo
# progetto (il file llmproxy.config.toml qui accanto):
#
#   codex -p llmproxy
#
# Il profilo non richiede piu` di esportare LLMPROXY_API_KEY nella shell:
# l'auth verso il gate in ingresso del proxy avviene tramite header statico
#
#   http_headers = { Authorization = "Bearer proxy-local" }
#
# (valore allineato all'LLMPROXY_API_KEY di default del proxy, vedi
# docker-compose production). Niente piu` "Missing environment variable:
# LLMPROXY_API_KEY" se la variabile non e` esportata: codex parte e la
# richiesta viene autenticata dall'header.
#
# Se il gate del tuo proxy usa una chiave diversa, cambiala cosi`:
# 1. commenta la riga http_headers qui sotto;
# 2. scommenta la riga env_key (es. env_key = "LLMPROXY_API_KEY");
# 3. esporta la chiave nella shell: export LLMPROXY_API_KEY=<la-tua-chiave>.
#
# ATTENZIONE: wire_api = "responses" e` RICHIESTO da Codex >= 0.152 (il
# client parla il protocollo Responses API). Non usare wire_api = "chat"
# con queste versioni di Codex.
#
# Variabili LLMPROXY_* client-side (short answer, metering, inference info,
# sendgrid): esportale nella shell prima di lanciare codex, oppure impostale
# con `llmproxy config:set <key> <value> --scope project` (il proxy le legge
# dal .claude/settings.json del progetto a runtime).
#
# Riferimento alternativo: per integrare llmProxy in un altro progetto
# (config globale ~/.codex/config.toml), copia la stessa sezione
# [model_providers.llmproxy] con base_url/http_headers/env_key.
# ═══════════════════════════════════════════════════════════════════════════════