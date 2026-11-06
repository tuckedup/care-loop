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
- Results: written to `evals/results/latest.json` by `pnpm eval` (synthetic-handwritten fixtures only; see Implementation notes). They show the pipeline handles those canned responses, not how any real model behaves.

## Known limitations

- The model can miss risk. A model that returns no signals for risky text is only caught if a
  tripwire phrase happens to match; a structured check-in answer is the other safeguard.
- Tripwire normalisation handles case, accents, many Cyrillic/Greek/Latin look-alikes (dotless i,
  small capitals), digit look-alikes (k1ll), invisible/blank characters (Hangul fillers, Braille
  blank, zero-width) and letter-spaced words ("s u i c i d e"). Remaining known misses:
  look-alikes outside the small mapped set (e.g. most other scripts, full-width is handled by
  NFKD only), letter-spacing with punctuation ("s.u.i.c.i.d.e", "s-u-i-c-i-d-e"), reversed or
  encoded text, leetspeak beyond simple digits, single-letter-spaced runs broken by one stray
  character, abbreviations other than "kms", and everything listed next.
- Known tripwire misses (non-exhaustive): non-English text; indirect or euphemistic phrasing
  ("go to sleep and not wake up", "disappear", "they would miss me less"); methods not listed;
  deliberate misspellings beyond simple digit/look-alike substitution; spaced-out letters
  ("s u i c i d e"); risk expressed only through context. The list also over-escalates on innocent
  uses of its words (e.g. "die", "overdose" asked about as a safety question).
- The tripwire lexicons are small, English-only and not exhaustive; they will miss many phrasings
  and over-escalate on some innocent uses of the same words. Not clinically validated.
- Offsets from a live model are often wrong, which makes real signals unverifiable (they still
  escalate) and can fail the live citation gate.
- A live model has never been run in this repo: `pnpm eval:live` and the Anthropic client are
  untested against the real API, and all eval fixtures are hand-written.
- The Langfuse request shape has not been verified against a live instance.
- Known fixture-set gaps: far fewer cases than the SPEC target (60+, 25+ risk cases); per-category
  minimums are not yet met.

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
- AI-path gate (positive allow-list): the LLM is called only if the medication positively resolves
  to an allowlisted, non-controlled formulary entry. That means the RxCUI maps to such an entry, any
  formularyId agrees, and the medication name passes the rules' own identity and dose-form checks
  (R02, M01, M02, reused from `src/domain/rules`). Controlled, unknown, blank, mismatched or
  look-alike medications make zero LLM calls and the request escalates. The guarantee is only as
  strong as those rule checks and the bundled formulary data; it is covered by tests, not proven.
- Input bound: patient text over 2000 characters per field (`FREE_TEXT_MAX`) fails closed with zero
  model calls. Stop reasons other than `end_turn`/`stop_sequence` (including `refusal`) fail closed.
- Local tripwires (`src/ai/tripwire.ts`, `src/ai/injection.ts`): deterministic phrase lists that
  only ever ADD escalation signals, run regardless of what the model returns or whether the call
  fails. The self-harm/violence list is a HEURISTIC SAFETY NET, NOT CLINICALLY VALIDATED
  (TODO: clinical review of the lexicon). No sensitivity or specificity is claimed.

### Eval fixtures are synthetic-handwritten

Every file in `evals/fixtures/` is a canned model response WRITTEN BY HAND by the author
(header field `kind: "synthetic-handwritten"`). None was recorded from a live model, so CI results
show that the pipeline handles those responses correctly, not how any real model behaves.
`pnpm eval:live` runs the same cases against the real API (needs `ANTHROPIC_API_KEY` and
`ANTHROPIC_MODEL`); it is implemented but has NOT been run or tested in this repo.
Fixture-only cases (simulated failures, fooled-model outputs) are skipped in live mode.
Rules-only cases (no `aiFixture`) assume an "ok, no signals" AI result.

`evals/results/latest.json` carries `fixtureKind: "synthetic-handwritten"` and `liveModelRun: false`
(true only for `pnpm eval:live`), plus `aiCases`, `modelSignalsChecked` and `tripwireSignals`, so it
cannot be mistaken for a live-model result. Citation validity is computed over ALL model-produced
signals (tripwire signals are excluded and counted separately). The gate fails if no AI-fixture case
ran, if no model signal was citation-checked, or if citation validity is below 1.0.

### Tracing and patient text

Langfuse tracing is active only when `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and
`LANGFUSE_HOST` are all set; otherwise nothing is sent. When it is active, the model call input,
which includes the patient's free text and side-effect text, is sent to the trace. Outputs sent to
the trace contain only signal types and counts, not quotes. Failures to reach Langfuse are
swallowed. The request format was written from the author's understanding of the Langfuse batch
ingestion API and has not been verified against a live Langfuse instance.
