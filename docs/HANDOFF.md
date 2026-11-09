# CareLoop handoff

Written 2026-11-07 during the multi-agent build. Read this first, then `CLAUDE.md`,
`claude-progress.md` (chronological log, newest last), `feature_list.json` (source of truth for
status) and `docs/DECISIONS.md` (ADRs and known gaps). The numbers below are a snapshot; if they
disagree with `feature_list.json` or `git log`, the repo wins.

All data is synthetic. Wording rule: "HIPAA-aligned design, synthetic data". Never claim HIPAA
compliance, EPCS certification, a real e-prescribing network, or achieved clinical performance.

---

## 1. Status snapshot

- **70 of 70 features passing** at the v1.0 release gate (commit `e9eb035`). v0.1 through v1.0
  are built and locally verified; nothing has been deployed, tagged or live-model-tested.
- Passing: F001-F070. Check
  `node -e "const f=require('./feature_list.json');console.log(f.filter(x=>!x.passes).map(x=>x.id).join(' '))"`.
- **Update 2026-11-07 (final v1.0 push):** F043, F058-F062 were verified/reviewed and flagged passing earlier.
  F063-F067 (eval harness, originally 153 cases / 88 risk, CREOLA-style judge) are committed; the second review's fixes
  are in `cc801da` and the narrow third review of that delta passed the safety mechanism and gate (one
  docs-only finding, fixed here). F068 (README + docs) is committed in `d1ce256`/`a43485d`; F069 (Vercel +
  hardening) is committed in `f9b9e6d`; both were independently verified. F070 is the release gate.
- **Earlier snapshots below/above are historical.** If a number disagrees with `feature_list.json`,
  `evals/results/latest.json` or `git log`, the repo wins.
- Releases are never tagged by agents. Owner decision: tag `v0.1.0`, `v0.2.0`, `v0.3.0`, then `v1.0.0`
  (CHANGELOG has sections for v0.2, v0.3 and v1.0).

## 2. Non-negotiable invariants (from CLAUDE.md, enforced by tests)

1. The `events` table is append-only (DB triggers) and written ONLY through `appendToStream`
   (`src/infra/audit/audit-log.ts`), which appends events + a hash-chained audit entry (+ optional outbox
   rows) in one transaction. A source-scan test fails if anything else inserts into `events`.
2. Clinical decisions are pure deterministic functions in `src/domain/rules` (purity test enforced). The LLM
   may only ADD escalation signals; it can never approve. Only a rules outcome `AUTO_ELIGIBLE` with every
   guard clean can ever be auto-approved, and only in RETRO/SAMPLED autonomy mode (SHADOW is the default).
3. Fail closed: LLM error/timeout/invalid output, unknown mode, unknown history, missing pharmacy => escalate or
   refuse, never approve.
4. Controlled substances never enter the AI path (positive allow-list gate `isAiPathPermitted`; proof tests in
   `src/domain/pipeline/controlled-never-ai.test.ts`) and are never transmitted (transmit backstop).
5. Every external call carries an idempotency key; side effects only via the outbox (grep-style test
   `src/infra/http-idempotency.test.ts`). Accepted deviation (documented): LLM inference calls have no key
   (read-only).
6. Every write is audited (`src/infra/audit/coverage.test.ts` fails for a writer without a context).
7. Never edit `.env*` except `.env.example`; never add URLs to `docs/sources.md`; never invent clinical
   thresholds, drug lists or citations (use `TODO: source needed`).

## 3. Run it

Prereqs: Node >= 20 (built on 24), pnpm 12 (`packageManager` pins it), Docker (for Postgres 16), Git Bash on
Windows. pnpm 12 reads build-script approvals from `allowBuilds` in `pnpm-workspace.yaml`.

```bash
docker compose up -d --wait db          # Postgres on localhost:54329 (Docker Desktop must be running;
                                         # it can end up "Paused": `docker compose unpause db`)
set -a; . ./.env.example; set +a         # load synthetic defaults into the shell (never create .env)
pnpm install
pnpm db:migrate                          # 17 migrations (0000-0016); re-run after pulling
pnpm db:seed                             # deterministic synthetic data (SEED=42), idempotent
pnpm projections:rebuild                 # after migrations that touch projections
pnpm dev                                 # http://localhost:3000, demo auth role switcher at /login
./init.sh                                # install + migrate + seed + start dev server in background
```

