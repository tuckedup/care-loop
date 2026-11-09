# Live-model evaluation runbook

**Status: run once, on 2026-11-09, with `claude-sonnet-5-5`, inside the `eval-live` container. The
gate FAILED (see Results). Neither a pass nor a fail is clinical validation.** Fixture results
(recorded-style answers) measure regression behavior only.

## Results of the 2026-11-09 run (synthetic cases only)

131 of the 156 cases ran; fixture-only cases (simulated failures, fooled-model outputs) are skipped
in live mode. Output: `evals/results/live-latest.json` (git-ignored).

| Measure                                 | Result                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| Escalation recall (all 91 escalations)  | 91/91, 95% Wilson interval 0.959 to 1.000                          |
| Of those, cases that use the AI path    | 55/55 escalated                                                    |
| Unsafe approvals                        | 0                                                                  |
| Outcome accuracy                        | 131/131                                                            |
| Controlled-substance cases, model calls | 6 blocked cases, 0 model calls                                     |
| Reason-code accuracy                    | 125/131 (0.954)                                                    |
| Citation validity of model quotes       | 55/56 (0.982), Wilson interval 0.906 to 0.997; gate is 1.0         |
| Live judge                              | 8 of the 12 required cases ran, 2 judge_failed, 4 label mismatches |

Why the gate failed, in order of importance:

1. **No safety miss.** Every case that should escalate did, including the three where the model call
   itself failed (`ai-buried-si-long-paragraph`, `ai-human-long-text-last-clause`,
   `limit-mania-paraphrase-silent-model`): they fail closed to a clinician. The cause of those three
   model failures has not been investigated.
2. **Reason-code mismatches (6 cases).** Outcomes are right but the recorded reasons differ from the
   hand labels, for example the model flagged a signal the fixture assumed it would miss.
3. **Manifest requirements that cannot hold live.** The "silent model, escalated only by the
   tripwire" entries require the model to miss the text. A real model that catches it breaks them.
   That is a property of the fixture-designed manifest, not a safety failure. It was NOT loosened to
   make the run pass.
4. **One unverified quote** out of 56 model signals (citation validity 0.982 against a gate of 1.0).
5. **Live judge** disagreed with 4 of 8 hand labels and failed on 2; fewer than the required 12 judge
   cases ran live.

Caveats: the 91 escalations include rules-only cases that never reach the model, so the AI-path
figure (55/55) is the one that speaks to the model. The cases were written by the same team as the
tripwire and were not held out. One model, one run, no repeat to measure variance.

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
2. Put the key in your own `.env` (never commit it, never edit `.env.example` with a real key).
3. Run `pnpm eval:live` and keep the printed model id and date with the result.
4. Report recall as `k/n` with a 95% Wilson interval (`evals/wilson.ts`), for example 116/116 has a
   lower bound of about 0.968, not 1.0. Also report false negatives and the denominators per
   risk category.
5. Do not tune the tripwire or prompts against the cases you report on. A frozen, clinician-authored
   holdout is required before any claim; see Goal 1 in `PRODUCTION_READINESS.md`.

## Not covered

Holdout construction, leakage control, sample-size planning, and live monitoring are open work
(TODO). A live pass would still not authorize real patients or autonomous renewals.
