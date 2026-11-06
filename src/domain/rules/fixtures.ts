// Test fixtures only (synthetic data). A fully clean, auto-eligible baseline input.
import type { RuleInput } from "./types";

export function baseInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    identityVerified: true,
    medication: {
      rxcui: "4493",
      name: "fluoxetine",
      doseMg: 20,
      frequency: "daily",
      controlledSchedule: null,
      formularyId: "fluoxetine",
    },
    activeOrder: { status: "active", intent: "order", rxcui: "4493" },
    requestedChange: "none",
    renewalsSinceLastVisit: 0,
    refillLimit: 2,
    checkIn: {
      phq9: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      gad7: [0, 0, 0, 0, 0, 0, 0],
      pregnancy: "no",
      severeSideEffect: false,
      maniaScreen: false,
      requestedHuman: false,
    },
    priorPhq9Total: null,
    monitoring: null,
    ai: { status: "ok", signals: [] },
    ...overrides,
  };
}
