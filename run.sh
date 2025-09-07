#!/usr/bin/env bash
set -euo pipefail

# Project root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
VENV_DIR="$ROOT_DIR/.venv"
PYTHON_BIN=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

log(){ echo -e "${YELLOW}[*]${NC} $*"; }
ok(){ echo -e "${GREEN}[ok]${NC} $*"; }
err(){ echo -e "${RED}[err]${NC} $*" 1>&2; }

# Pick a python
if [[ -x "$VENV_DIR/bin/python" ]]; then
  PYTHON_BIN="$VENV_DIR/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  err "Python not found. Please install Python 3.10+"
  exit 1
fi

# Ensure virtualenv exists
if [[ ! -d "$VENV_DIR" ]]; then
  log "Creating virtual environment at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Upgrade pip and install dependencies if needed
log "Installing backend dependencies (if needed)"
pip install --upgrade pip >/dev/null
pip install -r "$BACKEND_DIR/requirements.txt"

# Kill any running app.py to avoid port conflicts
if pgrep -af "python.*app.py" >/dev/null 2>&1; then
  log "Stopping existing Flask process"
  pkill -f "python.*app.py" || true
  sleep 1
fi

# Run the backend app
log "Starting Flask server"
cd "$BACKEND_DIR"
export FLASK_ENV=development
exec "$VENV_DIR/bin/python" app.py
