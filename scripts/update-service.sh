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

# 4. Docker compose down
echo " Stop container Docker..."
docker-compose down || docker compose down
echo "✅ Container fermati"
echo ""

# 5. Docker compose up
echo "🚀 Avvio container Docker..."
docker-compose up -d --build || docker compose up -d --build
echo "✅ Container avviati"
echo ""

# 6. Restart servizio
echo "🔄 Riavvio servizio llmproxy..."
llmproxy service:restart || echo "⚠️  Riavvio servizio fallito (manuale?)"
echo ""

echo "✅ Aggiornamento completato!"
echo ""
llmproxy version
