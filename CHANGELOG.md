# Changelog

All notable changes to CareLoop. Format follows Keep a Changelog; versions follow the
release schedule in docs/SPEC.md. All data is synthetic.

## Unreleased — synthetic-demo safety and evaluation hardening

- UI redesign (design tokens, self-hosted Figtree at 18px, role navigation); `pnpm dev` now works without
  a `.env`; the clinician review panel no longer sticks pending in production builds.
- Eval gate: a manifest requirement's outcome is now pinned to its kind in code (F071 review finding);
  added `evals/wilson.ts` for recall intervals, `docs/LIVE_EVAL.md` (first live run on 2026-11-09 with
  `claude-sonnet-5-5`: 91/91 escalations, 0 unsafe approvals, but the live gate FAILED; details there),
  `docs/CLINICAL_REVIEW.md` (every rule UNSIGNED) and `docs/SAFETY_REVIEW.md` (F071-F073).
- Promoted three formerly missed paraphrases into the pinned eval set, preserving their ESCALATE
  labels. Fixture recall is 116/116 on synthetic cases; this is not real-world performance.
- Locked production builds to SHADOW and blocked direct auto-approval and mode changes there.
- Bound the Docker database port to localhost and removed raw text and clinical signal types from
  optional trace exports. Added a synthetic-demo entry link and mobile keyboard smoke test.
- Added separate production-readiness goals for clinical evaluation, protocol controls, frontend
  usability, and operations/interoperability. No real service or patient data was used.

## v1.0 - evals, autonomy modes, docs, deploy hardening

All data is synthetic. Tagging `v1.0.0` is the owner's step (agents do not tag).

### Added

- Deploy config and hardening (F069): `vercel.json` crons (daily, Hobby-safe) for the outbox, decisions and
  visits routes, security headers and a CSP in `next.config.ts`, `outputFileTracingIncludes` for
  `/admin/evals`, per-instance in-memory rate limits (mock pharmacy, cron routes, login), production guards
  (placeholder or short `SESSION_SECRET` fails closed, demo auth default-deny via `DEMO_AUTH_ENABLED`),
  env var and Supabase pooler docs, `scripts/hardening.test.ts`. Nothing was deployed.

- README: what CareLoop is and is not, synthetic-data banner, architecture diagram, run instructions,
  session ritual, commands, verification workflow, known limitations, and an eval results table that
  `scripts/readme-results.ts` regenerates from `evals/results/latest.json` (a test fails on drift).
- `scripts/docs-wording.test.ts`: forbids unsupported compliance, certification and clinical claims
  (unless negated) and any URL not listed in `docs/sources.md`.
- STANDARDS status rows and MODEL_CARD numbers brought in line with what exists (fixture results only).

- Autonomy modes SHADOW (default) / RETRO / SAMPLED as an admin setting stored as events
  (`AutonomyModeChanged`), with `/admin/autonomy`. Only a clean, rules-AUTO_ELIGIBLE renewal can be
  auto-approved (never escalated, rejected, follow-up, controlled or AI-flagged ones); the language
  model can only add escalations. Fails closed to SHADOW.
- Retrospective review: seeded deterministic sampling (`SEED`, `SAMPLE_RATE`), `/clinician/retro-review`,
  non-concurrence alert, `renewal_metrics` projection (migration 0016).
- Admin dashboard (`/admin/dashboard`: concurrence with the 98% figure labelled as a TARGET, escalation
  mix, time to decision) and `/admin/evals` (eval results, synthetic labels).
- E2E: auto-renew in RETRO mode (`e2e/retro-auto-renew.spec.ts`).
- Eval suite (F063-F067): 156 hand-labelled synthetic cases (91 risk, 116 escalation, 101 AI) run through
  the real decision pipeline with recorded fixtures, including 6 controlled-substance-AI-blocked cases
  (zero LLM calls) and 3 formerly missed paraphrases promoted into the gated set without changing
  their labels. Escalation-only tripwires cover reduced need for rest, throat-closing language or
  welts, and an admission of entering zeros. The gate fails on any tracked SPEC-labelled miss,
  unsafe approval, invalid citation, or required-case/probe pin drift. `evals/results/latest.json`
  records every number plus `mode: fixtures` and
  `liveModelRun: false`; a CREOLA-style summary judge runs eval-only with recorded fixtures.

### Known limits

- Evals use synthetic handwritten fixtures, not a live model run. Live mode is `pnpm eval:live` and is
  not claimed here.
- Escalation recall is 116/116 on the synthetic fixture set, with no remaining tracked misses.
  This does not establish recall on unseen wording or a live model. Default SHADOW mode has a
  clinician approve every renewal; RETRO/SAMPLED remains synthetic-only pending independent clinical
  review and live evaluation.
