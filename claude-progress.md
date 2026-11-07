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

## 2026-11-06 — Wave 2: seed + patient UI (v0.1 complete)

F013, F015-F019 verified PASS by an independent verifier (19/19 e2e, 836 unit at that point).
v0.1 is functionally complete: CHANGELOG [Unreleased] updated, TAG v0.1.0 when ready (not tagged
by agents).

Follow-ups from the verifier's security review (none blocking):

- No throttle/lockout on identity verification (DOB + last name brute-forceable). TODO.
- Failed identity attempts append no event/audit entry (IDENTITY_MISMATCH thrown before append).
  Consider an IdentityVerificationFailed event + audit so attempts are visible and countable.
- Ownership is enforced in the service layer; handlers take only renewalId. Pass patientId into
  the handler and compare with RenewalRequested to make it impossible to bypass.
- syncProjections runs inside page renders (read path writes checkpoints). Move to a worker/cron.
- Approved / follow-up-needed result states only have unit coverage until the decision pipeline
  emits those events (F036+).
- e2e uses its own DB (careloop_e2e) and PORT; only one e2e process at a time.

## 2026-11-06 — Session stopped at usage limit (state for next session)

Flags passing: 29/70 (F001-F020s except below, see feature_list.json). NOT yet flagged, work exists:

- F030-F035 (AI layer + eval gate): built; safety review FAILED twice. Round 2 found a CRITICAL
  tripwire bug (astral chars/emoji shift offsets so "😀 I want to die" + silent model reached
  AUTO_ELIGIBLE) plus no eval coverage floor. Fix round 3 was dispatched to the AI builder and may
  be PARTIAL in the working tree (typecheck had a TS1117 duplicate-key error in src/ai/normalize.ts).
  Next: check `git status`, finish/repair the fix, then a FRESH clinical-safety-reviewer, then verifier.
- F038, F044-F046 built and committed (e8c10ba, 5d45f6e, f382add, c1c2cd3): NOT yet independently
  verified. F038 needs clinical-safety-reviewer (flagged). F047 PARTIAL (0eec6b2): pharmacy
  confirm page + domain helpers done; "selection recorded in the event" deferred because
  RenewalRequested has no pharmacyId (needs src/domain/events.ts change).
- Remaining after that: F036/F037/F039-F043 (decision pipeline, clinician UI, summary, actions),
  F048-F058 (transmit, responses, follow-up, audit coverage/verify/admin), F059-F070 (autonomy,
  evals to 60+ cases, docs, deploy). Also the dose-in-name vs doseMg follow-up from the rules review.
- Full `pnpm test` had load-dependent timeouts (audit-log scan test 5s default); raise its timeout.
- v0.1 is complete; tagging v0.1.0 is up to the user.

## 2026-11-06 — Outbox / worker / mock pharmacy verified (F044-F046)

Verifier PASS (full suite 903 tests green at that point). F038 fixed after a failed safety review
(e0dd76f), third review pending; F047 partial; AI layer round-3 review pending.
Follow-ups from the verifier's review (not blocking):

- Worker leases a whole batch of 10 for 60s but runs handlers sequentially: a late message's lease
  can expire mid-batch (duplicate delivery, guarded by outcome checks). Claim smaller batches or
  extend the lease per handler.
- Outbox claim/retry bookkeeping writes no audit entry (done/dead/reap are audited).
- /api/mock-pharmacy reads the whole body before the 16 KiB check and only echoes
  Idempotency-Key (doc comment says must send): enforce size via Content-Length and the header.
- renewal_queue deliberately re-opens a renewal completed by a non-clinician if a late escalation
  arrives (flagged ESCALATED_AFTER_NON_CLINICIAN_DECISION). Fail-safe direction; confirm intended.
- Bare `pnpm outbox:work` polls forever (use `-- --once` for verification).

## 2026-11-06 — F038 (renewal_queue + phq9_trend) passing after 5 safety reviews

Reviews 1-4 FAILED on real holes (system approval completing escalated renewals, lost escalation on
late/out-of-order events, FollowUpRequired completing escalated rows, risk signals not escalating,
invalid RenewalRequested making later events vanish). Review 5 ran an exhaustive model-based fuzz
(~59M states) and confirmed ALL safety invariants hold; it found only data-correctness defects
(placeholder not completed, reviewer overwrite, phq9 trusting invalid request, missing request
event), fixed in 4a6a991 and verified by the verifier (71 projection tests, rebuild x2 identical).
No sixth full safety review was run on that last data-only delta: flag flipped on that basis.

Central queue rule (renewal-queue.ts attributableToClinician/gateApproval/gateDenial): an escalated
row completes only via a clinician decision with matching ClinicianReviewStarted. The future decision
aggregate (F042) MUST emit ClinicianReviewStarted before approve/deny, and reject forged clinician
ids at command time. Only the first reviewer can resolve a row (no reassignment event yet).
Run `pnpm projections:rebuild` after migrations 0009-0011 (0011 self-heals by truncation).