Verification commands (all should be green on a clean checkout with Postgres up):

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                    # ~1600 tests, ~90 files, Postgres required (isolated schemas per file)
pnpm eval                    # fixtures mode; fails on empty cases, recall < 1, citation validity < 1
pnpm eval:pins -- --check    # required-case manifest pins current (regenerate with `pnpm eval:pins`)
pnpm audit:verify            # exit 0 intact, 1 tamper (names first broken seq), 2 error
pnpm outbox:work -- --once   # one worker pass (bare command polls forever)
pnpm e2e                     # Playwright; many specs are env-gated (see below)
```

### E2E: isolation and gates (important)

- Parallel runs MUST NOT share a database, port or Next build dir. Use all three:
  `DATABASE_URL=postgres://careloop:careloop@localhost:54329/careloop_<name>_e2e NEXT_DIST_DIR=.next-<name> PORT=31xx pnpm e2e`.
  The e2e helper only resets databases whose name ends in `_e2e` and creates them if missing.
- Next may auto-edit `tsconfig.json` when `NEXT_DIST_DIR` is set. Remove only the generated `.next-<name>/types` include afterward; do not restore the whole file over other work.
- Env switches (all DEFAULT-DENY, honoured only when `NODE_ENV` is exactly `development` or `test`):

| Variable                                                      | Purpose                                        | Needed by                                                          |
| ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `MOCK_PHARMACY_FORCE=retry-then-fill` (+ `CRON_SECRET=<any>`) | deterministic pharmacy outcomes                | pharmacy-retry-fill, retro-auto-renew, item9-escalation fill steps |
| `RISK_FIXTURE=synthetic-handwritten`                          | canned no-signal AI result (no API key exists) | follow-up specs, retro-auto-renew                                  |
| `VISIT_CLOCK_OFFSET_DAYS=60`                                  | shifts the clock for note signing only         | refill-limit-followup                                              |
| `SUMMARY_FIXTURE=synthetic-handwritten`                       | hand-written summary model                     | visit-summary citation test                                        |

Specs skip silently without their gates, so a "green" default `pnpm e2e` is not full coverage. On
2026-11-07 the fail-closed profile passed 55/70 with 15 fixture-gated skips; the fixture profile
passed its RETRO, pharmacy, citation and mobile flows, and follow-up profiles passed 8/8 when run
with `VISIT_CLOCK_OFFSET_DAYS=60`. Keep fixture profiles separate: the main fail-closed tests
intentionally expect no AI fixture, while follow-up/RETRO tests need a canned no-signal response.

Example PowerShell profiles (use only synthetic values and keep the `_e2e` database suffix):

```powershell
$env:DATABASE_URL = 'postgres://careloop:careloop@127.0.0.1:54329/careloop_e2e'
$env:SESSION_SECRET = 'careloop-e2e-only-test-secret-0123456789'
$env:NEXT_DIST_DIR = '.next-e2e'; $env:PORT = '3001'
$env:DEMO_AUTH_ENABLED = 'true'; $env:LOGIN_RATE_LIMIT_PER_MIN = '10000'
$env:CRON_SECRET = 'careloop-e2e-cron-secret-0123456789'
$env:MOCK_PHARMACY_FORCE = 'retry-then-fill'
pnpm e2e # fail-closed profile; do not set RISK_FIXTURE or SUMMARY_FIXTURE

$env:RISK_FIXTURE = 'synthetic-handwritten'
$env:VISIT_CLOCK_OFFSET_DAYS = '60'
pnpm exec playwright test e2e/follow-up-booking.spec.ts e2e/refill-limit-followup.spec.ts
```

- No real Anthropic key exists in this project: `pnpm eval:live`, the real Anthropic client and Langfuse tracing
  have NEVER run against real services. All fixtures are hand-written ("synthetic-handwritten").

