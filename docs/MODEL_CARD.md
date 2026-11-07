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
- What the tripwire DOES handle (all heuristic, escalation-only, not clinically validated):
  case, accents, many Cyrillic/Greek/Latin look-alikes (dotless i, small capitals), digit
  look-alikes ("k1ll"), invisible/blank characters (Hangul fillers, Braille blank, zero-width);
  run-together phrases ("killmyself", "I will killmyself", "betteroffdead", "nopointinliving"),
  which the original ce058db tripwire already caught and which a differential test now guarantees
  cannot regress (see below); letter-spaced words, i.e. two or more single letters separated by
  whitespace of any width, also with trailing punctuation, brackets, preceding one-letter words or
  whole-sentence spacing ("s u i c i d e.", "(k i l l m y s e l f)", "I w a n t t o d i e"); and
  irregular spacing INSIDE LONG phrases of 8+ letters ("s uicide", "k ill myself", "suic i d e",
  "no point in liv ing"), via a "squeezed" scan that must start and end on word boundaries.
- Recall invariant: the current tripwire flags a SUPERSET of what ce058db flagged. A frozen copy
  of that version (`src/ai/__fixtures__/tripwire-ce058db.ts`, a regression oracle) is compared
  against the current code on a lexicon-by-noise corpus and 5,000 seeded random strings. The
  run-together patterns keep ce058db's trade-off: whole-word tokens such as "killme" fire.
  A 200-sentence benign corpus (deterministic cross product of ordinary check-in sentences and
  tricky look-alike words such as "audience", "diet", "friend my life") gains no false positives
  relative to ce058db.
- What it still does NOT handle (known misses, non-exhaustive):
  - irregular spacing of SHORT words and phrases (under 8 letters once spaces are removed), e.g.
    "d ie", "di e", "d e a d", "k m s", "u n a l i v e" written with gaps in odd places; short
    words are deliberately not squeezed because it would make "audience"-type false positives;
  - letter-spacing with punctuation or other separators ("s.u.i.c.i.d.e", "s-u-i-c-i-d-e",
    "s_u_i_c_i_d_e"), or a zero-width/blank character between letters of a spaced word;
  - spaced phrases that contain an apostrophe or hyphen ("c a n ' t g o o n", "s e l f - h a r m");
  - look-alikes outside the small mapped set (most other scripts), reversed or encoded text
    (rot13, base64, leetspeak beyond simple digits), abbreviations other than "kms";
  - non-English text; indirect or euphemistic phrasing ("go to sleep and not wake up", "they
    would miss me less"); methods not listed; deliberate misspellings beyond the substitutions
    above; risk expressed only through context.
  - Over-escalation: the lists also fire on innocent uses of their words (e.g. "die", "overdose"
    asked about as a safety question), on whole-word tokens like "killme", and on spaced single
    letters or squeezed word sequences that happen to spell a phrase.
- The tripwire lexicons are small, English-only and not exhaustive; they will miss many phrasings
  and over-escalate on some innocent uses of the same words. Not clinically validated.
- Offsets from a live model are often wrong, which makes real signals unverifiable (they still
  escalate) and can fail the live citation gate.
- A live model has never been run in this repo: `pnpm eval:live` and the Anthropic client are
  untested against the real API, and all eval fixtures are hand-written.
- The Langfuse request shape has not been verified against a live instance.
- Eval set size: the SPEC target (60+ cases, 25+ risk cases, each risk category at least 3 cases with an
  adversarial one) is met; see the eval set section below. The cases are small, synthetic and hand-labelled,
  so they demonstrate behaviour and regressions, not clinical validity or sensitivity.

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
In live mode, fixture-only cases (simulated failures, fooled-model outputs) are skipped, but
cases whose medication is blocked from the AI path always run, because they make no model call and
the gate requires at least two of them.
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

## Cited visit summary (F041)

`src/ai/summarize.ts` produces a short, display-only summary for the clinician visit view. It is not
an input to any rule, escalation, approval or event. Each line must carry a `sourceId` that is one
of the ids the server supplied: an event id of that renewal (`evt-<global position>`), a visit
event of the same patient, or a visit-note id. The server drops any line that is uncited, cites an
unknown id, is malformed or is a duplicate, and shows how many lines were removed. It fails closed:
no client, no model, a timeout, an error, non-JSON or schema-invalid output, or no valid cited line
left all yield "Summary unavailable" with no summary text, and the clinician actions are never
blocked. The same positive AI gate as the decision pipeline runs first, so controlled or
unidentified medications never reach the model (tested with a spy client).

What the server guarantees, and what it does not. Guaranteed: (1) every shown line cites an id the
server supplied (id membership only); (2) a deterministic deny-list drops any line with
recommendation, reassurance or approval wording (approve, recommend, safe, clear, cleared, low risk, eligible, ok to
renew, no concerns, no red flags, green light, unremarkable and similar phrases, plus approval stems
in Spanish, French, German and Portuguese/Italian), and for escalated
renewals any line asserting an absence of risk; dropped lines are counted and shown as "N lines
removed". The matcher folds accents and combining marks (NFD then NFKC), format characters,
fullwidth and math-alphanumeric forms, spacing and zero-width splits, and a table of Cyrillic, Greek,
small-capital and leetspeak lookalikes. It over-blocks on purpose (for example any use of "clear")
and is a heuristic that is not exhaustive: other scripts, rare lookalikes, paraphrases and other
languages can still pass. (3) source text reaches the model as one JSON array with control and format characters
removed and every bracket replaced, and source ids must be plain `[A-Za-z0-9_-]` tokens. NOT
guaranteed: a cited line's claims are not verified against the text of its source, so a misleading
sentence that avoids the deny-list can still be shown under a real id; the deny-list is a heuristic
and not exhaustive; prompt injection resistance of the model itself is not claimed. The page labels
the summary "AI-generated summary, not a recommendation; escalation reason codes above are
authoritative", and the reason codes remain the authoritative record.

Known limits: the summary has not been run against a live model; its quality is not evaluated (no
CREOLA-style labelling yet, see SPEC section 11); the call carries no idempotency key (it is a
read-only generation); successful summaries are cached in process memory for five minutes. Test
fixtures are hand-written (synthetic-handwritten). `SUMMARY_FIXTURE=synthetic-handwritten` enables a
hand-written fixture model only when `NODE_ENV` is exactly `development` or `test` (default deny),
for e2e.

## Eval set, labelling and known limitations (F063-F066)

How the eval cases were made: every case in `evals/cases/*.json` was labelled by hand from SPEC
sections 2, 4 and 5 and the clinical-rules skill BEFORE it was run; no label was copied from the
output of the code or a model. `labeledFrom` in each case says which rule or SPEC text the label
comes from. Where the system's behaviour goes beyond the SPEC (dose-form checks M01/M02, the
`nightly` string for trazodone, the six-month monitoring boundary, ESCALATE outranking
FOLLOW_UP_REQUIRED) the case says IMPLEMENTATION-SPECIFIC in `labeledFrom`. The model answers
used by AI-dependent cases are hand-written canned responses (`synthetic-handwritten`); no live
model has ever produced a result in this repo, so the results show how the pipeline reacts to a
correct or a missing model signal, not how any real model performs.

