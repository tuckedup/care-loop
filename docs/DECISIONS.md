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
  Existing approval guards (REJECT / R01-R03 / controlled / follow-up refused) are untouched.
- **NO_CONFIRMED_PHARMACY.** `Approve` is refused in the DOMAIN (not just the disabled button) when
  no pharmacy was confirmed or the renewal names no prescription, so an approval that could never be
  sent is impossible for every caller. The patient flow requires a `PharmacySelected` before a
  check-in is accepted, so a clinician does not meet this state in normal use. Seed history approvals
  are written directly as events ending in a filled chain (PharmacySelected, RxRenewalQueued,
  RxRenewalTransmitted, status, RxFillReceived; no outbox rows) so they read "Filled" and still count
  toward the refill limit.
- **APPROVED_NOT_SENT.** Defence in depth: a renewal approved with a confirmed pharmacy that has no
  RxRenewalQueued after 15 minutes (demo configuration, TODO: source needed, not a clinical value) is
  swept into a non-retryable PharmacyErrorReceived{APPROVED_NOT_SENT}: alert for clinician and
  pharmacist. The normal path cannot produce it (queued in the same append). Until then the patient
  sees "approved, waiting to be sent", never "sent".
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
- **Transmit gate is a positive allow-list.** Besides the schedule flag, the medication must resolve
  (the rules' R02/M01/M02 via isAiPathPermitted, which also rejects every controlled signal) to an
  allowlisted, non-controlled formulary entry, both when Approve would queue a transmission (the
  approval is refused with MEDICATION_NOT_TRANSMITTABLE) and in the worker. "alprazolam" with a null
  schedule, homoglyphs and unknown drugs never transmit.
- **Dead letters surface.** The worker runs dead-letter hooks every pass (idempotent). For
  pharmacy.RxRenewalResponse a queued renewal whose send is refused, fatal or out of retries gets a
  terminal PharmacyErrorReceived{TRANSMIT_DEAD_LETTERED}: rx_status shows a problem, clinician and
  pharmacist see an alert, the patient sees "there was a problem sending your prescription", and the
  patient may renew again. A message that WAS transmitted but later reaped to dead, or whose retries
  were exhausted by network failures or timeouts (the pharmacy may have received the request), is
  labelled TRANSMIT_UNCONFIRMED instead ("sent but never confirmed") and stays supersedable, so a new
  renewal can never silently duplicate it; only answers that prove non-receipt (e.g. busy) end as
  TRANSMIT_DEAD_LETTERED. A forged row for a renewal that was never queued gets no event (nothing was
  promised); it stays visible as a dead outbox row.
- **Stalled renewals and SUPERSEDE.** A renewal in queued/transmitted/pharmacy_status with no fill
  after PHARMACY_STALE_HOURS (default 72; demo config, TODO: source needed for a real value, not a
  clinical threshold) is swept (clock injected at the cron/script edge) into a non-retryable
  PharmacyErrorReceived{STALLED_NO_FILL}: alert, and it no longer blocks the patient starting a new
  renewal. STALLED_NO_FILL and TRANSMIT_UNCONFIRMED renewals stay UNSETTLED for the duplicate-send
  guard (the pharmacy may still hold them), so nothing is sent twice silently. They are resolved by
  SUPERSEDE: when a clinician approves a newer renewal R2, the approve handler finds earlier
  unfilled renewals of the prescription that are stalled/unconfirmed (injected clock), and the SAME
  transaction that queues R2 carries `supersedes` on R2's RxRenewalQueued and enqueues a
  pharmacy.CancelRx per superseded renewal (key `rx-cancel:<R1>:<R2>`). rx_status shows R1
  `cancel_requested`, then `cancelled` on the pharmacy's acknowledgement, and the guard treats R1
  as settled-by-supersede. At SEND time the cancel handler re-checks R1: if it has meanwhile been
  filled or cancelled, no CancelRx is sent (the message completes and the reason is audited). A fill
  or cancel acknowledgement that arrives after the other is never a silent status change:
  FILL_AFTER_SUPERSEDE (a fill for a superseded renewal) and CANCEL_AFTER_FILL (a cancel
  acknowledgement for a filled one) are recorded once and alerted. Precedence in rx_status: filled
  is final, a cancel acknowledgement that came first stays cancelled, a fatal error yields to either.
  A fresh (not stalled) earlier renewal still blocks R2: R2 is dead-lettered with an alert.
- **Race-safe start + deterministic duplicates.** startRenewal checks inside the append transaction
  (the audit chain-head row lock serialises writers; no session-level locks): a competing open
  renewal is resumed, an in-flight one refuses. If two renewals of one prescription are queued
  anyway, the earliest RxRenewalQueued position sends; the later is dead-lettered WITH the alert.
- **Hardening.** Mock outcomes (fatal / OK / fill / duplicate / escalation) depend only on (seed,
  idempotency key / messageId); only a RETRYABLE error also depends on the attempt, drawn from
  (key, attempt) with a 50% chance of persisting (demo tuning), so a retry can recover and every
  (key, attempt) is still deterministic;
  MOCK_PHARMACY_FORCE is honoured only when NODE_ENV is exactly development or test; pharmacy answers
  are capped (64 KiB, 50 messages) and over-cap is a fatal parse error; pharmacy_alerts is keyed on
  (renewal_id, message_id) (migration 0013); terminal rx_status outcomes (filled, cancelled, fatal
  error) are not overwritten by late Status/Transmitted/retryable messages (fill still beats a fatal
  error, cancel beats all); the Langfuse call carries an Idempotency-Key.
- **Patient copy** comes from one table (`status-copy.ts`) covered by a per-status test: "filled"
  says filled, a retryable error says we are retrying (and claims no notification), only
  non-retryable errors and cancellations say the care team has been notified (an alert row exists),
  `cancel_requested` says the earlier request is being replaced by a newer one.
- **Known gaps.** Superseding relies on the pharmacy honouring CancelRx (the mock always
  acknowledges); a CancelRx that cannot be delivered is dead-lettered with a CANCEL_DEAD_LETTERED
  alert on the superseded renewal. Seeded history reads "Filled" without any real transmission.

## ADR: Follow-up visits, audit coverage, verification and the audit view (F051-F057)

Status: accepted for the demo. Data is synthetic. Wording: "HIPAA-aligned design, synthetic data";
the audit chain is tamper-EVIDENT, not a compliance certification.

- **Booking never approves.** When R06 yields FOLLOW_UP_REQUIRED the pipeline appends
  FollowUpRequired (ESCALATE still outranks it, so a renewal with any safety signal is escalated,
  not parked as a follow-up). The patient books a visit with `bookFollowUpVisit`, which appends
  VisitBooked to the `visit-fu-<renewalId>` stream and touches nothing on the renewal stream. Approve
  stays refused for follow-up renewals (APPROVAL_OF_FOLLOW_UP / ALREADY_DECIDED); a test proves a
  clinician still cannot approve after a booking.
- **One visit per renewal, no double booking, race-safe.** The stream id is derived from the
  renewal (one booking per renewal). The synthetic slot grid is weekday 30-minute slots 09:00-17:00
  UTC for the one synthetic scheduling clinician, up to 28 days out (placeholders, TODO: real
  availability; not clinical thresholds). Slot validity (future, on the grid, exactly 30 minutes)
  is checked in the pure aggregate with an injected clock; overlap with the clinician's other
  VisitBooked events is checked INSIDE the append transaction, after the audit chain-head row lock
  that already serialises every audited write, so two concurrent bookings of one slot cannot both
  win (tested). The slot end is derived server-side, never taken from the form. A clinician-booked
  visit (renewal BookVisit, which lands in the renewal stream) is also counted by the overlap and
  per-renewal checks, but the clinician command does not look at patient bookings (known gap: it
  could add a second visit).
- **Note signing.** `signVisitNote` is allowed only for the clinician the visit was booked with
  (the VisitBooked.clinicianId); a booking without a clinician fails closed. It appends
  VisitNoteSigned + CalendarSlotCreated{slotId,start,end} in one append (visit stream), then
  FollowUpTaskCreated in `task-fu-<visitId>` (a second append: one stream per append; the task id
  is derived from the visit id, never the note id). Every call
  converges, so a retry after a crash between the two appends still ends with exactly one task and
  one slot. The follow-up slot is the first FREE grid slot at or after the visit slot shifted by 28 days
  (synthetic placeholder; TODO: source needed; booked visits and calendar slots count as held).
  Signing is refused before the visit starts (injected clock). The note
  text is not stored in this demo; the note id is derived from the visit id so a double submit is
  the same note. FHIR Task status is "requested" (visit_schedule projection; no event carries it).
- **Counter reset.** Nothing new was needed in the rules: renewals-since-last-visit is derived from
  events and a VisitNoteSigned on a visit booked for the patient resets it. An end-to-end test
  proves it with the real R06 path: held at the limit, still held after booking alone, released
  after signing, held again one approval later.
- **Reset scope (explicit choice).** The count is per patient AND prescription. A visit booked for
  a renewal (patient follow-up `fu-<renewalId>` or clinician `cv-<renewalId>`) resets the count
  only for THAT renewal's prescription: attribution looks the renewal up among the patient's
  requests, and an unknown renewal is not attributable. A visit with no renewal (visit history, as
  in the seed) is a general visit and resets all of the patient's prescriptions. TODO: clinical
  confirmation of this scope. A clinician-booked visit also writes its booking into the visit
  stream (second append after the renewal-side BookVisit; both idempotent, so retrying the action
  converges) so that note and booking sit in one visit stream. One visit per renewal in either
  booking order: the second booking is refused (ALREADY_BOOKED).
- **e2e and the AI step.** With no API key the AI step fails closed (R13 LLM_FAILURE), which
  outranks R06, so a UI run would always escalate. `RISK_FIXTURE=synthetic-handwritten` (honoured
  only when NODE_ENV is exactly development or test, same gate as SUMMARY_FIXTURE) swaps in a
  hand-written client that returns no signals. It cannot approve anything: local tripwire and
  injection scans and every rule still run, and production ignores it (tested).
- **Audit coverage (F055).** An AST test discovers every function taking an AuditContext (not a
  hand list), forbids optional contexts, and checks every call site passes an object literal with
  actor/role/action, a forwarded AuditContext, or a helper that provably returns one (no casts, no
  undefined; a user role may not hard-code the actor). The set of files that call
  appendToStream/auditedTransaction directly is pinned, so a new writer fails until reviewed.
  Entry points under src/app that reach a writer must call an auth guard. A runtime scenario shows
  every event has an audit entry naming its position, with system actors (decision pipeline,
  outbox worker) recorded. Limits: name-based call resolution (a same-named function elsewhere is
  over-approximated, not missed); it proves a context is passed, not that the actor value is
  correct for a given code path (that is what the per-feature actor tests assert).
- **`pnpm audit:verify` (F056).** Recomputes the chain from DATABASE_URL, prints the first broken
  seq and exits 1 on tamper (2 if it cannot verify, never 0 on error). The append-only triggers
  stop the application role; a database superuser or table owner can disable them, which is exactly
  what the tests do on a privileged raw connection in an isolated schema. Editing, deleting a
  middle or the last entry, or forging an entry hash are all detected. NOT detected: a superuser who
  rewrites the whole chain from some point forward AND resets audit_chain_head. Closing that needs
  the head hash anchored outside the database (TODO).
- **audit_view and /admin/audit (F057).** audit_view is a projection driven by events: replaying an
  event locates its audit entry and copies every not-yet-copied entry up to it, so it is
  deterministic and rebuildable (0015 adds the table plus an index on audit_log(entity); the index
  does not alter rows). Entries after the newest event appear when the next event is replayed;
  non-event bookkeeping before it (outbox done/dead) is included. The page is admin only, shows
  FHIR AuditEvent-shaped JSON (not a conformant FHIR server, no terminology URIs) and a chain badge
  from verifyAuditChain, which reads the whole log on every load (fine for a demo).

### Amendment after the F051/F052 safety review

- **No signing before the visit starts.** SignVisitNote carries an injected `now` and is refused
  (VISIT_NOT_STARTED) unless now >= the visit start: a signed note resets the refill counter, so it
  is tied to a visit that has actually begun. The clinician page shows a disabled button with the
  reason until then. e2e cannot wait for a slot, so `VISIT_CLOCK_OFFSET_DAYS` shifts the clock used
  only for signing, honoured only when NODE_ENV is exactly development or test (default deny,
  tested); booking never uses it.
- **Counter attribution.** A VisitNoteSigned resets a patient's counter only if it was written in
  the visit's own stream (`visit-<visitId>`) and that same stream holds a VisitBooked for THAT
  patient; a VisitBooked elsewhere (for example a renewal stream with a copied visit id) never
  vouches for another patient's note. The clinician BookVisit no longer accepts a client visit id
  (derived `cv-<renewalId>` on the server) and any booking whose visit id already exists in another
  stream or for another patient/renewal is refused (VISIT_ID_CONFLICT).
- **Crash repair.** `repairUnfinishedSignings` (cron `/api/cron/visits`, CRON_SECRET fail-closed, or
  `pnpm exec tsx scripts/visits-repair.ts`) completes signed notes that lack the follow-up task,
  with a system actor `visit-repair`; idempotent. A conflicting task stream is reported, not guessed.
- **Atomic id checks.** Task and calendar-slot ids derive from the visit id (not the note id); a
  note id used by another visit, a conflicting task stream, or a taken follow-up slot is refused
  inside the signing transaction, so nothing is written.
- **Calendar slots are held time.** The slot picker and booking check both booked visits and
  CalendarSlotCreated slots, and the follow-up slot is the first free grid slot at/after the
  default gap. TODO: source needed for the 28-day follow-up gap (demo scheduling placeholder, not a
  clinical value).

## ADR: autonomy modes, auto-approval and retrospective review (F059-F062)

Status: accepted for the demo. All data is synthetic. Implementer choices below need confirmation.

- **Mode is an event.** `AutonomyModeChanged{mode, changedBy}` on the stream `settings-autonomy`
  (additive event). No events, an unreadable or schema-invalid stream, or any error reads as
  SHADOW (`readAutonomyMode` never throws). Only an admin changes it: the server action calls
  `requireRole("admin")` first, the actor is the session subject, and the aggregate re-checks the
  role. A non-SHADOW mode also needs a valid `SEED` / `SAMPLE_RATE` config; a config error is SHADOW.
- **One system-approval path.** `RenewalApproved{by:"system"}` is produced only by the review
  aggregate's `AutoApprove` command, whose schema cannot express SHADOW. It refuses unless, from
  the stream itself: the rules outcome is AUTO_ELIGIBLE and every rule result passed; nothing is
  escalated (including a late signal), controlled, blocked or pipeline-errored; the AI recorded a
  clean result (a `RiskSignalsExtracted` with no signals and no `unavailable:` / `local-tripwire:`
  marker; a missing record is not clean); identity is verified; no clinician started review; a
  pharmacy is confirmed. The handler adds the positive transmit allow-list
  (`medicationTransmittable`) and refuses when an earlier unsettled renewal of the same
  prescription exists (that needs a clinician to supersede it). Approval, `RxRenewalQueued`, the
  outbox row, the sampling event and the audit entry are one transaction (`handleCommandWithOutbox`).
  Any refusal or error leaves the renewal for a clinician: SHADOW behaviour.
- **Transmit gate widened narrowly.** `checkTransmittable` used to accept only clinician approvals.
  It now also accepts a system approval, but only when the stream folds to a clean AUTO_ELIGIBLE
  renewal (outcome, rulesClean, aiClean, not escalated, no reviewer) and the approval event carries
  autonomyMode RETRO or SAMPLED; a forged system approval of an escalated renewal, or one stamped
  SHADOW, is refused (tests). The CancelRx handler still requires a clinician-approved superseding
  renewal, which is why an auto-approval never supersedes anything.
- **Sampling.** `sampleUnit = sha256("careloop-sample:" + seed + ":" + renewalId)` first 48 bits / 2^48,
  selected when `< rate`. Deterministic per (seed, renewal id, rate); the event reason is
  `RETRO_ALL` (RETRO queues every auto-approval) or `SAMPLED_RANDOM`. `AuditSampleSelected` gained an
  optional `reason`. In SAMPLED mode an unsampled auto-approval gets no retrospective review by
  design. TODO: product decision whether a long-unreviewed share should alert.
- **Retro review.** `RecordRetroReview` is clinician only, reviewer id from the session, one
  review per renewal, and only for a system auto-approval that was queued for review. A
  non-concurrence appends the event, and the `renewal_metrics` projection records a
  `RETRO_NON_CONCURRENCE` anomaly that the dashboard and the review page show as an alert and count.
  It does not switch the mode automatically (TODO: owner decision; the alert suggests Shadow).
- **renewal_metrics projection (migration 0016).** One row per renewal: request/decision times,
  decision (gated like the queue: a system decision on an escalated row is ignored, a clinician
  decision needs its id and, when escalated, a review start), escalation reason codes, sampling and
  review outcome. Time to decision = RenewalRequested -> first honoured approval / denial /
  follow-up. The 98% concurrence figure is shown only as a TARGET label from public reporting; the
  page shows a measured rate over synthetic demo reviews, or an empty state, never a claim.
- **Dev/test switches for e2e.** The auto-renew e2e needs `RISK_FIXTURE=synthetic-handwritten`
  (existing dev/test-only gate) so the model stand-in answers "no signals"; without it the AI path
  fails closed and every renewal escalates. The default mock pharmacy fills only a random share of
  messages, so the Filled assertions need `MOCK_PHARMACY_FORCE=retry-then-fill` and are skipped
  without it.
- **Eval page.** `/admin/evals` reads `evals/results/latest.json` (and `live-latest.json` if it
  exists) with Zod; a missing or malformed file shows an explicit state. F069: `outputFileTracingIncludes`
  in next.config.ts includes `evals/results/*.json` in the server bundle for `/admin/evals` (checked by a
  config test and a local build; not verified on Vercel).

### F069 - Vercel config and production hardening

- **Crons.** `vercel.json` schedules /api/cron/outbox, /decisions and /visits once a day so the file deploys on
  a Hobby plan (more frequent expressions need Pro). Every route checks `Authorization: Bearer $CRON_SECRET`
  (constant time, unset secret gives 401) and Vercel sends that header itself when the variable is set. With
  daily crons the outbox drains rarely; Pro-plan schedules are in the README. Not deployed or verified on Vercel.
- **Demo auth in production is default deny.** `demoAuthEnabled()` (src/infra/auth/production-guards.ts) is true
  in a production build only when DEMO_AUTH_ENABLED is exactly `true`. Off: /login shows a disabled notice, the
  switchRole action redirects, and `getSession` ignores any demo cookie (a previously issued cookie stops
  working). Outside production it is on unless set to `false`. The Playwright webServer sets it to `true`
  because CI runs the e2e suite against `pnpm build && pnpm start`.
- **SESSION_SECRET.** `getSecret` now also rejects, in production only, any value starting with the
  .env.example placeholder prefix; missing or short secrets were already rejected. A null secret means nothing
  can be signed or verified (fail closed) and the login action redirects with a not-configured error.
- **Rate limiting.** In-memory fixed window per (route, IP) in src/infra/rate-limit.ts: mock pharmacy 120/min,
  cron routes 30/min (before the secret check), login 20/min (LOGIN_RATE_LIMIT_PER_MIN overrides it; the e2e
  server raises it because every spec signs in from one address). Per instance and best effort: serverless
  instances do not share counters, cold starts reset them, and x-forwarded-for is only trustworthy behind a
  proxy that sets it (the rightmost entry is used). The outbox worker calls the mock pharmacy from one egress
  address, so a drain of more than 120 sends in a minute would see 429 responses (retried like any error).
- **Headers.** CSP is enforced (CSP_REPORT_ONLY=true switches it to report-only at build time). script-src keeps
  `'unsafe-inline'` because no nonce middleware exists; dev adds `'unsafe-eval'`. A nonce-based CSP is a known
  improvement, not done.
- **Pooler.** postgres.js runs with `prepare: false`; no LISTEN/NOTIFY and no session advisory locks exist (the
  event store uses a row lock in a transaction). Never tried against a real Supabase pooler.

### Post-v1.0 — production autonomy lock and data minimization

The signed Utah agreement describes a phased, organization-specific pilot with identity,
prescription, consent, stability, timing, and oversight controls that this synthetic demo does
not implement. Until those controls and an independently reviewed evaluation exist, production
builds force SHADOW regardless of stored mode, reject RETRO/SAMPLED mode changes, and refuse
direct auto-approval. The central audited append path also refuses system approvals in production,
and the pharmacy transmit handler refuses any pre-existing system-approved stream before a network
call. This is a deliberate fail-closed stop, not an implementation of the pilot.
The criteria for revisiting it are in `docs/PRODUCTION_READINESS.md`.

Local Docker Postgres now binds to loopback, not all interfaces. Optional trace exports contain
only input lengths, status, and signal counts rather than patient text, quotes, or signal types.
These controls reduce accidental exposure but do not make the demo suitable for real health data.