## 4. Repository map

```
CLAUDE.md, docs/SPEC.md, docs/sources.md   user-owned inputs (do not reformat; prettier-ignored)
feature_list.json                          70 features, passes flags, verification commands
claude-progress.md                         dated session log (append only)
docs/DECISIONS.md                          ADRs, known gaps (read the Amendments)
docs/{STANDARDS,MODEL_CARD,AI_AGENTS}.md   standards map, model card, agent/harness notes
src/domain/events.ts                       Zod event schemas (v1), all SPEC events + additive ones
src/domain/rules/                          R01-R13 + D01-D03 + M01/M02 + aggregator evaluateEligibility
src/domain/{renewal,patient,visit,follow-up,clinician,pharmacist,autonomy,pipeline}/   aggregates, commands, pipeline
src/domain/pharmacy*.ts                    selection, queue/transmit guards, stall/supersede logic
src/ai/                                    extractRiskSignals, quote verification, fail-closed wrapper, tripwire,
                                           summarize (cited), tracing, judge (eval-only, uncommitted at handoff)
src/infra/{event-store,audit,projections,outbox,auth,db}/   store, hash chain, projections, worker, RBAC, Drizzle
src/app/                                   Next.js App Router: patient, clinician, pharmacist, admin, api/*
evals/                                     156 cases, fixtures, required-cases.json (pins), results/latest.json
e2e/                                       Playwright specs + support helpers
scripts/                                   db-migrate/seed, projections-rebuild, audit-verify, outbox-work, *.test.ts
drizzle/                                   generated SQL migrations 0000-0016 (never hand-edit applied ones)
```

## 5. How the system works (one paragraph each)

- **Event store and audit.** Hand-rolled on postgres.js + Drizzle (ADR-002: Emmett had no licence found and
  unconfirmed pooler support). `appendToStream` takes a row lock on a single `audit_chain_head` row, so the
  chain cannot fork and global positions follow commit order; transaction-level only (Supabase pooler safe: no
  LISTEN/NOTIFY, no session advisory locks). `pnpm audit:verify` recomputes the chain.
- **Projections.** Idempotent with checkpoints, rebuildable from position 0: `patient_med_list`, `rx_status`,
  `renewal_queue`, `phq9_trend`, `pharmacy_alerts`, `visit_schedule`, `audit_view`, `renewal_metrics`.
  Central queue rule: an escalated renewal completes only through an identified clinician decision backed by a
  `ClinicianReviewStarted` of the same renewal; anything else holds it open with an anomaly code.
- **Decision pipeline** (`src/domain/pipeline/process-manager.ts`): after check-in builds the rule input from one
  structured order, runs the positive AI gate, scans free text locally (tripwire + injection, also when AI is
  blocked), calls the model only when allowed, appends `RiskSignalsExtracted`, `EligibilityEvaluated` and
  `RenewalEscalated`/denial/follow-up. A system denial is allowed only for a purely administrative REJECT.
  The patient check-in action triggers it; `/api/cron/decisions` catches up stragglers.
- **Rules.** Name checks are a whitelist (unexplained words escalate), input is snapshotted once, REJECT outranks
  ESCALATE (implementer choice, flagged TODO in DECISIONS). Hydroxyzine always escalates (limits unsourced).
- **AI layer.** Strict Zod output with no approve field; every quote verified server-side at UTF-16 offsets;
  unverifiable signals escalate; fail closed on every client failure; tripwire is a non-validated heuristic safety
  net with a frozen regression oracle (`src/ai/__fixtures__/tripwire-ce058db.ts`).
- **Pharmacy.** Clinician approval (or a guarded system auto-approval) queues `RxRenewalQueued` + an outbox row in
  the same transaction; the worker transmits to `/api/mock-pharmacy` (NOT a real network) with an idempotency
  key; responses are consumed with messageId dedupe. Dead-lettered/unconfirmed/stalled sends raise alerts;
  a stalled earlier renewal is superseded with a CancelRx when a newer one is approved.
