#!/bin/sh
# llmProxy one-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/alessiobacin/llmProxy/main/scripts/install.sh | sh
#    or: wget -qO- https://raw.githubusercontent.com/alessiobacin/llmProxy/main/scripts/install.sh | sh

set -eu

# --- ANSI helpers (no-op if not a terminal) ---
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; NC=''
fi

info()  { printf "${GREEN}%s${NC}\n" "$1"; }
warn()  { printf "${YELLOW}WARN:${NC} %s\n" "$1"; }
error() { printf "${RED}ERROR:${NC} %s\n" "$1"; exit 1; }

# --- Platform detection ---
OS="$(uname -s)"
case "$OS" in
  Darwin)  PLATFORM="darwin"  ;;
  Linux)   PLATFORM="linux"   ;;
  MSYS*|MINGW*|CYGWIN*) PLATFORM="windows" ;;
  *)       error "Unsupported OS '$OS'. llmProxy supports macOS, Linux, and Windows (via Git Bash / WSL)."
esac

# --- Locale ---
case "${LANG:-}" in
  it_IT*|it_CH*) LOCALE="it" ;;
  *)             LOCALE="en" ;;
esac

# --- Helper messages ---
if [ "$LOCALE" = "it" ]; then
  MSG_CHECK_NODE="Verifica Node.js..."
  MSG_NODE_MISSING="Node.js non trovato. Installalo da https://nodejs.org (versione LTS 22.x)"
  MSG_NODE_VERSION="Richiesta Node.js 22+. Versione attuale:"
  MSG_INSTALLING="Installazione di llmProxy..."
  MSG_INSTALL_FAIL="Installazione npm fallita."
  MSG_INSTALL_SOURCE="Sorgente installazione"
  MSG_SERVICE="Avvio del servizio persistente in corso..."
  MSG_SERVICE_FAIL="Il servizio persistente o il runtime Docker non sono partiti correttamente."
  MSG_DONE="Installazione completata!"
  MSG_POST="Ora configura un provider: llmproxy provider:add copilot"
  MSG_HELP="    llmproxy help"
  MSG_WINDOWS_NOTE="Avvia PowerShell come Amministratore se vedi errori di permessi."
else
  MSG_CHECK_NODE="Checking Node.js..."
  MSG_NODE_MISSING="Node.js not found. Install Node.js 22+ LTS from https://nodejs.org"
  MSG_NODE_VERSION="Node.js 22+ is required. Current version:"
  MSG_INSTALLING="Installing llmProxy..."
  MSG_INSTALL_FAIL="npm install failed."
  MSG_INSTALL_SOURCE="Install source"
  MSG_SERVICE="Starting persistent service..."
  MSG_SERVICE_FAIL="The persistent service or Docker runtime did not start correctly."
  MSG_DONE="Installation complete!"
  MSG_POST="Next step: add a provider — llmproxy provider:add copilot"
  MSG_HELP="    llmproxy help"
  MSG_WINDOWS_NOTE="Run PowerShell as Administrator if you see permission errors."
fi

# --- Preflight ---
info "$MSG_CHECK_NODE"
if ! command -v node >/dev/null 2>&1; then
  error "$MSG_NODE_MISSING"
fi

NODE_MAJOR="$(node -e 'console.log(process.version.slice(1).split(".")[0])' 2>/dev/null || echo "0")"
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  error "$MSG_NODE_VERSION $(node --version)"
fi

if ! command -v npm >/dev/null 2>&1; then
  error "$MSG_NODE_MISSING (npm not found)"
fi

# --- Install from GitHub tarball ---
INSTALL_SOURCE="${LLMPROXY_INSTALL_SOURCE:-https://github.com/alessiobacin/llmProxy/archive/refs/heads/main.tar.gz}"
info "$MSG_INSTALLING"
printf "%s: %s\n" "$MSG_INSTALL_SOURCE" "$INSTALL_SOURCE"
npm install -g "$INSTALL_SOURCE" 2>&1 || error "$MSG_INSTALL_FAIL"

# --- Resolve global binary ---
LLMPROXY_BIN=""
if command -v llmproxy >/dev/null 2>&1; then
  LLMPROXY_BIN="$(command -v llmproxy)"
else
  NPM_GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_GLOBAL_PREFIX" ] && [ -x "$NPM_GLOBAL_PREFIX/bin/llmproxy" ]; then
    LLMPROXY_BIN="$NPM_GLOBAL_PREFIX/bin/llmproxy"
  fi
fi

if [ -z "$LLMPROXY_BIN" ]; then
  error "llmproxy not found after npm install. Check your npm global prefix and PATH."
fi

# --- Register persistent service ---
info "$MSG_SERVICE"
if [ "$PLATFORM" = "windows" ]; then
  printf "%s\n" "$MSG_WINDOWS_NOTE"
fi

# --- Start persistent service and verify Docker runtime ---
if ! "$LLMPROXY_BIN" service:start 2>&1; then
  error "$MSG_SERVICE_FAIL"
fi

# --- Done ---
printf "\n"
info "╔══════════════════════════════════════════╗"
info "║  $MSG_DONE"
info "╚══════════════════════════════════════════╝"
printf "\n"
echo "$MSG_POST"
echo "$MSG_HELP"
