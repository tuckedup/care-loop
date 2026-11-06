# Standards alignment

CareLoop is a portfolio demo with synthetic data. It makes no compliance claims. This file maps
design choices to the public standards and vocabularies listed in docs/sources.md. Wording rule:
"HIPAA-aligned design, synthetic data". Never claim HIPAA compliance or EPCS certification.

| Area                   | Vocabulary / standard mirrored                                         | Where in CareLoop                         | Status |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------- | ------ |
| Medication orders      | FHIR R4 MedicationRequest (status, intent)                             | patient_med_list projection               | TODO   |
| Review queue           | FHIR R4 Task statuses                                                  | renewal_queue projection, clinician queue | TODO   |
| Audit                  | FHIR AuditEvent-shaped JSON; audit controls concept                    | audit_log, /admin/audit                   | TODO   |
| E-prescribing messages | NCPDP SCRIPT names (NewRx, RxRenewal, CancelRx, RxFill, Status, Error) | mock pharmacy, outbox                     | TODO   |
| Drug vocabulary        | RxNorm RxCUIs via RxNav (cached at seed time)                          | formulary seed                            | TODO   |
| Screening              | PHQ-9, GAD-7 scoring bands                                             | src/domain/rules                          | TODO   |
| AI evaluation          | CREOLA hallucination/omission taxonomy                                 | evals/                                    | TODO   |
| AI transparency        | CHAI applied model card                                                | docs/MODEL_CARD.md                        | TODO   |

Non-goals: no real e-prescribing network, no EPCS, no real PHI, no drug-interaction checking.
Status column is updated by the feature that implements each row.
