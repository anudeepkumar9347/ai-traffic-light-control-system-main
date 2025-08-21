#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
RUN_DIR="$PROJECT_ROOT/.run"
LOG_DIR="$PROJECT_ROOT/logs"
BACKEND_PID="$RUN_DIR/backend.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"

mkdir -p "$RUN_DIR" "$LOG_DIR"

# Defaults (can be overridden):
BACKEND_PORT_DEFAULT=8000
FRONTEND_PORT_DEFAULT=5500

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -E "[:\.]${port}$" >/dev/null 2>&1 && return 0 || return 1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -Pn >/dev/null 2>&1 && return 0 || return 1
  else
    # Fallback: attempt to bind with Python
    python3 - "$port" >/dev/null 2>&1 <<'PY'
import socket, sys
p=int(sys.argv[1])
s=socket.socket();
try:
    s.bind(("127.0.0.1", p))
    print("FREE")
except OSError:
    print("BUSY")
PY
    [[ "$(python3 - "$port" 2>/dev/null <<'PY'
import socket, sys
p=int(sys.argv[1])
s=socket.socket();
try:
    s.bind(("127.0.0.1", p))
    print("FREE")
except OSError:
    print("BUSY")
PY
)" == "BUSY" ]] && return 0 || return 1
  fi
}

find_free_port() {
  local start="$1"; local end="$2"; local p
  for ((p=start; p<=end; p++)); do
    if ! port_in_use "$p"; then echo "$p"; return 0; fi
  done
  echo ""; return 1
}

start_backend() {
  local port="$1"
  echo "[backend] Starting on port $port"
  # Create/activate venv
  if [[ ! -d "$BACKEND_DIR/.venv" ]]; then
    python3 -m venv "$BACKEND_DIR/.venv"
  fi
  # shellcheck disable=SC1091
  source "$BACKEND_DIR/.venv/bin/activate"
  pip install --upgrade pip >/dev/null
  pip install -r "$BACKEND_DIR/requirements.txt" >/dev/null
  # Start server
  cd "$BACKEND_DIR"
  nohup uvicorn app:app --host 0.0.0.0 --port "$port" >"$LOG_DIR/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID"
  echo "[backend] PID $(cat "$BACKEND_PID"), log: $LOG_DIR/backend.log"
}

start_frontend() {
  local port="$1"
  echo "[frontend] Starting on port $port"
  cd "$PROJECT_ROOT"
  nohup python3 -m http.server "$port" --directory "$FRONTEND_DIR" >"$LOG_DIR/frontend.log" 2>&1 &
  echo $! > "$FRONTEND_PID"
  echo "[frontend] PID $(cat "$FRONTEND_PID"), log: $LOG_DIR/frontend.log"
}

stop_service() {
  local name="$1"; local pid_file="$2"
  if [[ -f "$pid_file" ]]; then
    local pid; pid=$(cat "$pid_file" || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "[$name] Stopping PID $pid"
      kill "$pid" || true
      sleep 0.5
      if kill -0 "$pid" >/dev/null 2>&1; then
        echo "[$name] Force killing PID $pid"
        kill -9 "$pid" || true
      fi
    fi
    rm -f "$pid_file"
  else
    echo "[$name] Not running (no PID file)"
  fi
}

status_service() {
  local name="$1"; local pid_file="$2"
  if [[ -f "$pid_file" ]]; then
    local pid; pid=$(cat "$pid_file" || true)
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "[$name] Running (PID $pid)"
    else
      echo "[$name] Not running (stale PID file)"
    fi
  else
    echo "[$name] Not running"
  fi
}

cmd="${1:-start}"
BACKEND_PORT="${2:-${BACKEND_PORT:-$BACKEND_PORT_DEFAULT}}"
FRONTEND_PORT="${3:-${FRONTEND_PORT:-$FRONTEND_PORT_DEFAULT}}"

case "$cmd" in
  start)
    # Pick ports if in use
    if port_in_use "$BACKEND_PORT"; then
      echo "[backend] Port $BACKEND_PORT busy, searching for a free port..."
      BACKEND_PORT="$(find_free_port 8000 8010)" || { echo "No free backend port found"; exit 1; }
    fi
    if port_in_use "$FRONTEND_PORT"; then
      echo "[frontend] Port $FRONTEND_PORT busy, searching for a free port..."
      FRONTEND_PORT="$(find_free_port 5500 5510)" || { echo "No free frontend port found"; exit 1; }
    fi
    start_backend "$BACKEND_PORT"
    start_frontend "$FRONTEND_PORT"
    echo
    echo "Backend:  http://127.0.0.1:$BACKEND_PORT (API: /health, /help, /state, /traffic)"
    echo "Frontend: http://127.0.0.1:$FRONTEND_PORT"
    echo "Tip: Set 'Backend URL' in the frontend to http://127.0.0.1:$BACKEND_PORT if different."
    ;;
  stop)
    stop_service backend "$BACKEND_PID"
    stop_service frontend "$FRONTEND_PID"
    ;;
  status)
    status_service backend "$BACKEND_PID"
    status_service frontend "$FRONTEND_PID"
    ;;
  *)
    echo "Usage: $0 [start|stop|status] [BACKEND_PORT] [FRONTEND_PORT]" >&2
    exit 1
    ;;
esac
