#!/bin/sh
# Load secrets from files (Docker/Compose secrets are mounted under /run/secrets) into the
# environment of the one process we exec. Values are never printed, logged or written to disk.
set -eu
for name in ANTHROPIC_API_KEY SESSION_SECRET CRON_SECRET DATABASE_URL; do
  eval "file=\${${name}_FILE:-}"
  if [ -n "$file" ]; then
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      echo "entrypoint: ${name}_FILE is set but is not a readable file (create it under secrets/)" >&2
      exit 1
    fi
    value=$(cat "$file")
    export "$name=$value"
  fi
done
exec "$@"
