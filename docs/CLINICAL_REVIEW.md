# Clinical review record

**Status: UNSIGNED. No licensed clinician has reviewed CareLoop's rules.** CareLoop is a synthetic
portfolio demo. Passing tests, evals or this checklist is not clinical validation and does not
authorize real patients, prescribing or autonomous renewals.

This file is the place a qualified clinical reviewer records a decision on each deterministic
check in `src/domain/rules/`. A row may only be marked `SIGNED` with a reviewer role, date and
the exact threshold text reviewed. `scripts/clinical-review.test.ts` fails if a rule in code has
no row here, or if a row claims `SIGNED` without a reviewer and date.

How to review: read the rule's source and its tests, confirm the threshold and the fail-closed
behavior, then edit the row. Disagreements go to an adjudicator and are recorded in the notes.
Threshold provenance lives in `docs/sources.md`; where a threshold has no cited source the row says
TODO and a clinical lead must supply one.

| Rule | What it checks (as coded)                                        | Threshold provenance                                  | Status   | Reviewer role | Date | Notes |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------- | -------- | ------------- | ---- | ----- |
| R00  | Check-in responses are well formed; otherwise escalate           | Design choice (fail closed)                           | UNSIGNED |               |      |       |
| R01  | Identity verified                                                | Design choice                                         | UNSIGNED |               |      |       |
| R02  | Medication is on the formulary allowlist                         | Design choice; list is synthetic (TODO clinical lead) | UNSIGNED |               |      |       |
| R03  | Not a controlled substance                                       | Design choice (controlled never enters AI path)       | UNSIGNED |               |      |       |
| R04  | Active clinician order exists for the drug                       | Design choice                                         | UNSIGNED |               |      |       |
| R05  | No dose, frequency or drug change requested                      | Design choice                                         | UNSIGNED |               |      |       |
| R06  | Renewals since last visit below the refill limit                 | Limit value TODO: confirm source with clinical lead   | UNSIGNED |               |      |       |
| R07  | PHQ-9 item 9 above zero escalates                                | PHQ-9 scoring in docs/sources.md                      | UNSIGNED |               |      |       |
| R08  | PHQ-9 total or rise since last check-in escalates                | Cut-offs TODO: confirm with clinical lead             | UNSIGNED |               |      |       |
| R09  | Pregnancy answer yes or unknown escalates                        | Design choice                                         | UNSIGNED |               |      |       |
| R10  | Severe side effect reported escalates                            | Design choice                                         | UNSIGNED |               |      |       |
| R11  | Positive mania screen escalates                                  | Design choice                                         | UNSIGNED |               |      |       |
| R12  | Patient asked for a human escalates                              | Design choice                                         | UNSIGNED |               |      |       |
| R13  | AI extraction failure or risk signal escalates (AI can only add) | Design choice                                         | UNSIGNED |               |      |       |
| M01  | Drug name, formulary id and RxCUI agree                          | Design choice                                         | UNSIGNED |               |      |       |
| M02  | Dose form consistent with the allowlist entry                    | Design choice                                         | UNSIGNED |               |      |       |
| D01  | Drug-specific check for trazodone                                | TODO clinical lead                                    | UNSIGNED |               |      |       |
| D02  | Drug-specific check for mirtazapine                              | TODO clinical lead                                    | UNSIGNED |               |      |       |
| D03  | Drug-specific check for hydroxyzine                              | TODO clinical lead                                    | UNSIGNED |               |      |       |
| P01  | Order name, dose and owner are consistent                        | Design choice                                         | UNSIGNED |               |      |       |
| P02  | Renewal history is readable                                      | Design choice                                         | UNSIGNED |               |      |       |

## Out of scope for this record

Clinical leadership approval of the SHADOW evaluation plan, a blinded holdout set and prospective
evidence are tracked as open goals in `docs/PRODUCTION_READINESS.md`.
