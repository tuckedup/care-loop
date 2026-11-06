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
- Date: 2026-11-06 (amended after two independent safety reviews)

### Decision

- The process manager (`src/domain/pipeline/process-manager.ts`) turns a submitted check-in into
  `RiskSignalsExtracted`, `EligibilityEvaluated` and one of `RenewalEscalated`, `RenewalDenied{by:system}`,
  `FollowUpRequired` or nothing (AUTO_ELIGIBLE awaits a clinician; autonomy modes are F059). All of it is
  recorded by ONE `RecordEvaluation` command on the renewal stream, so the events are atomic and a second
  evaluation decides nothing (idempotent). It never emits `RenewalApproved`. `evaluateRenewal` is called
  by the patient check-in action (fail closed) and by the cron catch-up route `/api/cron/decisions`.
- The AI gate (`isAiPathAllowed`, `isAiPathPermitted` and the P01 order-integrity check) is consulted
  before `runRiskExtraction`; a blocked path calls no client. An AI failure or any signal adds an
  escalation; the LLM can never approve.
- Local safety scans are pure deterministic code (not an LLM): `detectTripwire` and `detectInjection` run
  on the free text even when the AI path is blocked. Their signals are stored in `RiskSignalsExtracted`
  (model `local-tripwire:<reason>`) and count as escalation signals (`LLM_RISK_SIGNAL`).
- Medication name and dose both come from the prescribed order (`MedicationPrescribed`). P01 (order
  integrity, persisted next to the rule results) fails for: a missing order, an order owned by another
  patient, or a dose written in the name text that does not equal `dose.amountMg`. It compares only mass
  units (mg, g, mcg/ug/micro-g, converted exactly) and reads a bare number as mg. Other units, ambiguous
  separators ("1,5", "1.000"), a number that starts with "." or "," (".5"), non-ASCII digits and number
  words are mismatches. P01 failing blocks the LLM call and forces an escalation
  (`MEDICATION_IDENTITY_MISMATCH` / `ORDER_NOT_FOUND`).
- The rules' outcome is never overwritten: a REJECT stays REJECT, and escalation is a separate fact
  (`RenewalEscalated`). Approve is refused when the outcome is REJECT or any of R01/R02/R03 failed
  (controlled substances give `CONTROLLED_NOT_APPROVABLE`); the clinician may still deny or book a visit.
- A system denial (`RenewalDenied` by system) is emitted ONLY when the REJECT rests purely on
  administrative failures (R01/R02) with no safety rule (R00, R04-R12, drug-specific), no integrity check
  (P01/P02), no tripwire/injection hit and no AI signal or failure, AND the renewal is not already
  escalated or decided. Otherwise a clinician sees it: `RenewalEscalated` carries the union of every
  failed rule's reason codes plus `LLM_RISK_SIGNAL` / `LLM_FAILURE` where they apply. A blocked AI path
  is reported as `AI_PATH_BLOCKED`, not as an LLM failure. Controlled drugs are always escalated, never
  silently denied. When the renewal is already escalated (for example by the pipeline-error marker) the
  REJECT is recorded in `EligibilityEvaluated` but no denial or follow-up is emitted on top of it.
- P02 (refill counter integrity): a schema-invalid RenewalRequested / RenewalApproved / RenewalDenied /
  CheckInSubmitted / VisitBooked / VisitNoteSigned in the patient's history makes the counter unknown
  and forces an escalation (`REFILL_COUNT_UNKNOWN`). The counter is computed from events (not a
  projection): approvals of the same patient and prescription after the patient's last signed visit
  note (matched through `VisitBooked.patientId`) PLUS in-flight renewals of the same prescription (a
  check-in after the last visit, neither approved nor denied, not the current one). Concurrent renewals
  therefore each see the others and cannot all slip under the limit. This over-counts stuck, unresolved
  renewals until a visit resets it: intended.
