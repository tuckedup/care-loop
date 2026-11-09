# Live-model evaluation runbook

**Status: run on 2026-11-09 with `claude-sonnet-5-5`, inside the `eval-live` container: two strict
gate runs and one 3-trial repeat run. The strict gate FAILED both times (see Results). Neither a pass
nor a fail is clinical validation.** Fixture results (recorded-style answers) measure regression
behavior only.

## Results (2026-11-09, synthetic cases only)

131 of the 156 cases run live; fixture-only cases (simulated failures, fooled-model outputs) are
skipped. Output files are git-ignored: `evals/results/live-latest.json` and
`evals/results/live-repeat.json`.

### Strict gate (`pnpm eval:live`), before and after a fix

The first run found two check-ins whose model call ended with `stop_reason: max_tokens` (output limit
1024, judge 1500): the truncated answer fails closed, so it escalated safely but the model's signal was
lost. Both limits were raised to 4096 (`src/ai/extract-risk-signals.ts`, `src/ai/judge.ts`) and the run
repeated.

| Measure                                 | First run   | After the fix | Note                                                                                                |
| --------------------------------------- | ----------- | ------------- | --------------------------------------------------------------------------------------------------- |
| Escalation recall (91 escalations)      | 91/91       | 91/91         | 95% Wilson 0.959 to 1.000                                                                           |
| Of those, AI-path cases                 | 55/55       | 55/55         |                                                                                                     |
| Unsafe approvals                        | 0           | 0             |                                                                                                     |
| Outcome accuracy                        | 131/131     | 131/131       |                                                                                                     |
| Controlled-substance cases, model calls | 0 (6 cases) | 0 (6 cases)   |                                                                                                     |
| Reason-code accuracy                    | 125/131     | 128/131       |                                                                                                     |
| Citation validity of model quotes       | 55/56       | 58/60         | gate is 1.0; Wilson 0.886 to 0.991                                                                  |
| Cases failing the gate                  | 6           | 3             |                                                                                                     |
| Live judge                              | 6/8 judged  | 6/8 judged    | 2 judge_failed, 4 label mismatches; unchanged, so not a token-limit problem; cause not investigated |

Why the strict gate still fails:

1. **No safety miss.** Every case that should escalate did.
2. **Three cases** (`ai-contradiction-pregnancy-unsure-text-denies`, `ai-human-flag-true-model-silent`,
   `ai-mania-screen-true-model-silent`) fail on reason codes: the fixtures assume a silent model and the
   real model caught the text. The "silent model, escalated only by the tripwire" manifest entries
   (18 manifest failures) cannot hold against a model that does not stay silent. This comes from how the
   fixtures were designed and the manifest was NOT loosened to make the run pass.
3. **Two quotes of 60 unverified.** Citation validity got slightly worse after the fix (0.982 to
   0.967) because more model signals now survive to be checked; model offsets are often off.
4. **Live judge** disagrees with 4 of 8 hand labels, fails on 2, and only 8 of the 12 required judge
   cases run live.
5. The two remaining "model failed" cases are the injection cases, which fail closed on purpose.

### Repeat run (`pnpm eval:live:repeat`, 3 trials per case)

Metrics follow the tau-bench pass^k definition and the clustered-standard-error advice in Anthropic's
"Adding Error Bars to Evals". It is informational and is not the gate.

| Measure                                      | Result                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| Escalation recall over trials                | 165/165, 95% Wilson 0.977 to 1.000                             |
| pass^3 over the 55 AI-path escalation cases  | 55/55 escalated in all 3 trials                                |
| Unsafe approvals; controlled-substance calls | 0; 0                                                           |
| Over-escalation on benign cases              | 0/45, Wilson 0.000 to 0.079                                    |
| Model call failed (fell back to escalation)  | 6/210, the two injection cases x 3 (not individually recorded) |
| Cases that behaved differently across trials | 0                                                              |

The clustered standard error is 0.0000 because no trial missed. Read the interval, not the point value.

Caveats: the 91 escalations include rules-only cases that never reach the model, so the AI-path
figures are the ones that speak to the model. The cases were written by the same team as the tripwire
and were not held out, one model was tested, and the fix was made after seeing the first result. A
clinician-authored holdout is still required before any claim.

## What a live run does

`pnpm eval:live` sets `EVAL_LIVE=1` and replays the labelled cases that carry an AI fixture through
the real Anthropic client. Rules-only cases run unchanged. Fixture-only cases are skipped and
reported. The result goes to `evals/results/live-latest.json` (git-ignored), never over
`latest.json`, and the admin Evals page shows it under "Live model run" with `liveModelRun: true`.

## Guards (all tested in `scripts/eval-gate.test.ts`)

- It refuses to start without `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` and writes nothing.
- Controlled-substance cases must make 0 model calls; the gate fails otherwise.
- Any model error, timeout or schema-invalid output is scored as an escalation (fail closed).
- The model can only add signals; the rules decide. A model "approve" has no path to an outcome.
- Model quotes are verified against the check-in text; unverified signals are counted, not trusted.

## How to run it

1. Use only synthetic cases. Never paste real or restricted patient text into the cases or prompts.
2. Put the key in your own `.env`, or in the git-ignored `secrets/anthropic_api_key` file for the
   container (never commit it, never edit `.env.example` with a real key).
3. Run `pnpm eval:live` (strict gate) and `pnpm eval:live:repeat` (set `EVAL_REPEATS`, default 3) and
   keep the printed model id and date with the result. In the container, add `pnpm eval:live:repeat`
   after the service name in the `run` command from `CONTAINERS.md`.
4. Report recall as `k/n` with a 95% Wilson interval (`evals/wilson.ts`), for example 116/116 has a
   lower bound of about 0.968, not 1.0. Also report false negatives and the denominators per
   risk category.
5. Do not tune the tripwire or prompts against the cases you report on. A frozen, clinician-authored
   holdout is required before any claim; see Goal 1 in `PRODUCTION_READINESS.md`.

## Not covered

Holdout construction, leakage control, sample-size planning, and live monitoring are open work
(TODO). A live pass would still not authorize real patients or autonomous renewals.