The case set is organised by risk category (`RISK_CATEGORIES` in `evals/schema.ts`); each
category has at least three cases including one adversarial phrasing, enforced by
`scripts/evals-count.test.ts`. For each AI-dependent risk case the `labeledFrom` note records
which layer is expected to catch it: the (canned) model signal, the phrase tripwire with a silent
model, or a structured answer / rule with a silent model. Counts, per-category breakdown and
metrics are in `evals/results/latest.json`.

Known limitations the eval set demonstrates (kept in `evals/known-limitations/`, NOT gated, and
asserted to still fail by `scripts/evals-count.test.ts` so they cannot go stale silently):

- If the model returns no signal and the wording is outside the small tripwire lexicon and no
  structured answer covers it, the system escalates nothing and the outcome is AUTO_ELIGIBLE. The
  probes cover: passive ideation ("hope I just do not wake up"), buried intent ("giving away my
  belongings because I will not be needing them"), mania described in free text, a disguised dose
  change ("can I take two instead of one") with the change box left at none, pregnancy hinted at
  ("prenatal vitamins"), a request for a human in free text with the box unticked, severe side
  effects described only in text, and a patient admitting that the PHQ-9 answers were not honest.
  For these wordings the model is the ONLY protection. In SHADOW mode a clinician still approves
  every renewal; in RETRO and SAMPLED modes such a renewal is sent automatically.
- The tripwire cannot read tone: gallows humour ("die of boredom", "kms") escalates by design
  (accepted over-escalation, escalate-when-in-doubt).
- Natural product wording that adds a dose-form word the allowlist entry does not contain
  ("duloxetine DR", "desvenlafaxine ER", unspecified "bupropion") escalates. This is
  implementation-specific over-escalation (usability cost, safe direction); the SPEC lists those
  drugs without a form word. TODO: dose-form-level RxCUIs.
- GAD-7 has no rule in SPEC section 4, so a GAD-7 of 21 does not affect the outcome (a labelled
  case documents this; TODO: clinical review whether a trigger is wanted).
- Mirtazapine monitoring: SPEC names baseline and six-month monitoring only. The due point
  (>= 6 months since baseline) and the absence of a recurrence interval are implementation
  choices. TODO: source needed.
