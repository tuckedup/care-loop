import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

/**
 * R04: need an active clinician order (FHIR MedicationRequest status "active", intent "order")
 * for this drug. Missing, on-hold, stopped, draft, non-order intent, or an RxCUI mismatch
 * all escalate to a clinician (not auto-denied: a human should see why the order is not active).
 */
export function ruleR04(input: RuleInput): RuleEvaluation {
  const order = input.activeOrder;
  const rxcui = input.medication.rxcui;
  const ok =
    order !== null &&
    order !== undefined &&
    order.status === "active" &&
    order.intent === "order" &&
    typeof order.rxcui === "string" &&
    order.rxcui.length > 0 &&
    order.rxcui === rxcui;
  return ok
    ? pass("R04", "active clinician order exists for this drug")
    : fail(
        "R04",
        "ESCALATE",
        ["NO_ACTIVE_ORDER"],
        order
          ? `order not usable (status ${String(order.status)}, intent ${String(order.intent)}, rxcui match ${String(order.rxcui === rxcui)})`
          : "no active order on file",
      );
}

/**
 * R05: only a plain renewal may be auto-considered. Any dose, frequency, drug or other change
 * (or an unrecognised value) escalates to a clinician.
 */
export function ruleR05(input: RuleInput): RuleEvaluation {
  return input.requestedChange === "none"
    ? pass("R05", "no dose, frequency or drug change requested")
    : fail(
        "R05",
        "ESCALATE",
        ["CHANGE_REQUESTED"],
        `change requested or unrecognised value: ${String(input.requestedChange)}`,
      );
}
