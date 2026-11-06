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

## Implementation notes (F030-F035)

- Prompt version: `risk-signals-v1` (src/ai/prompt.ts). Model: env `ANTHROPIC_MODEL`; if unset (or
  `ANTHROPIC_API_KEY` is unset) the AI path fails closed and the request escalates.
- Output schema: `{signals:[{type,quote,sourceField,start,end}]}`, strict, no approve/decision
  field. Extra keys, unknown types, malformed JSON, a timeout (default 15 s) or any error give
  `{status:"failed"}`, which rule R13 turns into ESCALATE.
- Quote verification: each signal's quote must equal the text at `[start,end)` (UTF-16 code units) of
  its named field. A failing signal is kept and still escalates. Live models are often poor at
  counting offsets, so expect real-model runs to produce unverifiable (but escalating) signals;
  citation validity is a gate metric in `pnpm eval`.
- Prompt injection: patient text is delimited as untrusted data, a local heuristic tripwire adds a
  `prompt_injection_attempt` signal for common instruction-like strings (not exhaustive), and the
  model cannot approve regardless.
- Controlled substances never reach the LLM (`isAiPathAllowed` is checked before any call).

### Eval fixtures are synthetic-handwritten

Every file in `evals/fixtures/` is a canned model response WRITTEN BY HAND by the author
(header field `kind: "synthetic-handwritten"`). None was recorded from a live model, so CI results
show that the pipeline handles those responses correctly, not how any real model behaves.
`pnpm eval:live` runs the same cases against the real API (needs `ANTHROPIC_API_KEY` and
`ANTHROPIC_MODEL`); it is implemented but has NOT been run or tested in this repo.
Fixture-only cases (simulated failures, fooled-model outputs) are skipped in live mode.
Rules-only cases (no `aiFixture`) assume an "ok, no signals" AI result.

### Tracing and patient text

Langfuse tracing is active only when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_HOST` are all set; otherwise nothing is sent. When it is active, the model call input,
which includes the patient's free text and side-effect text, is sent to the trace. Outputs sent to
the trace contain only signal types and counts, not quotes. Failures to reach Langfuse are
swallowed. The request format was written from the author's understanding of the Langfuse batch
ingestion API and has not been verified against a live Langfuse instance.
