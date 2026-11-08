# Deploy checklist (Vercel + Supabase)

All data is synthetic. HIPAA-aligned design, synthetic data. **Nothing in this repo has ever been
deployed**: no Vercel project, no Supabase database, no pooler connection and no live Anthropic call
were used. This list is derived from the code and config, not from a deployment.

## Before you deploy

- [ ] Understand that demo auth lets anyone choose any role. Only deploy with synthetic data.
- [ ] Understand that production builds force SHADOW mode and refuse automatic mode changes. This
      repository cannot be deployed as an autonomous clinical renewal service.
- [ ] Create a Postgres database. From your machine run `pnpm db:migrate` then `pnpm db:seed` against it.
- [ ] `pnpm build` passes locally (it did when this was written).

## Environment variables (Vercel project settings)

| Variable                               | Required | Notes                                                                                                                                 |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | yes      | Supabase transaction-mode pooler URL                                                                                                  |
| `SESSION_SECRET`                       | yes      | Long random string (32+ characters). The `.env.example` placeholder is refused in production and sessions fail closed                 |
| `CRON_SECRET`                          | yes      | Long random string. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically when it is set. Unset means cron routes 401 |
| `PHARMACY_BASE_URL`                    | yes      | Explicit trusted HTTPS origin for the pharmacy endpoint; production never derives it from request host                                |
| `DEMO_AUTH_ENABLED`                    | optional | Must be exactly `true` for the role switcher to work in production. Default is off (`/login` shows a disabled notice)                 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | optional | Live AI path, never exercised by this repo. Without them every renewal escalates (fail closed)                                        |
| `PHARMACY_STALE_HOURS`                 | optional | Default 72, a demo value                                                                                                              |
| `REFILL_LIMIT`, `SAMPLE_RATE`, `SEED`  | optional | Business config, defaults in `.env.example`                                                                                           |

**Never set `MOCK_PHARMACY_FORCE`, `RISK_FIXTURE`, `SUMMARY_FIXTURE` or `VISIT_CLOCK_OFFSET_DAYS` in
production.** They are ignored unless `NODE_ENV` is `development` or `test` (a test proves it), but they
must not be present anyway. Also leave `LOGIN_RATE_LIMIT_PER_MIN` unset in production.

The production autonomy lock is unconditional: a stored RETRO or SAMPLED event reads as SHADOW,
the admin action refuses a new automatic mode, and direct auto-approval calls refuse. Removing
this lock requires completion of the separately tracked goals in
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) and independent review.

## Crons

`vercel.json` registers `/api/cron/outbox`, `/api/cron/decisions` and `/api/cron/visits`.

- **Hobby** allows only daily cron jobs, so the committed schedules are daily (`0 5 * * *`,
  `10 5 * * *`, `20 5 * * *`, UTC). A more frequent expression fails the deployment.
- **Pro** allows per-minute schedules. Suggested edits in `vercel.json`: outbox `* * * * *`, decisions
  `*/5 * * * *`, visits `*/15 * * * *`.
- With daily crons the outbox drains rarely, so pharmacy transmission lags. Check-in evaluation still runs
  immediately. Any scheduler can call a route with the bearer secret.
- Cron routes are rate limited to 30 per minute per IP (per instance, best effort).

## Database pooler notes

- Use the transaction-mode pooler. The client sets `prepare: false` and a pool of 5.
- No LISTEN/NOTIFY and no session-level advisory locks are used; appends serialise on a row lock inside a
  transaction.
- Run migrations over a direct or session connection.

## After the first deploy

- [ ] `curl -i https://<host>/login` shows the security headers and, with `DEMO_AUTH_ENABLED` unset, the disabled notice.
- [ ] `curl -i https://<host>/api/cron/outbox` returns 401 without the bearer header.
- [ ] `/admin/evals` shows results (the files are traced into the bundle by `next.config.ts`).
- [ ] `pnpm audit:verify` against the deployed database exits 0.

## Not verified (nothing was ever deployed)

- Vercel build and runtime behaviour, cron invocation and the automatic bearer header, the
  `outputFileTracingIncludes` effect on Vercel, header behaviour behind Vercel's proxy.
- A real Supabase pooler, the live Anthropic API, Langfuse.
- Rate-limit behaviour across serverless instances (counters are per instance).
- Verified locally only: `pnpm build`, `next start` headers and the disabled login notice, and the e2e
  smoke and auth specs against a production build.

## Rollback

Redeploy the previous Vercel deployment (instant rollback in the dashboard). Migrations are additive and
the `events` table is append-only, so do not roll the database back; to disable access quickly, unset
`DEMO_AUTH_ENABLED` (all demo sessions stop working) or rotate `SESSION_SECRET`.
