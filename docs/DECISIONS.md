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

## ADR-003: R07 escalates on PHQ-9 item 9 >= 1 (not >= 2)

Status: accepted (F025).

### Context

PHQ-9 item 9 asks about thoughts of being better off dead or of self-harm; each item is scored
0-3. The Kaiser Permanente Washington PHQ-9 item 9 to C-SSRS workflow (listed in
docs/sources.md) uses a threshold of item 9 >= 2 to trigger follow-up suicide-risk assessment.
In that workflow a clinician-run assessment follows the screen. CareLoop is different: R07 is the
only thing standing between a self-harm response and an automatic renewal, with no clinician in
the loop on the AUTO_ELIGIBLE path. The Utah pilot escalation triggers in the clinical-rules
skill include suicidality, and the standing guidance is "when in doubt, escalate".

### Decision

R07 escalates when PHQ-9 item 9 >= 1, so any non-zero answer ("several days" or more) goes to a
clinician with reason code PHQ9_ITEM9_POSITIVE. This is deliberately more conservative than the
KP >= 2 threshold. Missing, malformed or out-of-range PHQ-9 data also escalates (fail closed).
The rule is a pure function in src/domain/rules; the LLM can add signals but can never lower
or override this rule.

### Consequences

- More escalations than a >= 2 threshold would produce (lower specificity), accepted as the
  cost of removing the unattended-renewal risk. Clinician workload impact is a metric to watch
  on the dashboard.
- Value 1 sits below the threshold used by the KP workflow, so results are not comparable to
  KP's published escalation rates. TODO: source needed for any quantitative sensitivity claim.
- The threshold is a code constant covered by boundary tests (0, 1, 2, 3); changing it
  requires a new ADR and clinical-safety review.

### Note: dose-form limitation of ingredient-level RxCUIs

The cached RxCUIs are ingredient level, so bupropion SR/XL and venlafaxine ER cannot be told
apart from immediate-release products by RxCUI alone. Rule M02 therefore checks the medication
text: form-specific entries (bupropion SR/XL, venlafaxine ER) need an allowed form word, and any
other recognised form word (IR, immediate release, CR, ...) escalates with
DOSE_FORM_NOT_ALLOWLISTED. This is a text heuristic, not a coded dose form. TODO: source needed
for dose-form-level RxCUIs, after which M02 should compare coded forms instead.

### Note: medication name check is an allow-vocabulary, not a drug blocklist

M01 does not try to list bad drugs. After normalisation (NFKC, diacritics and zero-width
characters removed, lowercase) it removes the expected drug's own names and requires every
remaining word to be benign (numbers, units, dosage-form words, salts). Any unexplained word or
leftover non-ASCII character escalates with MEDICATION_IDENTITY_MISMATCH. This deliberately
over-escalates (brand names and typos go to a clinician). The small controlled-name matcher in
R03 stays as an extra hard signal.

### Note: accepted risk, no upper bound on REFILL_LIMIT

SPEC gives no maximum for REFILL_LIMIT, so none is invented (TODO: source needed). A very large
configured limit effectively disables R06. Validating the configured value belongs to the config
loader, which is out of scope for the pure rules; the rule only rejects non-integer, negative or
non-finite values. A test documents this behaviour.

### Note: input snapshot

evaluateEligibility copies the input once as plain data, reading each property a single time and
never invoking getters, and evaluates only that copy. Getters, functions, symbols, class
instances, cyclic or very deep structures fail closed with ESCALATE / INVALID_INPUT.