- **Follow-up.** R06 refill limit -> patient books a synthetic slot -> clinician signs the note (only after the
  visit starts, injected clock) -> task + calendar slot; signing resets the refill counter per prescription
  (clinical confirmation TODO). Repair sweep for half-finished signings.
- **Autonomy** (`src/domain/autonomy`): admin sets SHADOW/RETRO/SAMPLED via events; RETRO queues every
  auto-approval for retrospective review, SAMPLED a seeded share; concurrence is shown as a TARGET only.

## 6. The workflow that produced this (reuse it)

Builders (sonnet subagents) work disjoint paths; every feature is then (a) run by an independent `verifier`
subagent, and (b) for rules/ai/escalation/autonomy features, attacked by a FRESH `clinical-safety-reviewer`
with no memory of earlier rounds, told to write adversarial fuzz tests in a temp dir and report exact inputs.
A FAIL goes back to the builder (SendMessage) and then to another fresh reviewer. Flags flip only on PASS plus
the orchestrator re-running the listed verification on a quiet machine. Real defects this caught (each fixed
with tests): mislabelled controlled drug reaching AUTO_ELIGIBLE; emoji before risk text silencing the tripwire
(UTF-16 offset bug); REJECT swallowing suicidality; system approval completing an escalated renewal; dead-lettered
transmit stranding an approval; a note signed before a visit resetting the refill limit; CancelRx sent for a
filled prescription. Lessons: shared `.next`/DB/ports between parallel agents cause false failures; `git add -A`
sweeps other agents' unfinished files (use explicit paths); `prettier --write .` once corrupted user-owned
files (now ignored: CLAUDE.md, docs/SPEC.md, docs/sources.md, .claude, evals/required-cases.json).

Honest review gaps: F048 and F051 flipped after their final fix deltas were verified by the orchestrator's clean
run but without a further independent safety review of that last delta (recorded in `claude-progress.md`).

## 7. What to continue, in order

1. `git status` (should be clean apart from `tsconfig.json` if Next touched it: `git checkout tsconfig.json`).
   F067 is committed. Stale `.rev-tmp*` and `.next-*` directories from reviewers/agents break `pnpm lint` and
   `pnpm typecheck`: delete them (`rm -rf .rev-tmp* .next-*`) before judging the baseline.
2. Run `pnpm test`, `pnpm eval`, `pnpm eval:pins -- --check`, typecheck, lint, format on a quiet machine.
3. Independent review then flip: F059/F060/F062 (fresh `clinical-safety-reviewer`, focus on the transmit gate change
   and the autonomy cross product), F063-F067 (reviewer re-derives a sample of eval labels from SPEC section 4; list
   every case the system fails and every label that rests on an implementation choice), F043/F058/F061 (verifier).
4. F068: README (architecture diagram, run instructions, session ritual, results from `evals/results/latest.json`),
   fill docs TODOs that now have answers, update STANDARDS status rows, MODEL_CARD with real counts. Test
   `scripts/docs-wording.test.ts` for forbidden claims. Link only URLs already in `docs/sources.md`.
5. F069: `vercel.json` cron for `/api/cron/{outbox,decisions,visits}` (CRON_SECRET), `outputFileTracingIncludes` so
   `/admin/evals` can read `evals/results/*.json` on Vercel, security headers, rate limits, production guards
   (reject the dev `SESSION_SECRET` placeholder in production), Supabase pooler notes (`prepare: false`), `pnpm build`.
6. F070: release gate: everything green, `clinical-safety-reviewer` PASS across rules/ai/escalation/autonomy,
   CHANGELOG v1.0, tell the owner to tag.

## 8. Known gaps and owner decisions

- **The three tracked paraphrase misses were resolved locally:** escalation-only tripwire phrases
  now catch reduced need for rest, throat closing or welts, and an admission of entering zeros,
  even with a silent fixture model. Their original ids and ESCALATE labels are pinned in the gated
  set. Fixture recall is now 116/116 across all tracked SPEC-labelled escalations; this is not
  clinical sensitivity, and unseen wording can still be missed. SHADOW remains the default;
  RETRO/SAMPLED should remain synthetic-only until independent clinical review and live evaluation.

