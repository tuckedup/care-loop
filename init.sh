#!/usr/bin/env bash
# CareLoop init: install, migrate, seed, and start the dev server in the background.
# Idempotent. Run at the start of every session (see CLAUDE.md). Never writes .env files.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-3000}"
STATE_DIR=".init"
PID_FILE="$STATE_DIR/dev.pid" # wrapper PID only; stop the server by port
LOG_FILE="$STATE_DIR/dev.log"
mkdir -p "$STATE_DIR"

# Environment: prefer a human-managed .env; otherwise fall back to the .env.example defaults.
set -a
if [ -f .env ]; then
  # shellcheck disable=SC1091
  . ./.env
else
  echo "init: no .env found, using .env.example defaults (copy it to .env to customise)."
  # shellcheck disable=SC1091
  . ./.env.example
fi
set +a

DATABASE_URL="${DATABASE_URL:-postgres://careloop:careloop@127.0.0.1:54329/careloop}"
export DATABASE_URL
NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-dev}"
export NEXT_DIST_DIR

run_pnpm() {
  pnpm exec cross-env "DATABASE_URL=$DATABASE_URL" pnpm "$@"
}

port_ready() {
  pnpm exec cross-env "DATABASE_URL=$DATABASE_URL" "PORT=$PORT" pnpm exec node scripts/wait-local-port.mjs "$PORT"
}

echo "init: installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Local Postgres via docker compose when available and nothing is listening yet.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "init: starting local Postgres (docker compose)"
  docker compose up -d --wait db || echo "init: WARNING docker compose failed; continuing without a local DB."
else
  echo "init: docker not available; assuming DATABASE_URL points at a running Postgres (or none yet)."
fi

echo "init: migrating"
run_pnpm db:migrate
echo "init: seeding"
run_pnpm db:seed

# Reuse a dev server that already answers; otherwise start one. (Killing the nohup wrapper PID
# does not stop the node child on Windows/Git Bash, so we never try to restart blindly.)
if port_ready >/dev/null 2>&1; then
  echo "init: dev server already running at http://localhost:$PORT (reusing)"
  exit 0
fi

echo "init: starting dev server on :$PORT (log: $LOG_FILE)"
nohup pnpm exec cross-env "DATABASE_URL=$DATABASE_URL" "PORT=$PORT" "NEXT_DIST_DIR=$NEXT_DIST_DIR" pnpm dev >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

for i in $(seq 1 60); do
  if port_ready >/dev/null 2>&1; then
    echo "init: dev server ready at http://localhost:$PORT"
    exit 0
  fi
  sleep 1
done

echo "init: dev server did not become ready in 60s; see $LOG_FILE" >&2
exit 1
