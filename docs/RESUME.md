# CareLoop: resume facts and design notes

Everything here is measured from this repository (as of the commit that added this file) or
sourced from a linked page. It is a synthetic-data portfolio demo: **no clinical validation, no
real patients, no production-readiness claim.**

## Verifiable metrics

| Metric                           | Value                                                                                  | How to check                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| TypeScript source (src/)         | about 38,500 lines                                                                     | `git ls-files "src/**/*.ts" "src/**/*.tsx" \| xargs cat \| wc -l` |
| Automated unit/integration tests | 1,784 across 104 test files                                                            | `pnpm test`                                                       |
| Browser end-to-end specs         | 20 Playwright spec files                                                               | `pnpm e2e`                                                        |
| Safety eval cases                | 156 labelled cases, pinned by a manifest, with probe ratchets                          | `pnpm eval`                                                       |
| Deterministic clinical checks    | 13 numbered rules (R01-R13) plus drug-specific, medication-identity and payload checks | `src/domain/rules/`                                               |
| Read-model projections           | 13 modules, rebuildable from the event log                                             | `src/infra/projections/`                                          |
| Feature checklist                | 70 of 70 features, each with an independent verifier pass                              | `feature_list.json`                                               |
| CI                               | typecheck, lint, format, tests (against Postgres) and eval gate                        | `.github/workflows/ci.yml`                                        |

## Resume bullets (accurate wording)

- Built CareLoop, a full-stack demo of an AI-assisted psychiatric prescription-renewal workflow
  (Next.js 15, TypeScript strict, Postgres, Drizzle, Zod, Playwright) on synthetic data.
- Designed an event-sourced core: append-only event store enforced by database triggers, hash-chained
  audit log, transactional outbox with idempotency keys, and rebuildable projections.
- Kept clinical decisions in 13 pure, deterministic, unit-tested rules; the LLM can only add
  escalation signals and every AI error, timeout or invalid output fails closed to a clinician.
- Proved controlled substances never reach the AI path with a test, and gated changes behind a
  156-case eval suite with pinned manifests and adversarial probes.
- Shipped four role-based apps (patient, clinician, pharmacist, admin) with server-side RBAC,
  accessible responsive UI (skip link, focus ring, 320px reflow, reduced motion) and 1,784 tests.

Do not add outcome claims (accuracy, time saved, patients served): this demo has none.

## What the public pilot looks like (secondary sources)

The workflow is modeled on press coverage of Legion Health's Utah pilot, not on Legion's product:

- Scope is narrow: stable patients renewing existing prescriptions; controlled substances,
  benzodiazepines, antipsychotics, lithium, valproate and clozapine are excluded, per
  PYMNTS
  and TechRepublic.
- Staged oversight (clinician review first, later after-the-fact review against a concordance
  threshold) and escalation on red flags such as suicidality, mania and pregnancy changes.
- Critics note the benefits may be overstated and that researchers induced an unsafe change in a
  security test of the system, which is why CareLoop treats LLM output as untrusted.

These come from a web search (links are kept in the chat summary, not here, because every URL in docs must be listed in sources.md); verify against the primary Utah agreement before quoting numbers.
`docs/sources.md` remains the project's source list.

## UI/UX principles applied

From health-UX guidance surfaced by search (vendor blogs, so treat as practice, not law):
Momentum,
Fuselab,
925 Studios.

- Separate patient and clinician views: single-task plain language for patients, dense scannable
  data for staff. Done: distinct role layouts and navigation.
- Target WCAG 2.2 AA: 44px touch targets (minimum is 24px), strong focus ring, 18px base text,
  no color-only status. Done.
- No urgency tactics and no alarming wording in patient-facing copy; crisis resources (988/911)
  always visible in the patient area. Done.
- Show where numbers come from: the visit view lists source events and rule results. Done.

## Honest gaps

No clinical validation, no live-model evaluation, no real EPCS or pharmacy integration, and the
production deployment checklist in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) is open.
