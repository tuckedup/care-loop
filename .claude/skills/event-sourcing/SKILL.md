---
name: event-sourcing
description: Conventions for events, streams, decide/evolve, projections, outbox and idempotency in CareLoop. Use when touching src/domain or src/infra.
---
- Commands → decide(state, command) → events[]; evolve(state, event) → state. Both pure.
- Append with expectedVersion; on a conflict, reload and retry once, then surface the error.
- Event names are past tense; payloads are Zod schemas in src/domain/events.ts and versioned (v1).
- Projections are idempotent: track last_position per projection and skip already-applied positions.
- Side effects only via the outbox in the same transaction; consumers dedupe on messageId.
- Tests: given(events).when(command).then(events | error).
