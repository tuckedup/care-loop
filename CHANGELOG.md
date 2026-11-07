# Changelog

All notable changes to CareLoop. Format follows Keep a Changelog; versions follow the
release schedule in docs/SPEC.md. All data is synthetic.

## [Unreleased]

### Added (toward v1.0)

- Autonomy modes SHADOW (default) / RETRO / SAMPLED as an admin setting stored as events
  (`AutonomyModeChanged`), with `/admin/autonomy`. Only a clean, rules-AUTO_ELIGIBLE renewal can be
  auto-approved (never escalated, rejected, follow-up, controlled or AI-flagged ones); the language
  model can only add escalations. Fails closed to SHADOW.
- Retrospective review: seeded deterministic sampling (`SEED`, `SAMPLE_RATE`), `/clinician/retro-review`,
  non-concurrence alert, `renewal_metrics` projection (migration 0016).
- Admin dashboard (`/admin/dashboard`: concurrence with the 98% figure labelled as a TARGET, escalation
  mix, time to decision) and `/admin/evals` (eval results, synthetic labels).
- E2E: auto-renew in RETRO mode (`e2e/retro-auto-renew.spec.ts`).

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

## Planned releases

- v0.1: event store + patient flow
- v0.2: rules + AI + clinician queue
- v0.3: outbox, pharmacy, follow-up, audit
- v1.0: evals, autonomy modes, docs
