# CareLoop

> **ALL DATA IS SYNTHETIC.** CareLoop is a portfolio demo. It handles no real patients, sends nothing
> to a real pharmacy and makes no clinical or compliance claims. Design stance: **HIPAA-aligned design,
> synthetic data.**

CareLoop is a demo of an AI-assisted psychiatric prescription-renewal loop, modeled on the public
protocol of Legion Health's Utah AI pilot (see [docs/sources.md](docs/sources.md) for the source list).
A patient on a stable, existing, non-controlled medication asks for a refill and does a short check-in.
Deterministic rules plus an LLM that can only add risk signals either auto-renew (depending on the
autonomy mode) or escalate to a human clinician. A mock pharmacy answers with NCPDP-SCRIPT-style
messages, and hitting the refill limit forces a follow-up visit.

## What CareLoop is, and is not

It is:

- A worked example of event sourcing, a hash-chained audit log, a transactional outbox, deterministic
  clinical rules kept separate from an LLM, fail-closed AI handling, and an eval harness.
- Four role-based apps (patient, clinician, pharmacist, admin) behind a signed-cookie demo login.
- Fully runnable locally with Docker (Postgres) and no API keys: without `ANTHROPIC_API_KEY` the AI path
  fails closed and renewals escalate to a clinician.

It is not:

- Not a medical device, not clinical software, not validated for any clinical use. It is not
  "clinically validated" and no sensitivity or specificity is claimed anywhere.
- Not compliant with, or certified under, any regulation or program. "HIPAA-aligned design, synthetic data"
  is the only wording used. There is no real e-prescribing network, no EPCS, no real PHI.