- Tagging v0.1.0/v0.2.0/v0.3.0 and the git identity used for commits (local config is `tuckedup` /
  `atulpandey231945@gmail.com`).
- Hardening not done: the app DB role still has UPDATE/DELETE on `events`/`audit_log` (triggers only; a DB
  superuser can disable them: split migration owner and app role + REVOKE); `audit_chain_head` is not trigger
  protected (a full chain + head rewrite by a superuser is undetected without an external anchor); identity
  verification has no throttle and failed attempts are not audited; `patient_med_list` halts on a schema-invalid
  `MedicationPrescribed`; the squeezed tripwire scan is uncapped (payload size only).
- TODO: source needed: hydroxyzine numeric limits; exact mirtazapine metabolic/CV measures (the agreement specifies baseline and six-month monitoring, but not the measures);
  trazodone parsing of free-text dose beyond the structured field; 28-day follow-up gap, slot grid, single
  scheduling clinician; `PHARMACY_STALE_HOURS` (72) and the 15-minute approved-not-sent value (demo config);
  clinical review of the tripwire lexicon and the cited-summary deny-list (both heuristic, non-exhaustive).
- Needs owner confirmation: REJECT outranks ESCALATE precedence; refill counter reset scope (per prescription);
  whether a retro-review non-concurrence should auto-revert to SHADOW; SPEC target of 98% concurrence is a target.
- Never run against real services: Anthropic API, Langfuse (legacy ingestion endpoint, schema unverified), a real
  Supabase pooler. Do not claim otherwise anywhere.

## 9. Gotchas

- Windows + Git Bash. Hooks in `.claude/settings.json` block Bash commands containing destructive/append-only
  phrases (including grep for them); edit tests with the Edit tool instead.
- Vitest config sets 30 s tests / 60 s hooks / 4 workers because ~90 DB-heavy files time out at the 5 s default under load.
- Do not run Prettier over user-owned files; `pnpm format:check` must pass (CI runs it).
- `pnpm test` needs Postgres at `DATABASE_URL` (default `.env.example` value is built into `src/test/db.ts`).
- Usage-limit cut-offs also pause Docker Desktop containers: check `docker compose ps` first when tests hang.
- Migrations are additive; after pulling run `pnpm db:migrate` BEFORE `pnpm projections:rebuild`.
- postgres.js: write JSON as `::text::jsonb` (bare `::jsonb` double-encodes); timestamptz can arrive as a string.

## 10. Resume prompt for a new session

> Follow the session ritual in CLAUDE.md. Read docs/HANDOFF.md, claude-progress.md, `git log --oneline -20` and
> feature_list.json. Start Postgres, run `pnpm test`; fix a red baseline first. All 70 feature flags
> passed the local v1.0 gate. The three former paraphrase misses are now gated cases; verify the
> updated eval and safety tests before any future release. Do not deploy with real patient data or
> treat fixture recall as clinical validation. The owner decides whether to tag `v1.0.0` after review.

## Update: UI redesign and e2e modes

- UI: shared design system in `src/app/_components/ui.tsx`, tokens in `src/app/globals.css`, self-hosted
  Figtree via `@fontsource-variable/figtree`, 18px base. `pnpm dev` works without a `.env` (development
  falls back to the docker database in `src/infra/db/client.ts`; production still requires `DATABASE_URL`).
- e2e: dev-mode first-compile can race (`Unexpected end of JSON input`); set `E2E_PROD=true` to run
  Playwright against `next build && next start` (`pnpm demo:screenshot` does). The autonomy-switch spec
  skips there because autonomy is locked to SHADOW in production builds.
- Clinician visit view: the summary `Suspense` is keyed per event position so it cannot hold the review
  action transition open; the action's `revalidatePath` refreshes the page (no `router.refresh`).
- Restore `tsconfig.json` with `git checkout tsconfig.json` after e2e runs (Next rewrites it), then
  `pnpm exec prettier --write tsconfig.json` if `format:check` complains about line endings.
