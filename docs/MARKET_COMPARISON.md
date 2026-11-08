# Market and UX comparison

Checked 2026-11-07 against the linked public product and standards pages. This is a product-design
comparison, not a clinical-performance comparison. CareLoop has no real-world users, care outcomes,
prescription transactions, or live-model evaluation to compare.

## What public products report

| Product/source               | Publicly reported measure                                                                                                            | What it can tell us                                                | What it cannot tell us                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Legion Health AI refill page | $19/month, 24/7 product messaging; its footnote says each renewal remains subject to clinical review and provider approval           | Positioning and review model                                       | No published sensitivity, refill turnaround, fill rate, or user-task success measure found on the inspected page |
| NHS App, August 2026         | 7,620,985 repeat orders; 6,121,973 distinct ordering users; 453,732 tracking viewers; tracking enabled at 3,264 pharmacy sites (31%) | Large-scale demand and prescription-tracking adoption in England   | Not an outcome or safety benchmark for a US psychiatric renewal workflow                                         |
| MyChart medication features  | Renewal requests and pharmacy-ready notifications are listed as product capabilities                                                 | Notifications and pharmacy status are expected experience patterns | No comparable public psychiatric refill outcome or usability denominator found                                   |
| Talkiatry refill help        | Requests medication, dose, last fill, days of supply, and preferred pharmacy; phone, email, app, and portal paths                    | Useful intake fields and support-channel visibility                | Its visit interval is that provider's policy and should not be copied as a CareLoop rule                         |

The NHS app separates approval by the practice from preparation and readiness at the pharmacy,
shows reasons a medicine may be unavailable to request, and gives a route for urgent requests.
CareLoop should preserve that separation: an approval, a transmission, a pharmacy fill response,
and readiness for collection or delivery are different states. CareLoop's mock pharmacy cannot
confirm collection or delivery.

## CareLoop baseline and targets

| Measure                    | Current CareLoop evidence                                                                                         | Next product measurement                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety-eval cases          | 156 hand-written synthetic cases; 116/116 expected escalations; zero fixture unsafe approvals; liveModelRun=false | Clinician-authored blinded holdout, reviewer agreement and category-level false-negative analysis before considering prospective evaluation |
| User adoption              | No production users                                                                                               | Do not estimate or compare adoption until deployed with approved instrumentation                                                            |
| Patient flow usability     | Playwright covers synthetic flows; no representative-user study                                                   | By task and role: completion/failure, elapsed time, errors, path deviations, satisfaction, and safety misunderstandings                     |
| Clinician queue operations | Synthetic queue and pharmacy-alert flows; no staffed service level                                                | Queue-age p50/p95, time-to-first-review, overdue items, ownership coverage, and alert recovery in a monitored pilot                         |
| Pharmacy throughput        | Seeded mock messages only                                                                                         | Delivery attempt rate, retry/dead-letter rate, duplicate suppression, fill response time, and reconciliation with a real partner sandbox    |
| Accessibility              | Automated smoke coverage only                                                                                     | Keyboard and screen-reader review; reflow at 320 CSS px/400% zoom; test patients and clinicians separately                                  |

The ONC safety-enhanced-design method is a useful measurement template when applicable: for
certification capabilities it describes user-centered design, at least 10 summative participants per
capability, and task success/failure, performance time, errors and satisfaction reporting. This
portfolio demo has not undergone that testing and makes no certification claim.

## Product changes to prioritize

1. Keep patient-facing status explicit about the difference between clinician decision, transmission,
   pharmacy report, and actual ready-to-collect or delivered status.
2. Explain blocked medicines and show a real, monitored support route in any future service; the demo
   must state that it is not monitored.
3. Add event-backed notifications, queue ownership and escalation deadlines only with an operational
   team able to act on them.
4. Run role-specific usability tasks on a production-like build and publish denominators, task scripts,
   participant role, dates, and known limitations alongside metrics.

## Sources

The research URLs and their source organizations are listed in [sources.md](sources.md).
