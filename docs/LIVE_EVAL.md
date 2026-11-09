# Live-model evaluation runbook

**Status: never run.** The live path in `evals/ai-runner.ts` is implemented and guarded, but no
API key was available, so no live result exists. Fixture results (recorded-style answers) measure
regression behavior only. Neither is clinical validation.

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
