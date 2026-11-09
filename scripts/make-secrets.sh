#!/bin/sh
# Creates ./secrets/session_secret (random) with owner-only permissions. It never touches
# anthropic_api_key: create that yourself without putting the key in shell history, e.g.
#   (read -rs KEY && printf '%s' "$KEY" > secrets/anthropic_api_key); chmod 600 secrets/anthropic_api_key
set -eu
mkdir -p secrets
umask 077
if [ ! -s secrets/session_secret ]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" > secrets/session_secret
  echo "created secrets/session_secret"
else
  echo "secrets/session_secret already exists"
fi
