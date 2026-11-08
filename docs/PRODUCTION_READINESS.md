# Production-readiness goals

CareLoop is a synthetic portfolio demo, not a clinical service. Passing fixture tests does not
authorize real patients, real prescribing, or autonomous renewals. The [signed Utah agreement](https://commerce.utah.gov/wp-content/uploads/2026/03/Legion-Agreement.pdf)
describes Legion Health's specific, limited pilot; it does not authorize CareLoop. This file separates
the remaining work into independently reviewable goals. Each goal is **open** until its exit criteria
are met by qualified owners with evidence, not by a feature flag.

## Goal 1 — Clinical evaluation and data

**Status: open.** The 156 pinned cases use hand-written synthetic inputs and recorded model answers.
Their 116/116 escalation result measures regression behavior on that set only. No live model, blinded
holdout, or prospective study has run.

- Use [Synthea](https://github.com/synthetichealth/synthea) generated FHIR records for synthetic
  longitudinal medication, encounter, and projection tests. These can test plumbing, not narrative
  risk recognition.
- A local inspection of Synthea's public FHIR R4 sample on 2026-11-07 found 114 JSON Bundles,
  112 Patient resources, and 3,221 MedicationRequest resources. The downloaded archive stays in
  ignored `.init/` and is not committed (SHA-256
  `66141b772671452f590f9b7bb999eb201f1f16beb94a84ab0885ed723b36b315`). These counts
  establish a useful integration corpus, not psychiatric refill labels.
- Keep restricted/de-identified patient records and social-media posts out of this repository and
  external model APIs. Publicly available does not mean synthetic or permitted for this use.
- Establish a separately held, clinician-authored synthetic challenge set. Two independent licensed
  reviewers label each case; disagreements go to an adjudicator. Freeze labels and prompts before
  testing, preserve provenance, and do not tune the tripwire against the holdout.
- Report denominators, false negatives and false positives by risk category, language, medication,
  and autonomy path, with uncertainty intervals. A clinical lead must approve any safety threshold
  and the prospective SHADOW evaluation plan before a real-use proposal.

**Exit:** independent protocol and labels, frozen holdout, reviewed analysis, prospective SHADOW
evidence, and a documented decision by clinical leadership. No benchmark score alone closes this goal.

## Goal 2 — Protocol and system safety

**Status: open; automatic renewal is locked in production.** The code's default SHADOW mode is a
useful backstop, but the [Utah pilot agreement](https://commerce.utah.gov/wp-content/uploads/2026/03/Legion-Agreement.pdf)
also calls for affirmative AI consent, stronger identity and prescription-history verification,
Utah scope, stability history, clinician-touch timing, escalation service levels, and written
approval before each oversight phase. The demo does not implement those real-world controls.

- Add a real identity provider, patient authorization, consent record, and authoritative medication
  history. Verify residency and physical location, and route uncertainty to a clinician.
- Represent recent dose changes, hospitalization or acute safety concerns, and time since clinician
  review as verifiable source data. Add deterministic, fail-closed rules with independently reviewed
  tests; do not infer missing clinical facts from free text.
- Add a monitored clinician queue with escalation deadlines and on-call ownership. Keep the
  prescribing clinician responsible for decisions and the pharmacy communication path.
- Require clinical, privacy, security, regulatory, and operational sign-off before considering any
  change to the production autonomy lock. Phase transitions must be explicit, audited approvals,
  not an admin toggle or a metric alone.

**Exit:** evidence for every protocol control, end-to-end failure testing, operational ownership,
and signed launch authorization. Until then, real-data use and production auto-renewal stay off.

## Goal 3 — Patient and clinician experience

**Status: open; synthetic demo flows work.** The landing page now explains the workflow and
includes a direct demo entry. The patient area states it is not monitored, fill-status copy no longer
implies pickup readiness, and the landing-page keyboard path is tested at 320 and 375 CSS pixels.
This is not a representative usability study.

- Obtain clinician review of every patient-facing safety question and outcome message. The mania
  question is explicitly marked as synthetic demo wording until reviewed.
- Test patient, clinician, pharmacist, and admin journeys on mobile and desktop with keyboard and
  assistive technology; use WCAG 2.2 and ONC safety-enhanced design as references.
- Use [MARKET_COMPARISON.md](MARKET_COMPARISON.md) to distinguish published competitor adoption
  metrics from CareLoop's absent real-world efficacy and usability metrics.
- Design clear urgent-refill support, status notifications, accessibility, loading and error states,
  and understandable reasons for ineligibility. Validate with representative users and measure
  task completion and safety-critical misunderstandings.

**Exit:** signed clinical copy, accessibility review, representative usability findings resolved,
and monitored support processes. A screenshot or green Playwright run cannot close this goal.

## Goal 4 — Infrastructure, privacy, and interoperability

**Status: open.** Docker Postgres is now bound to localhost for synthetic development, and optional
Langfuse traces no longer contain raw patient text or clinical signal types. These reduce exposure,
but the remaining system is not ready for protected health information.

- Replace demo role switching with real authentication and least-privilege database roles. Add
  external audit anchoring, backup/restore drills, incident response, retention controls, and
  security review of every vendor and data flow.
- Replace daily demo cron schedules with monitored workers and alerts sized to the approved
  escalation and pharmacy service levels. Test retries, dead letters, backpressure, and failover.
- Keep mock pharmacy and FHIR-shaped views labelled as mock/shaped. Real electronic prescribing
  requires a separate integration and conformance program under the
  [ONC electronic-prescribing test method](https://healthit.gov/test-method/electronic-prescribing).
- Perform a product-specific privacy and regulatory assessment before connecting real services or
  data. Never assume a signed agreement for another organization or a passing synthetic eval
  grants that permission.

**Exit:** independently reviewed threat model, vendor contracts, least-privilege and recovery tests,
monitored operations, and verified real interoperability under the intended deployment scope.
