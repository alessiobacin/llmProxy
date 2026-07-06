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
  MSG_NODE_FAIL="Impossibile installare o aggiornare Node.js 22+ automaticamente."
  MSG_INSTALLING="Installazione di llmProxy..."
  MSG_INSTALL_FAIL="Installazione npm fallita."
  MSG_INSTALL_SOURCE="Sorgente installazione"
  MSG_INSTALL_RETRY_SUDO="npm install -g fallito, ritento con sudo"
  MSG_INSTALL_RETRY_LOCAL="Installazione globale non disponibile, passo a installazione user-local"
  MSG_INSTALL_USE_SUDO="Prefix npm globale non scrivibile, uso sudo per l'installazione"
  MSG_INSTALL_USE_LOCAL="Prefix npm globale non scrivibile e sudo non disponibile, uso installazione user-local"
  MSG_SERVICE="Avvio del servizio persistente in corso..."
  MSG_SERVICE_FAIL="Il servizio persistente non e' partito correttamente."
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
  MSG_NODE_FAIL="Could not install or upgrade Node.js 22+ automatically."
  MSG_INSTALLING="Installing llmProxy..."
  MSG_INSTALL_FAIL="npm install failed."
  MSG_INSTALL_SOURCE="Install source"
  MSG_INSTALL_RETRY_SUDO="npm install -g failed, retrying with sudo"
  MSG_INSTALL_RETRY_LOCAL="Global install unavailable, falling back to user-local install"
  MSG_INSTALL_USE_SUDO="Global npm prefix is not writable, using sudo for installation"
  MSG_INSTALL_USE_LOCAL="Global npm prefix is not writable and sudo is unavailable, using user-local install"
  MSG_SERVICE="Starting persistent service..."
  MSG_SERVICE_FAIL="The persistent service did not start correctly."
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

cleanup_global_service_port() {
  service_port="${1:-7045}"
  [ -n "$service_port" ] || return 0

  if has docker; then
    docker_ids="$(docker ps --format '{{.ID}} {{.Ports}}' 2>/dev/null | awk -v port="$service_port" 'index($0, ":" port "->") > 0 { print $1 }')"
    if [ -n "$docker_ids" ]; then
      for docker_id in $docker_ids; do
        docker stop "$docker_id" >/dev/null 2>&1 || run_root docker stop "$docker_id" >/dev/null 2>&1 || true
        docker rm "$docker_id" >/dev/null 2>&1 || run_root docker rm "$docker_id" >/dev/null 2>&1 || true
      done
    fi
  fi

  if has lsof; then
    listener_pids="$(lsof -tiTCP:"$service_port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$listener_pids" ]; then
      for listener_pid in $listener_pids; do
        kill "$listener_pid" >/dev/null 2>&1 || run_root kill "$listener_pid" >/dev/null 2>&1 || true
      done
      sleep 1
      listener_pids="$(lsof -tiTCP:"$service_port" -sTCP:LISTEN 2>/dev/null || true)"
      if [ -n "$listener_pids" ]; then
        for listener_pid in $listener_pids; do
          kill -9 "$listener_pid" >/dev/null 2>&1 || run_root kill -9 "$listener_pid" >/dev/null 2>&1 || true
        done
      fi
    fi
  fi
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

binary_node_major() {
  candidate="$1"
  [ -n "$candidate" ] || { printf "0\n"; return 0; }
  [ -x "$candidate" ] || { printf "0\n"; return 0; }
  "$candidate" -e 'console.log(process.version.slice(1).split(".")[0])' 2>/dev/null || printf "0\n"
}

find_node22_bin() {
  refresh_path
  candidates=""
  if has node; then
    candidates="$candidates $(command -v node)"
  fi
  if has nodejs; then
    candidates="$candidates $(command -v nodejs)"
  fi
  for fixed in /usr/bin/node /usr/local/bin/node /bin/node /usr/bin/nodejs /usr/local/bin/nodejs; do
    [ -x "$fixed" ] && candidates="$candidates $fixed"
  done

  for candidate in $candidates; do
    major="$(binary_node_major "$candidate")"
    if [ "$major" -ge 22 ] 2>/dev/null; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done
  return 1
}

activate_node22() {
  node22_bin="$(find_node22_bin || true)"
  [ -n "$node22_bin" ] || return 1
  node22_dir="$(dirname "$node22_bin")"
  node22_base="$(basename "$node22_bin")"
  shim_dir=""
  if [ "$node22_base" = "nodejs" ]; then
    shim_dir="${TMPDIR:-/tmp}/llmproxy-node22-shim"
    mkdir -p "$shim_dir"
    ln -sf "$node22_bin" "$shim_dir/node"
    if [ -x "$node22_dir/npm" ]; then
      ln -sf "$node22_dir/npm" "$shim_dir/npm"
    fi
    case ":$PATH:" in
      *":$shim_dir:"*) ;;
      *) PATH="$shim_dir:$PATH" ;;
    esac
  fi
  case ":$PATH:" in
    *":$node22_dir:"*) ;;
    *) PATH="$node22_dir:$PATH" ;;
  esac
  export PATH
  hash -r 2>/dev/null || true
  return 0
}

