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

## 2026-11-06 — Bootstrap fixes + F001 (events table)

Done:

- Applied review findings to feature_list.json (now 70 features): hash-chained audit_log moved to
  F004 (right after the event store) so no persisted write ever uses a no-op auditor; old F053
  became an audit-coverage test. Added F030 "Eval gate": pnpm eval must fail on zero cases and
  recall < 1.0 before any AI feature (F031+) may pass. Admin eval page merged into the dashboard.
- git init on main; bootstrap commit 741c679. Added .gitattributes (LF) and ignored
  .claude/scheduled_tasks.lock.
- F001: Drizzle `events` table (src/infra/db/schema.ts), generated migration
  drizzle/0000_create_events.sql, shared runMigrations (src/infra/db/migrate.ts, journal kept in
  the migrated schema), db:migrate script, isolated-schema Postgres test helper
  (src/test/db.ts), tests in src/infra/db/schema.test.ts.
- Verified: `pnpm db:migrate` (twice, idempotent), `pnpm test src/infra/db/schema.test.ts`
  (5/5), typecheck, lint, format:check, full `pnpm test` (9/9). verifier subagent: PASS.
  F001 set to passes:true.

Notes:

- Postgres runs via `docker compose up -d --wait db` (port 54329); Docker Desktop had to be
  started manually. DATABASE_URL for scripts: `set -a; . ./.env.example; set +a`. The test helper
  falls back to the same local URL.
- postgres.js: `sql.json()` failed with untyped params under vitest; tests use
  `JSON.stringify(x)::jsonb`. timestamptz came back as a string in tests (don't assert Date).
- pnpm 12 reads build approvals from `allowBuilds` in pnpm-workspace.yaml.
- pnpm eval still passes with zero cases (passWithNoTests) until F030 removes it.

Next session: F002 (append-only enforcement on events).

## 2026-11-06 — Multi-agent build, wave 1 (spine, rules, auth)

Orchestration: builders (sonnet) worked disjoint paths in parallel; every feature was then run by an
independent `verifier` subagent before `passes` was flipped; rules/AI also get a fresh
`clinical-safety-reviewer`. Event store is HAND-ROLLED (ADR-002): Emmett had no license found and
unconfirmed pooler support.

Verified PASS and flagged: F001-F012, F014.
Rules F020-F029: first safety review FAILED (mislabelled controlled drug reached AUTO_ELIGIBLE);
fixed in c2c1770 (name matching, M01 identity-mismatch, M02 dose-form, total evaluateEligibility,
stronger purity test); awaiting re-review before flags flip.
F013: only the pure formulary + RxCUI cache is done (DB table/seed pending).

Known hardening gaps (from verifier code review, not yet addressed):

- App DB role is not stripped of UPDATE/DELETE/TRUNCATE on events/audit_log (triggers only; a
  privileged user can disable them). Add a migration role split + REVOKE.
- audit_chain_head has no trigger protection; a coordinated rewrite of audit_log+head is undetected.
- Projection rebuild reset and replay are separate transactions (recoverable, not atomic).
- insertEventsInTx is exported from store.ts; only convention + a source-scan test prevent misuse.
- Page-level RBAC returns HTTP 200 on /forbidden (route handlers return real 403). Consider
  experimental.authInterrupts. `.env.example` SESSION_SECRET placeholder must be rejected in prod.
- postgres.js: use `::text::jsonb` (bare `::jsonb` double-encodes); src/test/db.ts F001 helper OK.

## 2026-11-06 — Rules F020-F029 passed after three independent safety reviews

Review 1 FAIL (name "alprazolam" with null schedule + allowlisted RxCUI reached AUTO_ELIGIBLE) ->
fix c2c1770. Review 2 FAIL (blocklist bypass: "fluoxetine clonazepam", homoglyphs) -> name check
inverted to a whitelist, one-shot input snapshot, sparse arrays rejected (767573a). Review 3 PASS.
All listed verification commands re-run by the orchestrator: green.

Accepted / follow-up (from review 3, not blockers):

- A dose written in the medication NAME is not compared with doseMg ("trazodone 300 mg" with
  doseMg 50 passes D01). FOLLOW-UP in the decision-pipeline feature: build the name/dose from one
  structured order, or escalate on a numeric mismatch.
- Natural names that escalate (usability): "duloxetine DR", "desvenlafaxine ER", salts like
  "escitalopram oxalate". Safe; TODO dose-form-level RxCUIs.
- M02 does not catch non-contiguous form fragments ("fluoxetine extended"); contradictory
  "bupropion SR XL" passes with null formularyId. Low risk (allowlisted drug).
- refillLimit has no cap (TODO: source needed; documented in ADR-003). Name length is capped by Zod
  at 200 chars upstream; rules are quadratic on unbounded input.
- Mirtazapine monitoring input shape is provisional (tie to event schema).
