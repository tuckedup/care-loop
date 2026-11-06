---
name: clinical-rules
description: Domain reference for the renewal rules, PHQ-9/GAD-7 scoring, escalation triggers and FHIR/SCRIPT vocabulary. Use when editing rules, check-in UI, or clinician views.
---
- PHQ-9 bands: 0–4 minimal, 5–9 mild, 10–14 moderate, 15–19 moderately severe, 20–27 severe. Item 9 is scored separately.
- GAD-7 bands: 0–4, 5–9, 10–14, 15–21.
- MedicationRequest.status: active | on-hold | cancelled | completed | entered-in-error | stopped | draft | unknown.
  Use intent "order" for clinician orders.
- Task.status for the queue: requested → in-progress → completed | cancelled | failed.
- SCRIPT message names to mirror: NewRx, RxRenewalRequest/Response, CancelRx, RxChangeRequest, RxFill, Status, Error.
- Escalation triggers from the public Utah protocol: suicidality, severe side effects,
  signs of mania, pregnancy, patient request. When in doubt, escalate.