- Clinician actions (`src/domain/renewal/review.ts`): the clinician id on every event is the session
  subject. Approve requires the same clinician's `ClinicianReviewStarted` on escalated renewals; Deny and
  BookVisit always require it (the renewal_queue attributes a denial only through the review start).
  `BookVisit` emits `VisitBooked` and a clinician `RenewalDenied` on the renewal stream (the queue only
  completes an escalated row through a clinician decision); after a system follow-up it emits only
  `VisitBooked`. `evolve` ignores events the queue would refuse (forged system approval, other
  clinician's id) so a forged event cannot lock out the legitimate reviewer. A renewal escalated ONLY by
  the pipeline-error marker (no evaluation yet) can be started, denied or booked by a clinician but
  never approved until an `EligibilityEvaluated` exists.
- The catch-up runner isolates each renewal, pages past failures with a cursor, and escalates a failing
  renewal with `RenewalEscalated{PIPELINE_ERROR}` (best effort); failure counts and opaque renewal ids
  are returned by the cron route and unmarkable failures are logged with a non-PHI code.
- `rx_status` status precedence: once a row is approved, denied, follow_up_required or later in the
  pharmacy flow, evaluation and review-progress events (`IdentityVerified`, `CheckInSubmitted`,
  `EligibilityEvaluated`, `ClinicianReviewStarted`) never downgrade it. The cron catch-up skips renewals
  that already have a decision event. The AI gate additionally requires a verified identity and a
  knowable refill counter (P02); local scans still run.
- Defence in depth in projections: `renewal_queue` refuses to complete a row whose recorded outcome is
  REJECT on an approval (anomaly `APPROVAL_OF_REJECTED_RENEWAL`), and `rx_status` ignores a denial or
  approval on an escalated renewal that has no earlier `ClinicianReviewStarted`, so the patient is never
  shown a decision the queue refuses to honour.
- `RenewalDenied` gained optional `by` / `clinicianId`; `VisitBooked` gained optional `clinicianId` /
  `renewalId` (additive, v1).

### Accepted deviation (flag for the owner)

- The extraction call has no idempotency key because `RiskLlmRequest` has none and `src/ai` is out of
  scope. The call is read-only inference with no side effects and the aggregate stores one result per
  renewal, so a duplicate call is wasteful but harmless. This departs from "every external call takes an
  idempotency key" for read-only LLM inference.

### Known gaps

- Verified/unverified quote flags and signal origin are not persisted (`RiskSignalsExtracted` has no
  field for them).
- The `patient_med_list` projection throws on a schema-invalid `MedicationPrescribed` event, which halts
  that projection run (outside this feature's files). `rx_status` and `renewal_queue` skip and record
  such events in `projection_anomalies` instead.
- A schema-invalid `RenewalRequested` with no readable `patientId` cannot be attributed to a patient, so
  P02 cannot detect it.

## ADR: Pharmacy transmission, responses and inbox (F047-F054)

- **Selection event.** The confirmed pharmacy is a new additive event `PharmacySelected` (id plus
  the name/address/phone the patient was shown), appended after identity verification and before
  the check-in. It is locked once the check-in exists. The check-in page and action redirect to the
  pharmacy step while none is recorded.
- **One append for approval.** `Approve` emits `RenewalApproved` and, when a pharmacy was confirmed,
  `RxRenewalQueued` (deterministic idempotency key `rx-renewal:<renewalId>`, messageId
  `rxmsg-<renewalId>`) in one append; `handleCommandWithOutbox` writes the
  `pharmacy.RxRenewalResponse` outbox row in the same transaction as the events and audit entry.
  Without a pharmacy nothing is queued (fail closed; never guess). Existing approval guards
  (REJECT / R01-R03 / controlled / follow-up refused) are untouched.
- **Transmit guard.** The handler re-derives approval, rules outcome, medication schedule (rx-*
  stream) and the patient-confirmed pharmacy from the streams, and refuses (dead-letter) otherwise.
  Controlled substances therefore cannot be transmitted even if queued.
- **Idempotency.** Idempotency-Key header + body messageId; `RxRenewalTransmitted` is appended once
  per key and only after a clean accepted answer; a settled message is never re-sent.
- **Responses.** Status/Error/RxFill/CancelRx/PharmacistEscalation become events deduplicated on the
  pharmacy messageId. Retryable errors throw a retryable error so the existing worker backoff
  applies; non-retryable errors are recorded, dead-lettered and shown as alerts. RxFill requires a
  queued renewal and is ignored after a cancel acknowledgement; `filled`/`cancelled` are terminal in
  rx_status.
- **Alerts.** Projection `pharmacy_alerts` (migration 0012) feeds /pharmacist/inbox (pharmacist and
  admin) and a read-only /clinician/pharmacy-alerts. Acknowledging is the additive event
  `PharmacyAlertAcknowledged`. Retryable errors are not alerts.
- **Mock.** The request takes an optional `attempt` (later attempts draw anew); `MOCK_PHARMACY_FORCE`
  (`retry-then-fill`, `escalation`) scripts scenarios for e2e. The mock is NOT a real e-prescribing
  network; no EPCS. Data is synthetic.
- **Known gaps.** A retryable error that exhausts 5 attempts dead-letters without a person-facing
  alert (TODO). The patient result page maps pharmacy_error/cancelled to "under review".
