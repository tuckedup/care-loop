# AI agents and the development harness

## Runtime AI (inside the product)

- `extractRiskSignals`: Zod-validated JSON, quote-verified signals, can only add escalations.
- `summarize`: clinician-facing summary, every line cites an event or note id.
- LLM-as-judge for CREOLA-style labels, used in evals only.

## Development agents (Claude Code, see CLAUDE.md and .claude/)

- Session ritual: read progress + git log + feature_list.json, run `./init.sh` and `pnpm test`,
  build exactly one feature, verify, commit, append to claude-progress.md.
- Subagents: `verifier` (runs a feature's listed verification, edits nothing) and
  `clinical-safety-reviewer` (required before marking rules/ai/escalation/autonomy features passing).
- Skills: `event-sourcing`, `clinical-rules`, `eval-authoring`.
- Hooks (.claude/settings.json): block edits to `.env*` (except `.env.example`), block destructive
  commands and any UPDATE/DELETE on `events`, run Prettier after edits.

## Principles

Fail closed. The model never approves. Humans label eval expectations from the spec, never from
model output. Never weaken a test to make it pass.

## AI eval gate (F030)

AI renewal features (F031 onward, anything in `src/ai` or the AI decision path) may not be marked
`passes: true` while the eval gate is red or empty. The gate is `pnpm eval`. It fails on:

- zero cases, a schema-invalid case, or a missing AI fixture;
- escalation recall below 1.0, any unsafe auto-approval, or any case not matching its hand label;
- no AI-fixture case having run (the AI path must be exercised);
- no model-produced signal having been citation-checked (citation validity undefined), or
  citation validity below 1.0 (computed over all model-produced signals; tripwire signals are
  excluded and reported separately as `tripwireSignals`);
- no AI case exercising the controlled-substance AI-path block, or any LLM call for a blocked
  medication (the runner uses the same positive allow-list as production, `isAiPathPermitted`);
- the coverage floor: every case in `evals/required-cases.json` must exist and pass, and the number
  of case files must be at least `minTotalCases`. The floor only ratchets up; raise it when cases
  are added. The SPEC section 10 target (60+ cases, 25+ risk cases) is still open;
- path overrides in the environment: `EVAL_CASES_DIR`, `EVAL_FIXTURES_DIR` and `EVAL_RESULTS_PATH`
  exist only for the gate's own subprocess tests and are honoured only when `EVAL_ALLOW_OVERRIDES=1`,
  `NODE_ENV=test` and `CI` is unset. Setting them otherwise (e.g. in CI) fails the gate.

`EVAL_LIVE=1` without `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` fails before running anything and
writes nothing. Live results go to `evals/results/live-latest.json`, never over `latest.json`.
`latest.json` records `fixtureKind: "synthetic-handwritten"` and `liveModelRun: false`, so it
cannot be mistaken for a live-model result.

Cases in `evals/cases/*.json` are labeled by a human from the SPEC rules, never from model or code
output, and must not be weakened to make a run pass. Commit `evals/results/latest.json` with the change.
