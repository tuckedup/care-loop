# CareLoop — agent rules (read every session)

CareLoop is a portfolio demo of an AI-assisted psychiatric prescription-renewal loop,
modeled on Legion Health's public Utah pilot protocol. ALL DATA IS SYNTHETIC.
Full spec: docs/SPEC.md. Sources: docs/sources.md.

## Stack (match Legion's)
Next.js App Router (15.x), TypeScript strict, Tailwind, Supabase Postgres + Drizzle,
Zod at every boundary, Vitest, Playwright, Vercel, @anthropic-ai/sdk, pnpm.

## Session ritual
Setup session exception: if claude-progress.md, feature_list.json, init.sh, or .git do not
exist yet, the only allowed work is creating those bootstrap files. Skip steps 1–2 until
they exist.

1. Read claude-progress.md, `git log --oneline -20`, and feature_list.json.
2. Run ./init.sh, then `pnpm test`. If the baseline is red, fix that first.
3. Pick the highest-priority feature with "passes": false. Build ONLY that one.
4. Verify it end to end (unit tests plus Playwright where there's UI). Only then set "passes": true.
5. Commit with a descriptive message. Append a dated entry to claude-progress.md.

## Hard rules
- Never edit .env* except .env.example (template only). Never commit secrets. Never use real patient data.
- The events table is append-only: no UPDATE or DELETE, ever. All state comes from projections.
- Clinical decisions live in src/domain/rules as pure, deterministic functions with tests.
  The LLM may only ADD escalation signals. It can never approve or override a rule.
- Fail closed: an LLM error, timeout, or schema-invalid output means escalate.
- Controlled substances never enter the AI path. A test must prove it.
- Every external call takes an idempotency key. Side effects go through the outbox.
- Every write appends to the hash-chained audit log.
- Never write "HIPAA compliant" or "EPCS certified". Write "HIPAA-aligned design, synthetic data".
- Never invent URLs, citations, drug lists, or clinical thresholds; use only docs/ files and mark gaps as TODO.
- Before marking any rules/ai/escalation feature as passing, run the clinical-safety-reviewer subagent.

## Commands
pnpm dev | pnpm test | pnpm e2e | pnpm eval | pnpm db:migrate | pnpm db:seed | pnpm typecheck | pnpm lint
