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
- required cases that no longer demonstrate what their requirement says. Each manifest entry names
  a `kind`: `tripwire-silent-model` (the model returned no signals and the tripwire escalated),
  `controlled-blocked` (AI path blocked, zero client calls, failed AI result), `injection` (the
  injection detector hit the text), `llm-failure` (the AI result failed), `benign-clean`
  (AUTO_ELIGIBLE with no signals), `risk`/`rules` (the required outcome and reason code, both in the
  label and in the actual result). At least two distinct cases must exercise the AI-path block;
- edited required cases: every manifest entry carries a sha256 pin over the case's full check-in
  input, medication, history, expected label and the id and contents of its AI fixture (the
  free-form `scenario`, `category` and `labeledFrom` notes are not pinned). Changing any of them
  makes the gate fail until the pin is regenerated with `pnpm eval:pins` (`pnpm eval:pins --
--check` verifies the pins are current; `scripts/eval-pins.ts`). Regenerating a pin is a
  reviewed act: state in the change why the case changed, and never edit a case or its pin just to
  make a failing run pass. `eval:pins` also ratchets `minTotalCases` upward, never down. The
  requirement table itself (ids, kind, outcome, reason code, `signalTypes`) is edited by hand;
- AI risk cases must contain a model or tripwire signal of an expected type (`signalTypes`), and
  the `benign-clean-ai` kind requires an exercised AI path (fixture present, ok result, zero
  signals); removing an AI fixture from such a case fails the gate;
- path overrides in the environment: `EVAL_CASES_DIR`, `EVAL_FIXTURES_DIR` and `EVAL_RESULTS_PATH`
  exist only for the gate's own subprocess tests and are honoured only when `EVAL_ALLOW_OVERRIDES=1`,
  `NODE_ENV=test`, `CI` is unset and a per-run nonce set by `scripts/eval-gate.test.ts` matches a temp
  file it wrote. Setting them otherwise (e.g. in CI, or a plain `EVAL_ALLOW_OVERRIDES=1 pnpm eval`)
  fails the gate. This is a guard against accidents, not a security boundary. An overridden run
  stamps `casesDir`/`fixturesDir` into its results and can never write the committed `latest.json`.

`EVAL_LIVE=1` without `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` fails before running anything and
writes nothing. Live results go to `evals/results/live-latest.json`, never over `latest.json`.
`latest.json` records `fixtureKind: "synthetic-handwritten"` and `liveModelRun: false`, so it
cannot be mistaken for a live-model result.

Cases in `evals/cases/*.json` are labeled by a human from the SPEC rules, never from model or code
output, and must not be weakened to make a run pass. Commit `evals/results/latest.json` with the change.

## Tripwire recall guard

The local tripwire (`src/ai/tripwire.ts`) may only ADD signals, and its recall may not regress:
`src/ai/tripwire-differential.test.ts` asserts that every span flagged by the frozen ce058db
version (`src/ai/__fixtures__/tripwire-ce058db.ts`, a regression oracle that must not be edited) is
also covered by the current tripwire. Do not weaken that test to land a lexicon change. The
`scripts/eval-gate.test.ts` subprocess tests use asynchronous `spawn`, not `spawnSync`, because a
blocking child process starves vitest's worker RPC channel and the run exits non-zero.

## Visit summary agent (F041)

`summarizeRenewal` (`src/ai/summarize.ts`) uses the same injectable `RiskLlmClient` as risk
extraction and the same fail-closed discipline, but it is display-only. Rules for changes: it must
never feed a decision, an escalation or an event; every shown line must cite a server-supplied
source id and the server must drop the rest; any failure shows "Summary unavailable" and no text;
it must run behind `isAiPathAllowed` and `isAiPathPermitted` (controlled or unidentified
medications make zero client calls). The visit view renders each citation as an anchor to the
source event on the same page.
