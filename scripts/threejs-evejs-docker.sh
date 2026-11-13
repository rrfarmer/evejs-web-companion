#!/usr/bin/env bash
# EveJS in Docker for the three.js play page: build an image from eve.js HEAD (committed code
# only), fill the store volume from a copy of the live game store, start ONLY the server
# container. The market daemon (evejs-market-1) and every other container are left alone.
#
#   scripts/threejs-evejs-docker.sh build          image evejs-local:threejs-<sha>
#   scripts/threejs-evejs-docker.sh store [dir]    (re)fill volume evejs-threejs-store from a host
#                                                  copy (default _local/evejs-store/gameStore)
#   scripts/threejs-evejs-docker.sh up             start/recreate the server container
#   scripts/threejs-evejs-docker.sh down           stop and remove the server container only
#   scripts/threejs-evejs-docker.sh bff            start the host BFF, detached (logs in _local/evejs-store); it
#                                                  serves the client's pictures (EVEJS_CLIENT_ROOT, native layer off)
#   scripts/threejs-evejs-docker.sh bff-stop       stop it
#
# Env: EVEJS_ROOT (default ../eve.js, else ../EveOffline), EVEJS_WEB_GATEWAY_TOKEN (default: read from
# _local/evejs-store/gateway-token, made on first use), EVEJS_THREEJS_IMAGE (default: newest
# evejs-local:threejs-* tag).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
# The eve.js checkout is `eve.js` on some machines and `EveOffline` (its GitHub name) on others.
if [[ -z "${EVEJS_ROOT:-}" ]]; then
  for cand in "$HERE/../eve.js" "$HERE/../EveOffline"; do
    [[ -f "$cand/compose.yaml" ]] && { EVEJS_ROOT="$cand"; break; }
  done
  : "${EVEJS_ROOT:?no eve.js checkout next to this repo (../eve.js or ../EveOffline): set EVEJS_ROOT}"
fi
STORE_DIR="$HERE/_local/evejs-store"
mkdir -p "$STORE_DIR"
TOKEN_FILE="$STORE_DIR/gateway-token"
if [[ -z "${EVEJS_WEB_GATEWAY_TOKEN:-}" ]]; then
  [[ -f "$TOKEN_FILE" ]] || node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))' > "$TOKEN_FILE"
  EVEJS_WEB_GATEWAY_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
fi
export EVEJS_WEB_GATEWAY_TOKEN

compose() {
  docker compose -p evejs -f "$EVEJS_ROOT/compose.yaml" -f "$HERE/compose.evejs-threejs.yaml" "$@"
}

newest_image() {
  docker image ls evejs-local --format '{{.Tag}} {{.CreatedAt}}' | grep '^threejs-' | sort -k2 -r | head -1 | cut -d' ' -f1
}

case "${1:-}" in
  build)
    sha="$(git -C "$EVEJS_ROOT" rev-parse --short HEAD)"
    echo "building evejs-local:threejs-$sha from $(git -C "$EVEJS_ROOT" branch --show-current) HEAD"
    git -C "$EVEJS_ROOT" archive --format=tar HEAD | docker build -t "evejs-local:threejs-$sha" -f Dockerfile -
    ;;
  store)
    src="${2:-$STORE_DIR/gameStore}"
    [[ -f "$src/gamestore.sqlite" ]] || { echo "no gamestore.sqlite in $src" >&2; exit 1; }
    docker volume create evejs-threejs-store >/dev/null
    # node (uid 1000) owns the store inside the image
    MSYS_NO_PATHCONV=1 docker run --rm -v evejs-threejs-store:/dst -v "$(cd "$src" && pwd -W 2>/dev/null || pwd)":/src:ro alpine:3.20 \
      sh -c 'rm -rf /dst/* && cp -a /src/. /dst/ && chown -R 1000:1000 /dst && du -sh /dst'
    ;;
  up)
    export EVEJS_THREEJS_IMAGE="${EVEJS_THREEJS_IMAGE:-evejs-local:$(newest_image)}"
    echo "server from $EVEJS_THREEJS_IMAGE"
    compose up -d --no-deps server
    ;;
  down)
    export EVEJS_THREEJS_IMAGE="${EVEJS_THREEJS_IMAGE:-evejs-local:$(newest_image)}"
    compose stop server && compose rm -f server
    ;;
  bff)
    # The BFF on the host, detached (it must outlive this shell), on the same store copy the container
    # started from (accounts, static tables), with the shared gateway token. Logs and PID in _local/evejs-store.
    pidfile="$STORE_DIR/bff.pid"
    if [[ -f "$pidfile" ]] && tasklist //FI "PID eq $(cat "$pidfile")" 2>/dev/null | grep -q node; then
      echo "BFF already running (pid $(cat "$pidfile"))"; exit 0
    fi
    win() { cygpath -w "$1"; }
    # PowerShell writes the PID itself and gets no pipe from this shell: the node it starts inherits
    # PowerShell's handles, and a pipe it held would keep this command waiting for as long as the BFF runs.
    powershell.exe -NoProfile -Command "
      \$env:EVEJS_WEB_GATEWAY_TOKEN = '$EVEJS_WEB_GATEWAY_TOKEN';
      \$env:EVEJS_GAMESTORE_DATA_DIR = '$(win "$STORE_DIR/gameStore/data")';
      \$env:EVEJS_GAMESTORE_DB = '$(win "$STORE_DIR/gameStore/gamestore.sqlite")';
      \$env:EVEJS_ROOT = '$(win "$EVEJS_ROOT")';
      \$env:EVEJS_CLIENT_ROOT = '$(win "${EVE_CLIENT_DIR:-$HOME/Documents/EVE Online - 3396210}")';
      \$env:EVEJS_NATIVE_CLIENT = 'off';
      \$env:EVEJS_PUBLIC_GATEWAY_URL = 'https://127.0.0.1:443';
      \$p = Start-Process node -ArgumentList '--env-file-if-exists=.env','src/server.js' -WorkingDirectory '$(win "$HERE")' -WindowStyle Hidden -RedirectStandardOutput '$(win "$STORE_DIR/bff.out.log")' -RedirectStandardError '$(win "$STORE_DIR/bff.err.log")' -PassThru;
      Set-Content -Path '$(win "$pidfile")' -Value \$p.Id -NoNewline" < /dev/null > /dev/null 2>&1
    echo "BFF started (pid $(cat "$pidfile")), logs in $STORE_DIR/bff.*.log"
    ;;
  bff-stop)
    pidfile="$STORE_DIR/bff.pid"
    [[ -f "$pidfile" ]] && taskkill //PID "$(cat "$pidfile")" //T //F >/dev/null 2>&1; rm -f "$pidfile"; echo "BFF stopped"
    ;;
  *)
    sed -n '2,15p' "$0"; exit 2
    ;;
esac
