#!/bin/sh
# llmProxy one-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/alessiobacin/llmProxy/main/scripts/install.sh | sh
#    or: wget -qO- https://raw.githubusercontent.com/alessiobacin/llmProxy/main/scripts/install.sh | sh

set -eu

if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; NC=''
fi

info()  { printf "${GREEN}%s${NC}\n" "$1"; }
warn()  { printf "${YELLOW}WARN:${NC} %s\n" "$1"; }
error() { printf "${RED}ERROR:${NC} %s\n" "$1"; exit 1; }
has()   { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  MSYS*|MINGW*|CYGWIN*) PLATFORM="windows" ;;
  *) error "Unsupported OS '$OS'. llmProxy supports macOS, Linux, and Windows (via Git Bash / WSL)." ;;
esac

case "${LANG:-}" in
  it_IT*|it_CH*) LOCALE="it" ;;
  *) LOCALE="en" ;;
esac

if [ "$LOCALE" = "it" ]; then
  MSG_DEPS="Verifica dipendenze..."
  MSG_NODE_INSTALL="Installazione/aggiornamento Node.js 22+..."
  MSG_DOCKER_INSTALL="Installazione/avvio Docker..."
  MSG_COMPOSE_INSTALL="Installazione Docker Compose..."
  MSG_NODE_FAIL="Impossibile installare o aggiornare Node.js 22+ automaticamente."
  MSG_DOCKER_FAIL="Impossibile installare o avviare Docker automaticamente."
  MSG_COMPOSE_FAIL="Impossibile installare Docker Compose automaticamente."
  MSG_INSTALLING="Installazione di llmProxy..."
  MSG_INSTALL_FAIL="Installazione npm fallita."
  MSG_INSTALL_SOURCE="Sorgente installazione"
  MSG_SERVICE="Avvio del servizio persistente in corso..."
  MSG_SERVICE_FAIL="Il servizio persistente o il runtime Docker non sono partiti correttamente."
  MSG_SERVICE_RETRY="service:start fallito, ritento con service:restart"
  MSG_DONE="Installazione completata!"
  MSG_POST="Ora configura un provider: llmproxy provider:add copilot"
  MSG_HELP="    llmproxy help"
  MSG_WINDOWS_NOTE="Avvia PowerShell come Amministratore se vedi prompt di elevazione."
  MSG_BREW="Homebrew non trovato: installazione automatica in corso..."
  MSG_SUDO_REQUIRED="Richiesti permessi amministrativi (sudo)."
else
  MSG_DEPS="Checking dependencies..."
  MSG_NODE_INSTALL="Installing/upgrading Node.js 22+..."
  MSG_DOCKER_INSTALL="Installing/starting Docker..."
  MSG_COMPOSE_INSTALL="Installing Docker Compose..."
  MSG_NODE_FAIL="Could not install or upgrade Node.js 22+ automatically."
  MSG_DOCKER_FAIL="Could not install or start Docker automatically."
  MSG_COMPOSE_FAIL="Could not install Docker Compose automatically."
  MSG_INSTALLING="Installing llmProxy..."
  MSG_INSTALL_FAIL="npm install failed."
  MSG_INSTALL_SOURCE="Install source"
  MSG_SERVICE="Starting persistent service..."
  MSG_SERVICE_FAIL="The persistent service or Docker runtime did not start correctly."
  MSG_SERVICE_RETRY="service:start failed, retrying with service:restart"
  MSG_DONE="Installation complete!"
  MSG_POST="Next step: add a provider — llmproxy provider:add copilot"
  MSG_HELP="    llmproxy help"
  MSG_WINDOWS_NOTE="Run PowerShell as Administrator if you see elevation prompts."
  MSG_BREW="Homebrew not found: installing it automatically..."
  MSG_SUDO_REQUIRED="Administrative privileges required (sudo)."
fi

FETCH_URL() {
  if has curl; then
    curl -fsSL "$1"
    return 0
  fi
  if has wget; then
    wget -qO- "$1"
    return 0
  fi
  return 1
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return $?
  fi
  if has sudo; then
    sudo "$@"
    return $?
  fi
  error "$MSG_SUDO_REQUIRED"
}

refresh_path() {
  for extra in \
    "/opt/homebrew/bin" \
    "/opt/homebrew/opt/node@22/bin" \
    "/usr/local/bin" \
    "/usr/local/opt/node@22/bin" \
    "$HOME/.npm-global/bin" \
    "$HOME/.local/bin" \
    "/c/Program Files/nodejs" \
    "/c/Program Files (x86)/nodejs"
  do
    case ":$PATH:" in
      *":$extra:"*) ;;
      *) [ -d "$extra" ] && PATH="$extra:$PATH" ;;
    esac
  done
  export PATH
}

node_major() {
  if ! has node; then
    printf "0\n"
    return 0
  fi
  node -e 'console.log(process.version.slice(1).split(".")[0])' 2>/dev/null || printf "0\n"
}

install_homebrew_if_missing() {
  if has brew; then
    return 0
  fi
  info "$MSG_BREW"
  NONINTERACTIVE=1 /bin/bash -c "$(FETCH_URL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || return 1
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  refresh_path
  has brew
}