- Not real authentication: the login is a role switcher for demonstration (see
  [Security posture](#security-posture)).
- Not tested against any live service. The Anthropic API, Langfuse and a real Supabase pooler have
  never been used by this repo; every eval fixture is hand-written.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    P[Patient] --- C[Clinician] --- Ph[Pharmacist] --- A[Admin]
  end
  Browser -->|signed demo-auth cookie, RBAC| App["Next.js App Router<br/>(server actions, route handlers)"]
  App -->|commands| Dom["Domain (pure)<br/>rules R01-R13, aggregates,<br/>decision pipeline"]
  Dom -->|text only, allow-listed<br/>non-controlled drugs| AI["AI layer<br/>risk signals + cited summary<br/>(can only ADD escalations)"]
  Dom -->|appendToStream, one transaction| ES[("Postgres<br/>events (append-only)<br/>+ hash-chained audit_log<br/>+ outbox")]
  ES --> Proj["Projections<br/>med list, rx status, review queue,<br/>PHQ-9 trend, visits, metrics"]
  Proj --> App
  ES -->|outbox worker<br/>idempotency key| MP["Mock pharmacy<br/>/api/mock-pharmacy<br/>(NOT a real network)"]
  MP -->|status / error / fill| ES
  Cron["Cron: /api/cron/outbox,<br/>decisions, visits<br/>(CRON_SECRET bearer)"] --> App
```

Key properties, each enforced by tests (details in [docs/HANDOFF.md](docs/HANDOFF.md) section 2):

- The `events` table is append-only (database triggers) and written only through `appendToStream`, which
  also appends the audit entry and any outbox rows in the same transaction. All state is a projection.
- Clinical decisions live in `src/domain/rules` as pure, deterministic functions. The LLM may only add
  escalation signals; it can never approve or override a rule.
- Fail closed: an LLM error, timeout or schema-invalid output means escalate.
- Controlled substances never enter the AI path (a positive allow-list gate, with proof tests) and are
  never transmitted.
- Every external call takes an idempotency key; side effects go through the outbox; every write appends
  to the hash-chained audit log (`pnpm audit:verify` recomputes the chain).

Stack: Next.js 15 App Router, TypeScript strict, Tailwind, Postgres with Drizzle (hand-rolled event
store on postgres.js), Zod at every boundary, Vitest, Playwright, `@anthropic-ai/sdk`, pnpm.

## Run it

Prerequisites: Node 20 or newer, pnpm 12 (pinned by `packageManager`), Docker, and Git Bash on Windows.

```bash
docker compose up -d --wait db     # Postgres 16 on localhost:54329
set -a; . ./.env.example; set +a   # load the synthetic template values into this shell
pnpm install
pnpm db:migrate                    # applies the drizzle/ migrations
pnpm db:seed                       # deterministic synthetic data (SEED=42), idempotent
pnpm dev                           # http://localhost:3000, role switcher at /login
```

`./init.sh` does install, migrate, seed and starts the dev server in the background. Never create or
edit a real `.env` for the demo: `.env.example` holds template values only and no secrets.

If the AI path has no key (the default), the decision pipeline fails closed and renewals escalate, which
is the correct and safe behaviour. To try the model path, set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`
yourself; that path has never been exercised against the real API by this repo.

### Environment variables

| Variable                                                                          | Purpose                                                                                                                      |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                    | Postgres connection string (default matches docker-compose)                                                                  |
| `SESSION_SECRET`                                                                  | Signs the demo-auth cookie; at least 32 characters                                                                           |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`                                            | Enable the live AI path; empty means fixtures only and the AI path fails closed                                              |
| `LANGFUSE_*`, `RESEND_API_KEY`                                                    | Optional tracing and email, skipped when unset                                                                               |
| `REFILL_LIMIT`, `SAMPLE_RATE`, `SEED`                                             | Business config (refill limit, retrospective sampling share, deterministic seed)                                             |
| `CRON_SECRET`, `DEMO_AUTH_ENABLED`, `PHARMACY_STALE_HOURS`, `NEXT_DIST_DIR`, etc. | Deployment and hardening settings, documented with the others in [Deploying](#deploying-to-vercel-not-deployed-by-this-repo) |

See [.env.example](.env.example) for the full list and comments.

## Session ritual (how this repo is built)

The repo is built by Claude Code agents following [CLAUDE.md](CLAUDE.md). Every session:

1. Read `claude-progress.md`, `git log --oneline -20` and `feature_list.json`.
2. Run `./init.sh`, then `pnpm test`. If the baseline is red, fix that first.
3. Pick the highest-priority feature with `"passes": false` and build only that one.
4. Verify it end to end (unit tests plus Playwright where there is UI). Only then set `"passes": true`.
5. Commit with a descriptive message and append a dated entry to `claude-progress.md`.

## Commands

| Command                     | What it does                                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| `pnpm dev`                  | Next.js dev server                                                              |
| `pnpm build` / `pnpm start` | Production build and server                                                     |
| `pnpm test`                 | Vitest (needs Postgres; each file gets an isolated schema)                      |
| `pnpm e2e`                  | Playwright; many specs are env-gated and skip silently, see each spec header    |
| `pnpm eval`                 | Eval harness in fixtures mode; fails on regressions and writes `evals/results/` |
| `pnpm eval:live`            | Same cases against the real API; implemented but never run (needs your own key) |
| `pnpm eval:pins`            | Regenerate the sha256 pins for required eval cases (a reviewed act)             |
| `pnpm db:migrate`           | Apply migrations                                                                |
| `pnpm db:seed`              | Seed synthetic data                                                             |
| `pnpm projections:rebuild`  | Rebuild every projection from position 0                                        |
| `pnpm audit:verify`         | Recompute the audit hash chain (exit 0 intact, 1 tampered, 2 error)             |
| `pnpm outbox:work`          | Run the outbox worker (`-- --once` for a single pass)                           |
| `pnpm typecheck`            | `tsc --noEmit`                                                                  |
| `pnpm lint`                 | ESLint                                                                          |
| `pnpm format:check`         | Prettier check (CI runs it)                                                     |

## Multi-agent verification workflow

Builders work on disjoint paths. Every feature is then run by an independent `verifier` subagent that
executes the feature's listed verification and edits nothing. Any change to rules, AI, escalation or
autonomy additionally goes to a fresh `clinical-safety-reviewer` with no memory of earlier rounds, which
writes adversarial tests and reports exact failing inputs. A FAIL goes back to the builder and then to
another fresh reviewer; a `passes` flag flips only after a PASS and a clean re-run of the listed
verification. Defects this process caught (each fixed with tests) include a mislabelled controlled drug
reaching auto-eligibility, an emoji before risk text silencing the tripwire, a rejection swallowing
suicidality, and a system approval completing an escalated renewal. See
[docs/HANDOFF.md](docs/HANDOFF.md) section 6 and [docs/AI_AGENTS.md](docs/AI_AGENTS.md).

## Evaluation results

Regenerate this block with `pnpm exec tsx scripts/readme-results.ts` after `pnpm eval`; a test fails if
it drifts from `evals/results/latest.json`.

<!-- eval-results:start -->

| Metric                                 | Value                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Run mode                               | fixtures (fixtures: synthetic-handwritten)                                                       |
| Live model run                         | no                                                                                               |
| Cases                                  | 150                                                                                              |
| Risk cases                             | 85                                                                                               |
| Cases that exercise the AI path        | 95                                                                                               |
| Cases labelled ESCALATE                | 110                                                                                              |
| Escalation recall (gated set)          | 100.0%                                                                                           |
| Unsafe approvals                       | 0                                                                                                |
| Auto-approve precision                 | 100.0%                                                                                           |
| Outcome accuracy                       | 100.0%                                                                                           |
| Reason-code accuracy                   | 100.0%                                                                                           |
| Citation validity                      | 100.0%                                                                                           |
| AI-blocked cases / LLM calls on them   | 6 / 0                                                                                            |
| Known-limitation probes (not gated)    | 3 probes the system still misses                                                                 |
| Escalation recall including the probes | 97.3% (3 missed of 113 SPEC-labelled escalations)                                                |
| Summary judge (fixture judgments)      | 15 cases, 8 judged, 7 fail-closed; hallucinations 3 major / 1 minor, omissions 4 major / 1 minor |
| Gate                                   | pass                                                                                             |

Source: `evals/results/latest.json` (generated by `evals/run.eval.ts@1.1.0`). These are FIXTURE results: every model answer is a hand-written canned response, no live model or live judge has ever run, so the numbers show how the pipeline handles those responses, not how any real model performs. Recall of 100% is over the gated set only; the probes row is the honest figure.
<!-- eval-results:end -->

## Known limitations

- **The evals are fixture-based.** Every model answer is a hand-written canned response and the summary
  judge is a fixture judge. No live model, live judge, Langfuse instance or real Supabase pooler has ever
  been used. Results demonstrate behaviour and regressions of this pipeline, not model performance.
- **Eval cases are small, synthetic and hand-labelled** from the SPEC; they are not clinical validation.
  Some labels rest on implementation choices (listed in [docs/MODEL_CARD.md](docs/MODEL_CARD.md)).
- **Three probes still fail.** `evals/known-limitations/` holds SPEC-labelled escalations the system
  misses when the model is silent: mania described only in free text, severe side effects described only
  in free text, and a patient admitting dishonest PHQ-9 answers. Recall over the gated set is 100%;
  the honest figure including the probes is in the results table. In the default SHADOW autonomy mode a
  clinician approves every renewal; in RETRO and SAMPLED modes a model miss on such wording would be sent
  automatically. An owner decision is needed before enabling those modes anywhere real.
- **The tripwire and the summary deny-list are heuristics**: small English-only lexicons, deliberately
  over-inclusive, not clinically reviewed, with documented misses.
- **Demo auth is a role switcher**, not authentication. The app database role still has UPDATE and
  DELETE on `events` (append-only is enforced by triggers a superuser could disable).
- **Real gaps stay marked `TODO: source needed`** (hydroxyzine numeric limits, mirtazapine monitoring
  interval, follow-up gap, stall thresholds, and others); see [docs/DECISIONS.md](docs/DECISIONS.md).
- The 98% concurrence figure from public reporting appears only as a labelled TARGET, never as a result.

## Documentation

- [docs/SPEC.md](docs/SPEC.md): the product spec and rule list (user-owned input).
- [docs/sources.md](docs/sources.md): every external source used (user-owned input).
- [docs/DECISIONS.md](docs/DECISIONS.md): architecture decisions, amendments and known gaps.
- [docs/STANDARDS.md](docs/STANDARDS.md): which public vocabularies are mirrored and how.
- [docs/MODEL_CARD.md](docs/MODEL_CARD.md): intended use, safety design, evaluation, limitations.
- [docs/AI_AGENTS.md](docs/AI_AGENTS.md): runtime AI and the development agent harness.
- [docs/HANDOFF.md](docs/HANDOFF.md): status, run and verification detail, gotchas.
- [CHANGELOG.md](CHANGELOG.md) and [claude-progress.md](claude-progress.md): release notes and the session log.

## License

MIT, see [LICENSE](LICENSE).
