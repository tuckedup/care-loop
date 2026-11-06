# Changelog

All notable changes to CareLoop. Format follows Keep a Changelog; versions follow the
release schedule in docs/SPEC.md. All data is synthetic.

## [Unreleased]

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
