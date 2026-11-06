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

### TODO: confirm outcome precedence (REJECT vs ESCALATE) and R02/R03 outcomes

SPEC section 4 names REJECT only for R01 (identity) and says R02 is "medication on formulary
allowlist" and R03 is a "hard block from the AI path" without stating the outcome type. The rule
engine currently REJECTs on R02 and gives REJECT precedence over ESCALATE (REJECT > ESCALATE >
FOLLOW_UP_REQUIRED > AUTO_ELIGIBLE). The eval cases controlled-alprazolam,
controlled-lisdexamfetamine, not-on-formulary-synthetic-drug and the ai-blocked-* cases encode that
choice in their labels and say so in `labeledFrom`. TODO: confirm the precedence and the R02/R03
outcome types with the product owner; if they change, relabel those cases deliberately and update
the pins in `evals/required-cases.json`. Likewise, ESCALATE as the outcome for missing mirtazapine
monitoring (baseline and six-month) is an implementer's choice; SPEC section 2 only requires the
monitoring.

## ADR-0xx: Renewal decision pipeline and clinician actions (F036, F037, F042)

- Status: accepted
- Date: 2026-11-06

### Decision

- The process manager (`src/domain/pipeline/process-manager.ts`) turns a submitted check-in into
  `RiskSignalsExtracted`, `EligibilityEvaluated` and one of `RenewalEscalated`, `RenewalDenied{by:system}`,
  `FollowUpRequired` or nothing (AUTO_ELIGIBLE awaits a clinician; autonomy modes are F059). All of it is
  recorded by ONE `RecordEvaluation` command on the renewal stream, so the events are atomic and a second
  evaluation decides nothing (idempotent). It never emits `RenewalApproved`.
- The AI gate (`isAiPathAllowed` and `isAiPathPermitted`) is consulted before `runRiskExtraction`; a
  blocked path records no `RiskSignalsExtracted` and calls no client. An AI failure or any signal adds an
  escalation; it can never approve.
- Medication name and dose both come from the prescribed order (`MedicationPrescribed`). A number in the
  order's name text that differs from `dose.amountMg`, a missing order, or an order owned by another
  patient fails a pipeline check `P01` (persisted next to the rule results) and forces ESCALATE
  (`MEDICATION_IDENTITY_MISMATCH` / `ORDER_NOT_FOUND`), even over a REJECT. This closes the rules-review
  follow-up (dose in the name was not compared with doseMg).
- A REJECT whose failed rules include R03 (controlled substance) is escalated to a person instead of
  being auto-denied. Reviewers can then only deny (approval of REJECT or controlled is refused).
- Clinician actions (`src/domain/renewal/review.ts`): the clinician id on every event is the session
  subject. Approve requires the same clinician's `ClinicianReviewStarted` on escalated renewals; Deny and
  BookVisit always require it (the renewal_queue attributes a denial only through the review start).
  `BookVisit` emits `VisitBooked` and a clinician `RenewalDenied` on the renewal stream (the queue only
  completes an escalated row through a clinician decision); after a system follow-up it emits only
  `VisitBooked`. `evolve` ignores events the queue would refuse (forged system approval, other
  clinician's id) so a forged event cannot lock out the legitimate reviewer.
- `RenewalDenied` gained optional `by` / `clinicianId`; `VisitBooked` gained optional `clinicianId` /
  `renewalId` (additive, v1).
- Renewals since the last visit are counted from events (approvals of the same patient and prescription
  after the patient's last `VisitNoteSigned`, matched through `VisitBooked.patientId`), not from a
  projection, because projections are read-only for this feature.

### Known gaps

- The seed's prior renewals have no `RenewalApproved`, so the seeded "refill-limit" patient counts 0 until
  the seed emits approvals (TODO).
- The LLM request has no idempotency-key parameter in `RiskLlmRequest`; replay safety comes from the
  aggregate (one evaluation per renewal), not from the provider. TODO in src/ai.
- Nothing calls `evaluateRenewal` after check-in yet except the cron catch-up route
  (`/api/cron/decisions`); the patient check-in action should call it (outside this feature's files).
- Verified/unverified quote flags and signal origin are not persisted (`RiskSignalsExtracted` has no
  field for them).

### Amendments after the independent safety review (F036/F037/F042)

- A system denial (`RenewalDenied` by system) rests ONLY on purely administrative failures (R01/R02).
  If any safety rule (R04-R12, drug-specific, R00), an integrity check (P01/P02), a local tripwire hit
  or any AI signal/failure exists, a clinician sees the renewal: `RenewalEscalated` carries the union of
  every failed rule's reason codes plus `LLM_RISK_SIGNAL` / `LLM_FAILURE` where they apply. A blocked AI
  path is reported as `AI_PATH_BLOCKED`, not as an LLM failure.
- The local tripwire (`detectTripwire`, pure deterministic code, not an LLM) runs even when the AI path
  is blocked; its signals are stored in `RiskSignalsExtracted` with model `local-tripwire:<reason>`.
- The rules' outcome is never overwritten: a REJECT stays REJECT and escalation is a separate fact.
  Approve is refused when the outcome is REJECT or any of R01/R02/R03 failed (controlled substances give
  `CONTROLLED_NOT_APPROVABLE`); the clinician may still deny or book a visit.
- P01 (order integrity) compares only mass units (mg, g, mcg/ug/micro-g, converted exactly), reads a bare
  number as mg, and treats other units, ambiguous separators ("1,5", "1.000"), non-ASCII digits and
  number words as mismatches. P01 failing also blocks the LLM call.
- P02 (refill counter integrity): a schema-invalid RenewalRequested / RenewalApproved / RenewalDenied /
  CheckInSubmitted / VisitBooked / VisitNoteSigned in the patient's history makes the counter unknown
  and forces an escalation (`REFILL_COUNT_UNKNOWN`). The counter counts approvals since the last signed
  visit PLUS in-flight renewals of the same prescription (a check-in after the last visit, neither
  approved nor denied, not the current one), so concurrent renewals each see the others and cannot all
  slip under the limit. This over-counts stuck, unresolved renewals until a visit resets it: intended.
- The catch-up runner isolates each renewal, pages past failures with a cursor, and escalates a failing
  renewal with `RenewalEscalated{PIPELINE_ERROR}` (best effort); failure counts and opaque renewal ids
  are returned by the cron route and unmarkable failures are logged with a non-PHI code.
- ACCEPTED DEVIATION (flag for the owner): the extraction call has no idempotency key because
  `RiskLlmRequest` has none and `src/ai` is out of scope. The call is read-only inference with no
  side effects and the aggregate stores one result per renewal, so a duplicate call is wasteful but
  harmless. This departs from "every external call takes an idempotency key" for read-only LLM inference.
- Observed outside this scope: the `patient_med_list` projection throws on a schema-invalid
  `MedicationPrescribed` event, which halts that projection run.