node_major() {
  activate_node22 >/dev/null 2>&1 || true
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
  activate_node22 >/dev/null 2>&1 || true
  has node && [ "$(node_major)" -ge 22 ] && has npm
}

ensure_node_ready() {
  refresh_path
  activate_node22 >/dev/null 2>&1 || true
  if has node && [ "$(node_major)" -ge 22 ] && has npm; then
    return 0
  fi
  install_node || error "$MSG_NODE_FAIL"
  refresh_path
  activate_node22 >/dev/null 2>&1 || true
  has node && [ "$(node_major)" -ge 22 ] && has npm || error "$MSG_NODE_FAIL"
}

LAST_CMD_LOG=""

run_quiet_capture() {
  LAST_CMD_LOG="${TMPDIR:-/tmp}/llmproxy-install-$$.log"
  : > "$LAST_CMD_LOG"
  if "$@" >"$LAST_CMD_LOG" 2>&1; then
    rm -f "$LAST_CMD_LOG"
    LAST_CMD_LOG=""
    return 0
  fi
  return 1
}

fail_with_last_cmd_log() {
  if [ -n "${LAST_CMD_LOG:-}" ] && [ -f "$LAST_CMD_LOG" ]; then
    cat "$LAST_CMD_LOG" >&2
    rm -f "$LAST_CMD_LOG"
    LAST_CMD_LOG=""
  fi
  error "$1"
}

npm_install_global_quiet() {
  run_quiet_capture npm install -g --silent --no-progress --fund=false --update-notifier=false "$@"
}

npm_prefix_writable() {
  prefix="$(npm prefix -g 2>/dev/null || true)"
  [ -n "$prefix" ] || return 1
  probe="$prefix"
  while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do
    probe=$(dirname "$probe")
  done
  [ -w "$probe" ]
}

resolve_effective_npm_prefix() {
  if [ "${USED_LOCAL_INSTALL:-0}" -eq 1 ]; then
    printf "%s\n" "$HOME/.local/share/llmproxy/npm-global"
    return 0
  fi
  if [ "${USED_SUDO_INSTALL:-0}" -eq 1 ] && [ "$PLATFORM" != "windows" ] && has sudo; then
    sudo npm prefix -g 2>/dev/null || true
    return 0
  fi
  npm prefix -g 2>/dev/null || true
}

ensure_unix_global_wrappers() {
  prefix="$1"
  [ -n "$prefix" ] || return 1
  package_cli="$prefix/lib/node_modules/llmproxy/bin/llmproxy.js"
  [ -f "$package_cli" ] || return 1
  mkdir -p "$prefix/bin"
  ln -sf ../lib/node_modules/llmproxy/bin/llmproxy.js "$prefix/bin/llmproxy"
  ln -sf ../lib/node_modules/llmproxy/bin/llmproxy.js "$prefix/bin/llmp"
  return 0
}

