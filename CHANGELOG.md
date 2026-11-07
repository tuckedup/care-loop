# Changelog

All notable changes to CareLoop. Format follows Keep a Changelog; versions follow the
release schedule in docs/SPEC.md. All data is synthetic.

## [Unreleased]

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
