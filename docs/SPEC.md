# CareLoop spec

## 1. Product
Patients on a stable, existing, non-controlled psychiatric medication request a refill.
They do a short check-in. Deterministic rules plus LLM risk extraction either auto-renew
(depending on the autonomy mode) or escalate to a clinician. A mock pharmacy returns
NCPDP-SCRIPT-style status messages. Hitting the refill limit forces a follow-up visit.
Signing a visit note creates a follow-up Task and a calendar slot.

Roles: patient, clinician, pharmacist, admin. Demo auth uses a role switcher with a
signed cookie, labeled "demo auth". RBAC is enforced server-side.

## 2. Formulary (15-drug allowlist from the signed Utah Legion agreement)
fluoxetine, sertraline, escitalopram, citalopram, paroxetine, venlafaxine ER,
desvenlafaxine, duloxetine, bupropion SR, bupropion XL, trazodone, mirtazapine, buspirone,
hydroxyzine HCl, hydroxyzine pamoate.
Source: signed Legion mitigation agreement (docs/sources.md). The agreement also sets
drug-specific conditions separate from REFILL_LIMIT: trazodone ≤150 mg nightly, baseline
and six-month metabolic/CV monitoring for mirtazapine, and quantity and age restrictions
for both hydroxyzine forms. Implement these as dedicated eligibility checks (not R06
refill-count config). The public agreement does not specify numeric hydroxyzine cutoffs;
escalate hydroxyzine requests until those limits are sourced and implemented.
Store RxNorm RxCUIs. Use the RxNav REST API at seed time and cache results to JSON.
Also seed some controlled meds (e.g. alprazolam, lisdexamfetamine) so tests can prove they're blocked.
Do NOT implement drug-interaction checking (NLM retired its interaction API).

## 3. Events (one stream per aggregate: patient-*, rx-*, renewal-*, task-*, visit-*)
PatientRegistered, MedicationPrescribed{rxcui, dose, sig, controlledSchedule|null, prescriberId},
RenewalRequested, IdentityVerified, CheckInSubmitted{phq9[9], gad7[7], sideEffects, severeSideEffect,
pregnancy: yes|no|unsure, maniaScreen, freeText, requestedHuman, requestedChange},
RiskSignalsExtracted{signals[{type, quote, sourceField, start, end}], model, latencyMs},
EligibilityEvaluated{results[{ruleId, passed, detail}]},
RenewalEscalated{reasonCodes[]}, ClinicianReviewStarted, RenewalApproved{by: system|clinician, autonomyMode},
RenewalDenied{reason}, RxRenewalQueued, RxRenewalTransmitted{messageId, idempotencyKey},
PharmacyStatusReceived{status}, PharmacyErrorReceived{code, retryable}, RxFillReceived,
FollowUpRequired, VisitBooked, VisitNoteSigned, CalendarSlotCreated{slotId, start, end},
FollowUpTaskCreated,
PharmacistEscalationReceived, AuditSampleSelected, RetroReviewRecorded{concur: boolean}.

Event store: Postgres table events(global_position bigserial, stream_id, stream_version,
type, data jsonb, metadata jsonb, created_at), UNIQUE(stream_id, stream_version) for
optimistic concurrency. Use Emmett (@event-driven-io/emmett-postgresql) if it works cleanly
with Supabase's pooler. Otherwise hand-roll it and record why in DECISIONS.md.
Projections: renewal_queue, patient_med_list, phq9_trend, rx_status, audit_view.
Each projection must be rebuildable from position 0 (`pnpm projections:rebuild`).