install_node() {
  info "$MSG_NODE_INSTALL"
  case "$PLATFORM" in
    darwin)
      install_homebrew_if_missing || return 1
      brew install node@22 || brew upgrade node@22 || return 1
      refresh_path
      ;;
    linux)
      if has apt-get; then
        FETCH_URL https://deb.nodesource.com/setup_22.x | run_root bash -
        run_root apt-get install -y nodejs
      elif has dnf; then
        FETCH_URL https://rpm.nodesource.com/setup_22.x | run_root bash -
        run_root dnf install -y nodejs
      elif has yum; then
        FETCH_URL https://rpm.nodesource.com/setup_22.x | run_root bash -
        run_root yum install -y nodejs
      elif has zypper; then
        run_root zypper --non-interactive install nodejs22 npm22 || run_root zypper --non-interactive install nodejs npm
      elif has pacman; then
        run_root pacman -Sy --noconfirm nodejs npm
      elif has apk; then
        run_root apk add --no-cache nodejs npm
      else
        return 1
      fi
      refresh_path
      ;;
    windows)
      if has powershell.exe; then
        powershell.exe -NoProfile -Command \
          "if (Get-Command winget -ErrorAction SilentlyContinue) { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --disable-interactivity } elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install nodejs-lts -y } else { exit 1 }" \
          || return 1
        refresh_path
      else
        return 1
      fi
      ;;
  esac
  has node && [ "$(node_major)" -ge 22 ] && has npm
}

wait_for_docker() {
  tries=0
  while [ "$tries" -lt 60 ]; do
    if has docker && docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    tries=$((tries + 1))
  done
  return 1
}

install_docker() {
  info "$MSG_DOCKER_INSTALL"
  case "$PLATFORM" in
    darwin)
      install_homebrew_if_missing || return 1
      brew install --cask docker || return 1
      open -a Docker || true
      ;;
    linux)
      if ! has docker; then
        FETCH_URL https://get.docker.com | run_root sh
      fi
      if has systemctl; then
        run_root systemctl enable --now docker || true
      elif has service; then
        run_root service docker start || true
      fi
      ;;
    windows)
      if has powershell.exe; then
        powershell.exe -NoProfile -Command \
          "if (Get-Command winget -ErrorAction SilentlyContinue) { winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements --disable-interactivity } elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install docker-desktop -y } else { exit 1 }" \
          || return 1
        powershell.exe -NoProfile -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -ErrorAction SilentlyContinue" || true
      else
        return 1
      fi
      ;;
  esac
  refresh_path
  wait_for_docker
}

install_docker_compose() {
  info "$MSG_COMPOSE_INSTALL"
  case "$PLATFORM" in
    darwin)
      # Docker Desktop already includes compose. Just re-check after launch.
      wait_for_docker || return 1
      ;;
    linux)
      if has apt-get; then
        run_root apt-get install -y docker-compose-plugin || run_root apt-get install -y docker-compose
      elif has dnf; then
        run_root dnf install -y docker-compose-plugin || run_root dnf install -y docker-compose
      elif has yum; then
        run_root yum install -y docker-compose-plugin || run_root yum install -y docker-compose
      elif has zypper; then
        run_root zypper --non-interactive install docker-compose || return 1
      elif has pacman; then
        run_root pacman -Sy --noconfirm docker-compose || return 1
      elif has apk; then
        run_root apk add --no-cache docker-cli-compose docker-compose || return 1
      else
        return 1
      fi
      ;;
    windows)
      wait_for_docker || return 1
      ;;
  esac
  (docker compose version >/dev/null 2>&1) || has docker-compose
}

ensure_node_ready() {
  refresh_path
  if has node && [ "$(node_major)" -ge 22 ] && has npm; then
    return 0
  fi
  install_node || error "$MSG_NODE_FAIL"
  refresh_path
  has node && [ "$(node_major)" -ge 22 ] && has npm || error "$MSG_NODE_FAIL"
}

ensure_docker_ready() {
  refresh_path
  if has docker && docker info >/dev/null 2>&1; then
    return 0
  fi
  install_docker || error "$MSG_DOCKER_FAIL"
  has docker && docker info >/dev/null 2>&1 || error "$MSG_DOCKER_FAIL"
}

ensure_compose_ready() {
  if docker compose version >/dev/null 2>&1 || has docker-compose; then
    return 0
  fi
  install_docker_compose || error "$MSG_COMPOSE_FAIL"
  docker compose version >/dev/null 2>&1 || has docker-compose || error "$MSG_COMPOSE_FAIL"
}

info "$MSG_DEPS"
refresh_path
ensure_node_ready
ensure_docker_ready
ensure_compose_ready

INSTALL_SOURCE="${LLMPROXY_INSTALL_SOURCE:-https://github.com/alessiobacin/llmProxy/archive/refs/heads/main.tar.gz}"
info "$MSG_INSTALLING"
printf "%s: %s\n" "$MSG_INSTALL_SOURCE" "$INSTALL_SOURCE"
npm install -g "$INSTALL_SOURCE" 2>&1 || error "$MSG_INSTALL_FAIL"

LLMPROXY_BIN=""
if has llmproxy; then
  LLMPROXY_BIN="$(command -v llmproxy)"
else
  NPM_GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_GLOBAL_PREFIX" ] && [ -x "$NPM_GLOBAL_PREFIX/bin/llmproxy" ]; then
    LLMPROXY_BIN="$NPM_GLOBAL_PREFIX/bin/llmproxy"
  fi
fi

[ -n "$LLMPROXY_BIN" ] || error "llmproxy not found after npm install. Check your npm global prefix and PATH."

info "$MSG_SERVICE"
if [ "$PLATFORM" = "windows" ]; then
  printf "%s\n" "$MSG_WINDOWS_NOTE"
fi

if ! "$LLMPROXY_BIN" service:start 2>&1; then
  warn "$MSG_SERVICE_RETRY"
  sleep 2
  "$LLMPROXY_BIN" service:restart 2>&1 || error "$MSG_SERVICE_FAIL"
fi

printf "\n"
info "╔══════════════════════════════════════════╗"
info "║  $MSG_DONE"
info "╚══════════════════════════════════════════╝"
printf "\n"
echo "$MSG_POST"
echo "$MSG_HELP"
