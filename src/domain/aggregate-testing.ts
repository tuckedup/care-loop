// given(events).when(command).then(events | error): test helper for aggregates.
import { expect } from "vitest";
import { decideFrom, DomainError, type Aggregate } from "./aggregate";
import type { DomainEvent } from "./events";

type ErrorExpectation = { code: string } | (new (...args: never[]) => Error);

export function given<State, Command>(
  aggregate: Aggregate<State, Command>,
  ...history: DomainEvent[]
) {
  return {
    when(command: Command) {
      const run = (): DomainEvent[] => decideFrom(aggregate, history, command);
      return {
        /** Expect exactly these events, or a DomainError code / error class. */
        then(expected: DomainEvent[] | ErrorExpectation): void {
          if (Array.isArray(expected)) {
            expect(run()).toEqual(expected);
            return;
          }
          if (typeof expected === "function") {
            expect(run).toThrow(expected);
            return;
          }
          let thrown: unknown;
          try {
            run();
          } catch (e) {
            thrown = e;
          }
          expect(thrown, `expected DomainError ${expected.code}`).toBeInstanceOf(DomainError);
          expect((thrown as DomainError).code).toBe(expected.code);
        },
      };
    },
  };
}
