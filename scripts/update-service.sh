#!/bin/bash
set -e

echo "🔄 Aggiornamento locale llmProxy..."
echo ""

# 1. Git pull
echo "📥 Git pull..."
git pull --ff-only
if [ $? -ne 0 ]; then
  echo "❌ Git pull fallito. Controlla conflitti o permessi."
  exit 1
fi
echo "✅ Codice aggiornato"
echo ""

# 2. Install dependencies
echo "📦 Installazione dipendenze..."
pnpm install
echo "✅ Dipendenze installate"
echo ""

# 3. Build TypeScript
echo " Build TypeScript..."
pnpm build:ts
echo "✅ Build completato"
echo ""

# 4. Docker compose (optional — skipped if not installed)
COMPOSE_FILE="docker-compose.production.yml"
COMPOSE_CMD=""
if command -v docker-compose &> /dev/null; then
  COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
fi

if [ -n "$COMPOSE_CMD" ] && [ -f "$COMPOSE_FILE" ]; then
  # LLMPROXY_HOME is required by the compose file for volume mounts
  if [ -z "$LLMPROXY_HOME" ]; then
    export LLMPROXY_HOME="$HOME/.local/share/llmProxy"
  fi

  echo " Stop container Docker..."
  $COMPOSE_CMD -f "$COMPOSE_FILE" down
  echo "✅ Container fermati"
  echo ""

  echo "🚀 Avvio container Docker..."
  $COMPOSE_CMD -f "$COMPOSE_FILE" up -d --build
  echo "✅ Container avviati"
  echo ""
else
  echo "⚠️  Docker Compose non disponibile o $COMPOSE_FILE non trovato, salto i container"
  echo ""
fi

# 6. Restart servizio
echo "🔄 Riavvio servizio llmproxy..."
llmproxy service:restart || echo "⚠️  Riavvio servizio fallito (manuale?)"
echo ""

echo "✅ Aggiornamento completato!"
echo ""
llmproxy version
