# claude-progress.md

Append a dated entry at the end of every session. Newest last.

## 2026-11-06 — Initializer session (no features built)

Done:

- Read CLAUDE.md, docs/SPEC.md, docs/sources.md, .claude/ (settings, 2 agents, 3 skills).
- Wrote feature_list.json (see file for count; all `passes: false`).
- Scaffolded Next.js 15 App Router + TypeScript strict + Tailwind 4 + Drizzle + Vitest +
  Playwright + ESLint + Prettier, with pnpm scripts matching CLAUDE.md.
- Added .env.example, .gitignore, MIT LICENSE, CHANGELOG.md, docker-compose.yml (local Postgres),
  GitHub Actions CI (typecheck, lint, unit, eval on fixtures, e2e), init.sh.
- Stub docs: DECISIONS.md (ADR-001), STANDARDS.md, MODEL_CARD.md, AI_AGENTS.md.
- Scaffold-only code: src/config.ts (+ test), landing page, e2e/smoke.spec.ts, script stubs.

State: `pnpm test` is green on the scaffold. Script stubs `projections:rebuild`, `audit:verify`,
`outbox:work` exit 1 until their features land (db:migrate/db:seed are no-ops until F001/F013).

Next session: pick the first `passes: false` feature in feature_list.json (F001).

Notes for future sessions:

- DB tests need Postgres: `docker compose up -d db` (port 54329) or set DATABASE_URL.
- Zod is v4, Vitest v3, TypeScript 5.9, ESLint 9 (flat config via FlatCompat), Next ~15.5.
- Hooks block `.env*` edits; init.sh never writes .env (falls back to .env.example values).
