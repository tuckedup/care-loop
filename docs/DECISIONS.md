# Architecture decisions

All CareLoop data is synthetic. Design is "HIPAA-aligned design, synthetic data".
Sources live in docs/sources.md; agents must not add URLs.

## ADR-001: Event sourcing on Postgres

- Status: accepted
- Date: 2026-11-06

### Context

A prescription-renewal loop is an auditable sequence of decisions (identity check, check-in,
rule results, AI signals, clinician action, pharmacy messages). We need to answer "why was this
renewed or escalated?" long after the fact, rebuild read models when rules change, and prove that
history was never rewritten.

### Decision

Store every state change as an immutable event in a single Postgres `events` table
(`global_position`, `stream_id`, `stream_version`, `type`, `data`, `metadata`, `created_at`) with
`UNIQUE(stream_id, stream_version)` for optimistic concurrency. One stream per aggregate
(`patient-*`, `rx-*`, `renewal-*`, `task-*`, `visit-*`). State is derived by pure `evolve`
functions and by rebuildable projections. The table is append-only: no UPDATE or DELETE.
Side effects go through a transactional outbox written in the same transaction as the events.

### Consequences

- Full history and replay; projections can be dropped and rebuilt from position 0.
- Rules changes can be re-evaluated against recorded history.
- More moving parts than CRUD (projections, idempotent consumers, upcasting for event versions).
- Library choice (Emmett vs hand-rolled) is deferred to feature F003. If Emmett does not work
  cleanly with the Supabase pooler we hand-roll the store and record the reason as ADR-002.

## ADR-002: Hand-rolled event store on postgres.js (no Emmett)

- Status: accepted
- Date: 2026-11-06

### Context

ADR-001 deferred the choice between `@event-driven-io/emmett-postgresql` and a hand-rolled store
to F003. The store must work through the Supabase transaction pooler (no session state), append
events and an audit entry in one transaction, and keep the whole write path small enough to review.

### Decision

Hand-roll the store on postgres.js (`src/infra/event-store`, `src/infra/audit`).

Reasons:

- No license was found for the Emmett package in this environment, and we do not adopt
  dependencies whose license is unconfirmed. No public source was found for it either, so none
  is cited here (docs/sources.md is unchanged).
- Supabase transaction-mode pooler compatibility of Emmett's Postgres store was unconfirmed
  (prepared statements, session-level features). We did not spend the F003 timebox proving it.
- CareLoop needs things a generic library would not give us for free: an audit hash chain written
  in the same transaction as every append, a global write order that projections can trust, and a
  single chokepoint that no code path can bypass.
- The core is small: optimistic concurrency is `UNIQUE(stream_id, stream_version)` plus an
  expected-version check. Patterns from public MIT-licensed event-sourcing samples were used as
  inspiration only; all code here was written fresh.

### Consequences

- We own the code and its tests (append, read, concurrency, retry).
- Pooler compatibility rules: no LISTEN/NOTIFY, no session-level advisory locks, no session
  settings; transaction-level locks (`FOR UPDATE`, `pg_advisory_xact_lock`) are fine. Queries are
  written so they work with `prepare: false`. JSON is sent as text and cast with `::text::jsonb`,
  because a bare `::jsonb` cast makes postgres.js double-encode strings.
- Migrating to a library later is possible: the table shape is the conventional one.

## Pending ADRs (written by the feature that introduces them)

- R07: PHQ-9 item 9 >= 1 escalates, more conservative than the KP >= 2 threshold (F025)
- Hydroxyzine requests escalate until numeric limits are sourced (TODO: source needed)