- Nothing was deployed. Deploy config and hardening are verified by build and tests only.

## v0.3 - outbox, pharmacy, follow-up, audit

All data is synthetic. Tagging `v0.3.0` is the owner's step (agents do not tag).

### Added

- Transactional outbox and worker; an approval, `RxRenewalQueued` and the outbox row commit together.
  Transmit re-checks every guard from the event streams (clinician approval, rules outcome, not
  controlled, confirmed pharmacy, positive allow-list) before any outbound call; mock pharmacy with
  seeded outcomes (retryable and fatal errors, delays, fills, duplicates, pharmacist escalations).
- Pharmacy responses: status, error with retry and dead-letter, fills, stalled and unconfirmed
  sweeps, CancelRx for superseded renewals (never after a fill), pharmacy alerts inbox.
- Follow-up: refill limit leads to a follow-up requirement, patient booking, clinician booking, visit
  notes that reset the counter, follow-up task and calendar slots.
- Hash-chained audit log coverage test, `pnpm audit:verify`, admin audit view (FHIR AuditEvent-shaped
  JSON, not a conformant FHIR server).
- Every external HTTP call passes an idempotency key (scan test in `src/infra/http-idempotency.test.ts`;
  the only exception is read-only LLM inference).

### Known limits

- Dev/test-only switches (all default-deny, NODE_ENV development or test): `MOCK_PHARMACY_FORCE`,
  `RISK_FIXTURE`, `SUMMARY_FIXTURE`, `VISIT_CLOCK_OFFSET_DAYS`.
- Sweeps run from cron routes or scripts; no scheduler config yet. The audit chain is tamper-evident,
  not tamper-proof against a database superuser. HIPAA-aligned design, synthetic data.

## v0.2 - rules, AI risk screen, clinician queue

All data is synthetic. Tagging `v0.2.0` is the owner's step (agents do not tag).

### Added

- Deterministic eligibility rules (R01-R13, drug-specific and pipeline checks) as pure functions in
  `src/domain/rules`. Controlled substances never enter the AI path (a test proves it).
- AI risk-signal layer (`src/ai`): local tripwire and injection scans, schema-validated LLM
  extraction that can only ADD escalation signals, fail-closed on any error, timeout or invalid
  output; eval gate (`pnpm eval`, hand-written synthetic fixtures; no live model run is claimed).
- Decision pipeline: check-in -> evaluation -> escalate / system-deny / follow-up. No system approval
  exists in this release: every approval is an attributable clinician decision.
- `renewal_queue` and `phq9_trend` projections; an escalated renewal completes only through a
  clinician decision that is attributable to a started review.
- Clinician UI: queue (escalated first, reason codes), renewal view with PHQ-9 trend, cited AI visit
  summary (advisory, never an approval), start review / approve / deny / book follow-up.
- E2E: patient PHQ-9 item 9 >= 1 -> under review -> clinician starts review and approves -> patient
  sees the approval, then the pharmacy flow (`e2e/item9-escalation.spec.ts`).

### Known limits

- Tripwire lexicon and eval fixtures are non-validated and synthetic-handwritten; the live Anthropic
  client has not been run against the real service in CI.
- Demo authentication only. HIPAA-aligned design, synthetic data.

## v0.1 - event store and patient flow

### Added

- Project scaffold: Next.js App Router, TypeScript strict, Tailwind, Drizzle, Vitest,
  Playwright, ESLint, Prettier, CI workflow, bootstrap docs and feature list.
- v0.1 patient flow (renew, verify identity, PHQ-9/GAD-7 check-in, result, status) on an
  append-only, hash-chain-audited event store with rebuildable projections:
  - Formulary and fake-pharmacy reference tables; formulary seeded from the cached RxNav results.
  - Deterministic synthetic seed (`pnpm db:seed`, `SEED` env): patients, prescribers, clinician,
    pharmacist, pharmacies with 7-digit IDs. Seeding appends events only through the command
    handlers and is idempotent.
  - Patient UI under `/patient`: medication list (controlled medications visibly not renewable),
    identity verification, accessible check-in form with inline validation, result page (safe
    default "under review" until the decision pipeline exists) and status page.
  - Playwright patient-flow specs run against a dedicated, reset and seeded `*_e2e` database.
  - Known v0.1 limits: no decision pipeline yet (every check-in stays under review), demo auth only.

## Release status

- v0.1, v0.2, v0.3 and v1.0 are built in this repository. Agents never tag; the owner tags the releases
  (`v0.1.0`, `v0.2.0`, `v0.3.0`, `v1.0.0`).