append_path_export_once() {
  profile_file="$1"
  bin_dir="$2"
  [ -n "$profile_file" ] || return 0
  [ -n "$bin_dir" ] || return 0
  line="export PATH=\"$bin_dir:\$PATH\""
  if [ ! -f "$profile_file" ]; then
    : > "$profile_file"
  fi
  grep -F "$line" "$profile_file" >/dev/null 2>&1 && return 0
  printf "\n%s\n" "$line" >> "$profile_file"
}

persist_npm_global_bin_path() {
  prefix="$1"
  [ -n "$prefix" ] || return 0
  case "$prefix" in
    "$HOME"/*) ;;
    *) return 0 ;;
  esac
  bin_dir="$prefix/bin"
  [ -d "$bin_dir" ] || return 0
  append_path_export_once "$HOME/.profile" "$bin_dir"
  append_path_export_once "$HOME/.bash_profile" "$bin_dir"
  append_path_export_once "$HOME/.zprofile" "$bin_dir"
  PATH="$bin_dir:$PATH"
  export PATH
  hash -r 2>/dev/null || true
}

resolve_installed_llmproxy_bin() {
  prefix="$1"
  package_cli=""
  if [ -n "$prefix" ]; then
    package_cli="$prefix/lib/node_modules/llmproxy/bin/llmproxy.js"
    if [ -x "$prefix/bin/llmproxy" ] && "$prefix/bin/llmproxy" version >/dev/null 2>&1; then
      printf "%s\n" "$prefix/bin/llmproxy"
      return 0
    fi
    if [ -x "$prefix/bin/llmp" ] && "$prefix/bin/llmp" version >/dev/null 2>&1; then
      printf "%s\n" "$prefix/bin/llmp"
      return 0
    fi
    if [ -f "$package_cli" ] && node "$package_cli" version >/dev/null 2>&1; then
      printf "%s\n" "$package_cli"
      return 0
    fi
  fi
  if has llmproxy; then
    candidate="$(command -v llmproxy)"
    if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" version >/dev/null 2>&1; then
      printf "%s\n" "$candidate"
      return 0
    fi
  fi
  if has llmp; then
    candidate="$(command -v llmp)"
    if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" version >/dev/null 2>&1; then
      printf "%s\n" "$candidate"
      return 0
    fi
  fi
  return 1
}

install_llmproxy_user_local() {
  local_prefix="$HOME/.local/share/llmproxy/npm-global"
  local_bin_dir="$HOME/.local/bin"
  mkdir -p "$local_prefix" "$local_bin_dir"
  run_quiet_capture npm install -g --prefix "$local_prefix" --silent --no-progress --fund=false --update-notifier=false "$INSTALL_SOURCE" || return 1
  if [ -x "$local_prefix/bin/llmproxy" ]; then
    ln -sf "$local_prefix/bin/llmproxy" "$local_bin_dir/llmproxy"
    PATH="$local_bin_dir:$local_prefix/bin:$PATH"
    export PATH
    hash -r 2>/dev/null || true
    return 0
  fi
  return 1
}

info "$MSG_DEPS"
refresh_path
ensure_node_ready

INSTALL_SOURCE="${LLMPROXY_INSTALL_SOURCE:-https://github.com/alessiobacin/llmProxy/archive/refs/heads/main.tar.gz}"
info "$MSG_INSTALLING"
printf "%s: %s\n" "$MSG_INSTALL_SOURCE" "$INSTALL_SOURCE"
USED_SUDO_INSTALL=0
USED_LOCAL_INSTALL=0
if [ "$PLATFORM" != "windows" ] && [ "$(id -u)" -ne 0 ]; then
  if npm_prefix_writable; then
    if ! npm_install_global_quiet "$INSTALL_SOURCE"; then
      if has sudo; then
        info "$MSG_INSTALL_USE_SUDO"
        if run_quiet_capture run_root npm install -g --silent --no-progress --fund=false --update-notifier=false "$INSTALL_SOURCE"; then
          USED_SUDO_INSTALL=1
        else
          warn "$MSG_INSTALL_RETRY_LOCAL"
          install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
          USED_LOCAL_INSTALL=1
        fi
      else
        warn "$MSG_INSTALL_RETRY_LOCAL"
        install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
        USED_LOCAL_INSTALL=1
      fi
    fi
  elif has sudo; then
    info "$MSG_INSTALL_USE_SUDO"
    if run_quiet_capture run_root npm install -g --silent --no-progress --fund=false --update-notifier=false "$INSTALL_SOURCE"; then
      USED_SUDO_INSTALL=1
    else
      warn "$MSG_INSTALL_RETRY_LOCAL"
      install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
      USED_LOCAL_INSTALL=1
    fi
  else
    info "$MSG_INSTALL_USE_LOCAL"
    install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
    USED_LOCAL_INSTALL=1
  fi
else
  if ! npm_install_global_quiet "$INSTALL_SOURCE"; then
    if [ "$PLATFORM" != "windows" ] && has sudo; then
      warn "$MSG_INSTALL_RETRY_SUDO"
      if run_quiet_capture run_root npm install -g --silent --no-progress --fund=false --update-notifier=false "$INSTALL_SOURCE"; then
        USED_SUDO_INSTALL=1
      else
        warn "$MSG_INSTALL_RETRY_LOCAL"
        install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
        USED_LOCAL_INSTALL=1
      fi
    else
      warn "$MSG_INSTALL_RETRY_LOCAL"
      install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
      USED_LOCAL_INSTALL=1
    fi
  fi
fi

NPM_GLOBAL_PREFIX="$(resolve_effective_npm_prefix)"
if [ "$PLATFORM" != "windows" ] && [ "$USED_LOCAL_INSTALL" -ne 1 ] && [ -n "${NPM_GLOBAL_PREFIX:-}" ]; then
  ensure_unix_global_wrappers "$NPM_GLOBAL_PREFIX" >/dev/null 2>&1 || true
  persist_npm_global_bin_path "$NPM_GLOBAL_PREFIX"
  if [ ! -f "$NPM_GLOBAL_PREFIX/lib/node_modules/llmproxy/bin/llmproxy.js" ]; then
    warn "$MSG_INSTALL_RETRY_LOCAL"
    install_llmproxy_user_local || fail_with_last_cmd_log "$MSG_INSTALL_FAIL"
    USED_LOCAL_INSTALL=1
    USED_SUDO_INSTALL=0
    NPM_GLOBAL_PREFIX="$(resolve_effective_npm_prefix)"
  fi
fi

LLMPROXY_BIN="$(resolve_installed_llmproxy_bin "${NPM_GLOBAL_PREFIX:-}" || true)"

[ -n "$LLMPROXY_BIN" ] || error "llmproxy not found after npm install. Check your npm global prefix and PATH."

info "$MSG_SERVICE"
if [ "$PLATFORM" = "windows" ]; then
  printf "%s\n" "$MSG_WINDOWS_NOTE"
fi

cleanup_global_service_port "${PORT:-7045}"

if ! env LLMPROXY_MODE=standalone LLMPROXY_SERVICE_RUNTIME=native "$LLMPROXY_BIN" service:start 2>&1; then
  warn "$MSG_SERVICE_RETRY"
  sleep 2
  cleanup_global_service_port "${PORT:-7045}"
  env LLMPROXY_MODE=standalone LLMPROXY_SERVICE_RUNTIME=native "$LLMPROXY_BIN" service:restart 2>&1 || error "$MSG_SERVICE_FAIL"
fi

printf "\n"
info "╔══════════════════════════════════════════╗"
info "║  $MSG_DONE"
info "╚══════════════════════════════════════════╝"
printf "\n"
echo "$MSG_POST"
echo "$MSG_HELP"
