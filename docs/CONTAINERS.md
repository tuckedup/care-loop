# Running CareLoop in containers

Synthetic data only. Containers make the demo reproducible; they do not make it a clinical service
(see `PRODUCTION_READINESS.md`). Demo auth is not real authentication.

## Design rules (secrets never leak)

- No secret is in the image. The `Dockerfile` has no `ARG`/`ENV` for keys, `.dockerignore` keeps
  `.env*`, `secrets/` and `.git` out of the build context, and `scripts/containers.test.ts` fails if
  that changes.
- Secrets are **mounted files** under `/run/secrets` (Compose secrets). `docker/entrypoint.sh` reads
  `<NAME>_FILE` into the environment of the one process it starts and never prints the value.
- The runtime image is the minimal standalone Next.js server, runs as the non-root `node` user, with
  a read-only root filesystem, all capabilities dropped and `no-new-privileges`.
- The app port is bound to `127.0.0.1` only. The database is not published by the app file.
- `secrets/` is git-ignored. Do not paste a key into chat, issues, commit messages or shell history.

## Run the app

```
sh scripts/make-secrets.sh        # creates secrets/session_secret (random)
docker compose -f docker-compose.yml -f docker-compose.app.yml --profile app up -d --build
```

Open http://localhost:3000. `migrate` runs first. To load the synthetic seed data once:
`docker compose -f docker-compose.yml -f docker-compose.app.yml --profile tools run --rm seed`.

## Run the live-model eval (guarded)

1. Create the key file without leaving it in shell history (Git Bash or Linux/macOS):
   `(read -rs KEY && printf '%s' "$KEY" > secrets/anthropic_api_key); chmod 600 secrets/anthropic_api_key`
2. `ANTHROPIC_MODEL=<model id> docker compose -f docker-compose.yml -f docker-compose.app.yml --profile live-eval run --build --rm eval-live`
3. The result is written to `evals/results/live-latest.json` (git-ignored) and shown on the admin
   Evals page as a live run. Report recall with Wilson intervals (`LIVE_EVAL.md`). Only synthetic cases
   are sent to the model. A live pass is not clinical validation.

Without the key file or the model id the run refuses to start and writes nothing.

## Rotating or removing a key

Delete or replace the file in `secrets/` and recreate the container. If a key was ever exposed,
revoke it in the provider console first; deleting a file does not un-leak it.
