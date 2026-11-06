# Model card (stub)

Structure follows the CHAI applied model card idea. Populated by the AI and eval features.
All data is synthetic; nothing here is clinical validation.

## Intended use

Extract escalation-relevant risk signals from patient free text in a prescription-renewal
check-in, and draft a cited summary for a clinician. The model never approves or overrides a rule.

## Out of scope

Controlled substances (never enter the AI path), diagnosis, dose changes, drug-interaction checks.

## Model

- Provider/model: set by env `ANTHROPIC_MODEL` (TODO: record the exact model used for published eval results)
- Prompt and schema version: TODO

## Safety design

- Rules in `src/domain/rules` are pure and deterministic; the LLM can only add escalation signals.
- Fail closed: LLM error, timeout, or schema-invalid output escalates.
- Every risk signal must quote an exact span of the patient text; the server verifies offsets.
- Clinician summary lines without a source citation are dropped.

## Evaluation

- Metrics: escalation recall (must be 1.0), auto-approve precision, citation validity (must be 1.0),
  CREOLA-style summary labels from an LLM judge.
- Results: TODO (written to evals/results/latest.json and the README)

## Known limitations

TODO (filled in as evals surface failures; never weaken cases to pass).