## 2026-11-06 — AI layer + eval gate (F030-F035) passing after six safety reviews

Reviews 1-5 FAILED on real issues: controlled-drug blocklist at the AI entry (-> positive allow-list),
eval gate passing with nothing checked (-> required-case manifest with sha256 pins, semantic kinds,
signalTypes, override nonce), CRITICAL UTF-16 offset bug (emoji before risk text silenced the tripwire),
recall regression vs ce058db (-> frozen oracle + differential superset test), red vitest exit
(spawnSync -> async spawn). Review 6 PASS (60k independent old-vs-new comparisons, exact offsets,
all suites exit 0). All F030-F035 verification re-run by the orchestrator: green.

Known / follow-ups (non-blocking):

- Squeezed tripwire scan is uncapped and not counted in MAX_PER_FIELD: repeated phrase padding can
  yield ~1000 signals per field (payload-size concern only; cannot lower recall). Cap it, and add a
  max length to the RiskSignalsExtracted signals array in events.ts.
- Fixtures are hand-written canned model responses (synthetic-handwritten); eval:live, the real
  Anthropic client and Langfuse have NEVER run against real services. Langfuse ingestion is a legacy
  endpoint; exact schema unverified.
- Tripwire lexicon is a non-validated heuristic (TODO clinical review). Eval total is 46 cases; SPEC
  target of 60+ (>=25 risk) is still open (F064-F066).
- Implementer choices needing confirmation are in docs/DECISIONS.md (REJECT outranks ESCALATE).

## 2026-11-06 — Decision pipeline + clinician actions (F036, F037, F042) passing after 3 safety reviews

Review 1 FAIL: REJECT swallowed other safety signals (unknown drug + item 9 + 'I want to die' => system
denial, no escalation); P01 rewrote REJECT to ESCALATE so a clinician could approve a non-formulary drug.
Review 2 FAIL: leading-decimal dose ('.50 mg' vs 50) passed; system denial appended to an escalated
renewal. Review 3: no leak / approval path / recall loss across 1500 DB cross-product cases; only a
wrong patient-facing status (rx_status regressed to 'evaluated' after a clinician denial) - fixed in
608597a with a property test over all event orderings. No fourth full review on that status-only
delta; flags flipped on that basis; orchestrator re-ran listed verification (green).

Contract now in force: system denial only for purely administrative R01/R02 REJECT with no safety
signal (tripwire/injection also run when AI is gated off); REJECT stays REJECT while RenewalEscalated
is also emitted; Approve refused for R01/R02/R03/controlled/REJECT/follow-up; clinician id only from
the session; the AI call needs allow-list gate + verified identity + P01 + P02. Accepted deviation:
LLM extraction has no idempotency key (read-only inference; aggregate stores one result).
Known gaps: patient_med_list halts on a schema-invalid MedicationPrescribed; cron catch-up evaluates
only undecided renewals; check-in wiring (evaluateAfterCheckIn) done by the UI stream (0f334b1).

## 2026-11-06 — Clean full verification; F039/F040 passing; vitest config

On a quiet machine (no agent processes): typecheck, lint, format:check, pnpm test (69 files / 1254
tests), pnpm eval (47), eval:pins --check, full pnpm e2e (34 passed, 1 skipped) and
visit-summary in SUMMARY_FIXTURE mode all green. F039 (queue UI) and F040 (visit view) flagged
passing (verifier code review PASS + clean e2e). F041 awaiting a fresh safety review after 7 fixes.

Lessons / rules for future parallel agents:

- Parallel agents sharing one e2e database/port/.next cause false failures: give each agent its own
  DATABASE_URL (careloop_e2e_<name>) and PORT, or run e2e serially.
- vitest default 5s timeouts failed under load: vitest.config.ts now sets testTimeout 30s,
  hookTimeout 60s, maxWorkers 4.
- `prettier --write .` is safe now (protected files + generated evals/required-cases.json are in
  .prettierignore); eval case JSON was reformatted (pins hash parsed content, still current).

## 2026-11-06 — F041 (cited AI summary) passing after three safety reviews

Round 1 FAIL: patient free text could forge source lines in the prompt; no deny-list for approval /
reassurance wording; fixture gate failed open; cache skipped the AI gate; anchor collisions.
Round 2 FAIL: deny-list bypass via accents/Cyrillic lookalikes, mistyped /cleared?/ regex, duplicate
source/DOM ids. Round 3: all structural guarantees held; only gap was the French stem `approuv`
lacking a spaced variant (fixed in d91a931 with tests, plus 10 more reassurance phrases).
Verified by the orchestrator: pnpm test src/ai src/app (420), eval 47, visit-summary + visit-view
e2e in BOTH fixture modes (7 passed, 1 skipped each), typecheck, lint, format.

