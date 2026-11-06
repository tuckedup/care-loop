# Sources

All CareLoop data is synthetic. These sources back the rules, vocabulary, and design choices.
Agents: do not add or modify URLs in this file. Use `TODO: source needed` for gaps.

## Legion Health & the Utah AI pilot (product scope, escalation rules, formulary)
- Utah OAIP — Legion Health AI pilot page (scope, escalation triggers, phased validation, FAQ):
  https://commerce.utah.gov/ai/regulatory-relief/authorized-ai-pilots/ai-legion-health/
- Utah OAIP — Legion agreement summary page:
  https://commerce.utah.gov/ai/agreements/ai-legion-health/
- Signed Legion mitigation agreement (PDF; formulary is in the schedules):
  https://commerce.utah.gov/wp-content/uploads/2026/03/Legion-Agreement.pdf
- Utah OAIP — AI FAQ (formularies, pharmacist escalation line, physician of record):
  https://commerce.utah.gov/ai/ai-faq
- TechRepublic — formulary drug list as reported:
  https://www.techrepublic.com/de/article/news-utah-ai-chatbot-psychiatric-prescription-renewals/
- Behavioral Health Business — 15-drug formulary, 98% concurrence in first 250 requests:
  https://bhbusiness.com/?p=11267
- Legion Health — YC company jobs page (stack postings):
  https://www.ycombinator.com/companies/legion-health/jobs

## FHIR (data shapes)
- FHIR R4 MedicationRequest (status, intent):
  https://hl7.org/fhir/R4/medicationrequest.html
- FHIR R4 Task (review queue statuses):
  https://hl7.org/fhir/R4/Task.html
- Medplum — Task-based work queues guide:
  https://www.medplum.com/docs/careplans/tasks
- HL7 Clinical Order Workflows — workflow state overview:
  https://build.fhir.org/ig/HL7/fhir-cow-ig/workflow-state-overview.html
- AuditEvent vs Provenance (WSO2 Healthcare docs):
  https://healthcare.docs.wso2.com/docs/secure-health-apis/guides/auditing

## E-prescribing (NCPDP SCRIPT message vocabulary)
- ONC electronic-prescribing test method §170.315(b)(3), SCRIPT 2023011 (NewRx, CancelRx, RxRenewal, RxChange, RxFill):
  https://healthit.gov/test-method/electronic-prescribing
- ONC HTI-4 eRx fact sheet (SCRIPT 2023011 required by Dec 31, 2027):
  https://www.healthit.gov/sites/default/files/2025-09/eRX_RTPB_Fact_Sheet_HTI-4_OCT2025_508.pdf
- Surescripts — e-prescribing transactions overview:
  https://surescripts.com/what-we-do/e-prescribing
- 7-digit NCPDP pharmacy ID explainer:
  https://www.mindbowser.com/ncpdp-integration/

## Drug vocabulary
- NLM RxNav / RxNorm APIs (free; includes notice that the interaction API was discontinued):
  https://lhncbc.nlm.nih.gov/RxNav
- DrugBank — NIH discontinued its drug-interaction API:
  https://blog.drugbank.com/nih-discontinues-their-drug-interaction-api/

## Controlled substances & telehealth (why controlled meds are excluded)
- 21 CFR 1311.125 — EPCS logical access control (two-person rule):
  https://www.law.cornell.edu/cfr/text/21/1311.125
- DEA press release — telemedicine flexibilities extended through Dec 31, 2026:
  https://www.dea.gov/press-releases/2025/12/31/dea-extends-telemedicine-flexibilities-ensure-continued-access-care
- Federal Register — Fourth Temporary Extension:
  https://www.federalregister.gov/documents/2025/12/31/2025-24123/fourth-temporary-extension-of-covid-19-telemedicine-flexibilities-for-prescription-of-controlled
- Frier Levitt — special registration final rule sent to OIRA (Aug 25, 2026):
  https://www.frierlevitt.com/articles/dea-telemedicine-special-registration-final-rule-oira/

## HIPAA audit
- 45 CFR 164.312(b) audit controls (eCFR):
  https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312#p-164.312(b)

## Clinical screening & measurement-based care
- Kaiser Permanente Washington — PHQ-9 item 9 → C-SSRS workflow:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC8919974
- PHQ-9 item 9 vs C-SSRS electronic screening comparison:
  https://pubmed.ncbi.nlm.nih.gov/26278339/
- Joint Commission CTS.03.01.09 measurement-based care FAQ:
  https://www.jointcommission.org/en/knowledge-library/support-center/standards-interpretation/standards-faqs/000001252

## Clinical AI evaluation & transparency
- CREOLA framework — hallucination/omission taxonomy (npj Digital Medicine 2025):
  https://pmc.ncbi.nlm.nih.gov/articles/12075489/
- CHAI applied model card ("nutrition label"):
  https://chai.org/chai-advances-assurance-lab-certification-and-nutrition-label-for-health-ai/

## Engineering patterns
- Emmett PostgreSQL event store announcement:
  https://event-driven.io/en/emmett_postgresql_event_store/
- Event sourcing in Node.js samples (Oskar Dudycz):
  https://github.com/oskardudycz/eventsourcing.nodejs
- Transactional outbox in Postgres, end to end:
  https://dev.to/gabrielanhaia/outbox-pattern-in-postgres-end-to-end-producer-relayer-consumer-2k75

## Synthetic data
- Synthea (MITRE):
  https://github.com/synthetichealth/synthea
- Synthea (MITRE) home:
  https://synthea.mitre.org/

## Agent workflow
- Anthropic — Effective harnesses for long-running agents:
  https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
