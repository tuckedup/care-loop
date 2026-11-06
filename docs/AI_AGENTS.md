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
`passes: true` while the eval gate is red or empty. The gate is `pnpm eval`: it fails on zero
cases, on any schema-invalid case, on escalation recall below 1.0, on any unsafe auto-approval
(a case labeled non-AUTO_ELIGIBLE that the system auto-approves), and on any case that does not
match its hand-written label. Cases in `evals/cases/*.json` are labeled by a human from the SPEC
rules, never from model or code output, and must not be weakened to make a run pass.
`pnpm eval` writes `evals/results/latest.json`; commit it with the change.