## 4. Hard rules (src/domain/rules, pure functions, each with tests)
R01 identity verified, else reject
R02 medication on formulary allowlist
R03 controlled substance → hard block from the AI path
R04 there is an active clinician-originated MedicationRequest for this drug
R05 no dose, frequency, or drug change requested
R06 renewals since last visit < REFILL_LIMIT (config, default 2), else FollowUpRequired
R07 PHQ-9 item 9 ≥ 1 → escalate (more conservative than KP's ≥2 threshold; explain in DECISIONS.md)
R08 PHQ-9 total ≥ 15, or a rise of ≥ 5 from the last score → escalate
R09 pregnancy yes or unsure → escalate
R10 severe side effect → escalate
R11 positive mania screen → escalate
R12 patient requested a human → escalate
R13 any LLM risk signal, LLM failure, or invalid output → escalate
Outcome: AUTO_ELIGIBLE | ESCALATE(reasons) | REJECT(reason) | FOLLOW_UP_REQUIRED

## 5. AI
extractRiskSignals: Zod-validated JSON output. Every signal quotes an exact span of the
patient's free text. The server checks each quote really appears at the given offsets;
any signal that fails the check counts as an escalation.
summarize (clinician view): every line cites a source (event id or note id); uncited lines are dropped.
Model comes from env ANTHROPIC_MODEL. Trace calls to Langfuse if keys are present.

## 6. Autonomy modes (admin setting, mirroring Utah's phases)
SHADOW: the AI recommends; a clinician must approve every renewal.
RETRO: AUTO_ELIGIBLE renewals are sent automatically; all are queued for retrospective review.
SAMPLED: sent automatically; a seeded random SAMPLE_RATE share goes to review.
Dashboard: concurrence rate (target ≥ 98%), escalation mix, time to decision.

## 7. Pharmacy and outbox
The outbox table is written in the same transaction as the events. A worker
(Vercel Cron route plus a local script) claims rows with FOR UPDATE SKIP LOCKED and
retries with exponential backoff (max 5) before dead-lettering.
/api/mock-pharmacy accepts NewRx and RxRenewalResponse-like JSON. With a seeded RNG it
returns Status OK, Error (retryable or not), delays, duplicate RxFill messages, and
occasional CancelRx acknowledgements. Consumers dedupe on messageId.
Pharmacies are fake, with 7-digit IDs, and confirm-before-send shows name, address, and phone.

## 8. Audit
audit_log(seq, actor, role, action, entity, at, prev_hash, hash), hash = sha256(prev_hash + canonical JSON).
`pnpm audit:verify` detects tampering. /admin/audit renders FHIR AuditEvent-shaped JSON.

## 9. Screens
Patient: renew → verify → check-in → result (approved, under review, or follow-up needed) → status.
Clinician queue: FHIR-Task-style statuses (requested / in-progress / completed).
Visit view: active vs stopped meds, readable in 3 seconds, with dose changes flagged;
PHQ-9/GAD-7 sparkline; cited AI summary; rule results; Approve / Deny / Book visit.
Pharmacist inbox: escalations from the pharmacy. Admin: autonomy, audit, eval results.

## 10. Evals (evals/)
60+ hand-labeled synthetic cases in evals/cases/*.json:
{id, scenario, input: CheckInSubmitted, med, history, expected: {outcome, reasonCodes}}.
At least 25 risk cases, including hard ones: buried suicidal ideation, sarcasm,
pregnancy mentioned in passing, a disguised dose-change request, controlled meds,
contradictory answers, and prompt injection in the free text.
Metrics: escalation recall (must be 1.0), auto-approve precision, citation validity
(must be 1.0), and CREOLA-style summary labels (hallucination or omission × major or minor)
from an LLM judge.
CI runs with recorded LLM responses (evals/fixtures). `pnpm eval:live` hits the real API.
Results are written to evals/results/latest.json and shown in the README.

## 11. Tests
Unit: every rule, and decide/evolve in given-events → when-command → then-events style.
E2E (Playwright): (a) happy auto-renew in RETRO mode, (b) item-9 escalation → clinician
approves, (c) pharmacy error → retry → fill, (d) refill limit → follow-up → note signed → task created.

## 12. Non-goals
No real e-prescribing network, no EPCS, no real PHI, no interaction checking,
no claims of compliance.