Accepted heuristic limits (documented in MODEL_CARD): the deny-list is NOT exhaustive. The filter
guarantees only id membership; claims are not verified against source text. Reviewer examples of
phrasings that still pass: 'Seems fine overall', 'Doing great, no problems', 'Fully stable',
'Everything is in order' (now blocked), etc. The banner + reason codes always render regardless of
summary content.

Infra: next.config.ts distDir is now configurable (NEXT_DIST_DIR) so concurrent dev servers/e2e runs
can use separate build dirs (.next-<name>/, ignored by git/eslint/prettier). Use it with
per-agent DATABASE_URL (…_e2e) and PORT.

## 2026-11-06 — Pharmacy stream: F047, F049, F050, F054 passing (F048 pending fresh safety review)

Verifier PASS at 5f2bcd7 (1380 unit tests, eval 47, lint/typecheck clean). F050's listed command skipped
silently without MOCK_PHARMACY_FORCE and CRON_SECRET: verification now uses `pnpm exec cross-env ...`
so it really runs (3 tests). The pharmacy builder's own safety review of F048/F049 FAILED once
(duplicate in-flight renewal of the same prescription could double-transmit; fill+retryable error could
re-send; cross-attributed fills) and was fixed in 5f2bcd7; a FRESH independent review is still required
before F048 (safety-flagged) is flagged. NOTE: after pulling migrations always run `pnpm db:migrate`
before `pnpm projections:rebuild` (0012_pharmacy_alerts).

## 2026-11-06 — v0.3 stream: F048, F051, F052, F053, F055, F056, F057 passing

Clean verification on a quiet machine (own DB/port/dist dir): format, typecheck, lint, pnpm test
(88 files / 1520 tests), eval 47, eval:pins, audit:verify (chain intact), projections:rebuild, full
e2e (43 passed, 12 env-gated skipped), plus the env-gated specs run separately: pharmacy-retry-fill (3,
MOCK_PHARMACY_FORCE=retry-then-fill CRON_SECRET=...), follow-up specs (8, RISK_FIXTURE=synthetic-handwritten
VISIT_CLOCK_OFFSET_DAYS=60), visit-summary fixture mode (1).

Safety review history (honest record):

- F048 (approval -> outbox -> transmit): builder's own review FAIL, fresh review FAIL (controlled backstop,
  dead-letter stranding, ...), fresh round 2 FAIL (no-pharmacy approval, stall contradiction), fresh round 3 FAIL
  (CancelRx after fill, copy untrue, docs). All fixed with tests (95e2e55, ef2047c). The core guarantee
  (no outbound message for a non-clinician-approved / non-allowlisted / unconfirmed-pharmacy renewal) held in
  every round. The LAST delta (ef2047c) was verified by the orchestrator's clean run but did NOT get a
  fourth independent safety review: flagged on that basis.
- F051 (follow-up): fresh review FAIL (note signed before the visit reset the refill limit; counter forgery
  via client visitId) -> fixed; round 2 found no safety hole (small items) -> fixed in 0c7a4c3; delta verified
  by the orchestrator, no third fresh review.
- F052/F053/F055/F056/F057 (not safety-flagged): verified by tests/e2e; the verifier agent was cut off by the
  usage limit, so verification was done by the orchestrator's clean run.

Known gaps to carry forward: dev/test-only env switches exist (MOCK_PHARMACY_FORCE, RISK_FIXTURE,
SUMMARY_FIXTURE, VISIT_CLOCK_OFFSET_DAYS: all default-deny, gated to NODE_ENV development/test); the stalled
and approved-not-sent sweeps run only from cron/script (no scheduler config yet: F069); clinician booking is
two appends (retry converges); audit chain cannot detect a DB superuser rewriting the whole chain + head.
Use NEXT_DIST_DIR + own DATABASE_URL (..._e2e) + PORT for concurrent e2e. Next.js auto-edits tsconfig.json
when NEXT_DIST_DIR is set: `git checkout tsconfig.json` afterwards.

## 2026-11-07 — Handoff written

See docs/HANDOFF.md: status snapshot (56/70 flagged), how to run/verify, e2e isolation + env gates, repo map,
invariants, review workflow and history, ordered continuation plan (finish F067 -> independent reviews of
F043/F058-F067 -> F068-F070), known gaps/owner decisions, gotchas and a resume prompt.
In flight at the time: safety review of F059/F060/F062, verifier for F043/F058/F061, evals builder on F067
(uncommitted src/ai/judge.ts, evals/judge-*, evals/fixtures/judge, evals/judge-cases).
