// Decide/evolve harness. Everything here is pure: aggregates never touch I/O.
// Loading, appending and auditing live in aggregate-handler.ts.
import type { DomainEvent } from "./events";

/** A rejected command: expected business-rule failure, not a bug. */
export class DomainError extends Error {
  override readonly name = "DomainError";
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * decide(state, command) -> events to append (or throws DomainError).
 * evolve(state, event) -> next state. Both must be pure and deterministic:
 * no clocks, randomness or I/O (pass such values in the command).
 */
export interface Aggregate<State, Command> {
  readonly initialState: State;
  decide(state: State, command: Command): DomainEvent[];
  evolve(state: State, event: DomainEvent): State;
}

/** Fold events into the current state. */
export function replay<State, Command>(
  aggregate: Aggregate<State, Command>,
  events: readonly DomainEvent[],
): State {
  return events.reduce((s, e) => aggregate.evolve(s, e), aggregate.initialState);
}

/** Pure decision: replay history, then decide. */
export function decideFrom<State, Command>(
  aggregate: Aggregate<State, Command>,
  history: readonly DomainEvent[],
  command: Command,
): DomainEvent[] {
  return aggregate.decide(replay(aggregate, history), command);
}
