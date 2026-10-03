#!/usr/bin/env bash
# Local dev launcher for Sailor: the Nuxt server on 127.0.0.1:3002, the only
# server the app needs (no ComfyUI and no Python since step 4).
#
# "Kill & take over": on start it frees the port first, and on exit (Ctrl-C or
# the server dying) it reaps the server and any children still holding the
# port. Quitting never leaves orphans behind.
#
# Usage:
#   ./dev.sh            start (default)
#   ./dev.sh status     show what's on the port
#   ./dev.sh stop       kill whatever is on the port and exit
#
# This is the LOCAL launcher. start.sh is the production/Fly.io one; don't use
# it locally.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_PORT=3002

port_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

kill_port() {
  local port=$1 pids
  pids=$(port_pids "$port")
  [ -z "$pids" ] && return 0
  echo "[dev] freeing :$port (killing $pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids=$(port_pids "$port")
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

status() {
  local pids; pids=$(port_pids "$FRONTEND_PORT")
  if [ -n "$pids" ]; then echo "[dev] :$FRONTEND_PORT  LISTEN  (pid $pids)"; else echo "[dev] :$FRONTEND_PORT  free"; fi
}

case "${1:-start}" in
  status) status; exit 0 ;;
  stop)   kill_port "$FRONTEND_PORT"; echo "[dev] stopped."; exit 0 ;;
  start)  ;;
  *)      echo "usage: ./dev.sh [start|stop|status]"; exit 2 ;;
esac

kill_port "$FRONTEND_PORT"

FRONTEND_PID=""
cleanup() {
  echo
  echo "[dev] shutting down..."
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  # nuxt/vite spawn children that outlive the parent — reap them by port.
  kill_port "$FRONTEND_PORT"
  wait 2>/dev/null || true
  echo "[dev] done."
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "[dev] starting Sailor on :$FRONTEND_PORT ..."
( cd "$ROOT/frontend" && exec pnpm dev ) &
FRONTEND_PID=$!

echo "[dev] Sailor → http://127.0.0.1:$FRONTEND_PORT"
echo "[dev] Ctrl-C to stop."
wait "$FRONTEND_PID"
