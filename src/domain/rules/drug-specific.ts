// Drug-specific eligibility checks (SPEC section 2). Dedicated checks, not R06 config.
// Drug identity is established from ANY of: formularyId, RxCUI lookup, or the drug name text,
// so a mislabelled field cannot skip a check (fail closed).
import { findByRxcui } from "../formulary";
import { fail, pass, type RuleEvaluation, type RuleInput } from "./types";

type DrugFamily = "trazodone" | "mirtazapine" | "hydroxyzine";

function isDrug(input: RuleInput, family: DrugFamily): boolean {
  const med = input.medication;
  const name = typeof med?.name === "string" ? med.name.toLowerCase() : "";
  const formularyId = typeof med?.formularyId === "string" ? med.formularyId : "";
  return (
    name.includes(family) ||
    formularyId.startsWith(family) ||
    findByRxcui(med?.rxcui).some((e) => e.id.startsWith(family))
  );
}

/** Per SPEC section 2: trazodone <= 150 mg nightly. */
export const TRAZODONE_MAX_NIGHTLY_MG = 150;
/** Per SPEC section 2: six-month monitoring for mirtazapine. */
export const MIRTAZAPINE_SIX_MONTH_MARK = 6;

/** D01: trazodone must be <= 150 mg and taken nightly. Unknown dose/frequency escalates. */
export function ruleD01Trazodone(input: RuleInput): RuleEvaluation {
  if (!isDrug(input, "trazodone")) return pass("D01", "not trazodone, check not applicable");
  const { doseMg, frequency } = input.medication;
  if (typeof doseMg !== "number" || !Number.isFinite(doseMg) || doseMg <= 0) {
    return fail("D01", "ESCALATE", ["INVALID_INPUT"], "trazodone dose missing or invalid");
  }
  const nightly = typeof frequency === "string" && frequency.trim().toLowerCase() === "nightly";
  if (doseMg > TRAZODONE_MAX_NIGHTLY_MG || !nightly) {
    return fail(
      "D01",
      "ESCALATE",
      ["TRAZODONE_LIMIT_EXCEEDED"],
      `trazodone ${doseMg} mg, frequency ${String(frequency)}; allowed <= ${TRAZODONE_MAX_NIGHTLY_MG} mg nightly`,
    );
  }
  return pass("D01", `trazodone ${doseMg} mg nightly within limit`);
}

/**
 * D02: mirtazapine needs baseline metabolic/CV monitoring, plus six-month monitoring once six
 * months have passed since baseline. TODO: source needed for the recurrence interval after the
 * first six-month check and for which measures count as metabolic/CV monitoring.
 */
export function ruleD02Mirtazapine(input: RuleInput): RuleEvaluation {
  if (!isDrug(input, "mirtazapine")) return pass("D02", "not mirtazapine, check not applicable");
  const m = input.monitoring;
  const missing = (detail: string) =>
    fail("D02", "ESCALATE", ["MIRTAZAPINE_MONITORING_MISSING"], detail);
  if (!m) return missing("no monitoring data supplied");
  if (m.baselineRecorded !== true) return missing("baseline metabolic/CV monitoring not recorded");
  const months = m.monthsSinceBaseline;
  if (typeof months !== "number" || !Number.isInteger(months) || months < 0) {
    return fail("D02", "ESCALATE", ["INVALID_INPUT"], "months since baseline unknown or invalid");
  }
  if (months >= MIRTAZAPINE_SIX_MONTH_MARK && m.sixMonthRecorded !== true) {
    return missing(`${months} months since baseline and six-month monitoring not recorded`);
  }
  return pass("D02", `mirtazapine monitoring on file (${months} months since baseline)`);
}

/**
 * D03: both hydroxyzine forms always escalate. The public agreement sets quantity and age
 * restrictions but no numeric cutoffs. TODO: source needed before any auto-eligibility path exists.
 */
export function ruleD03Hydroxyzine(input: RuleInput): RuleEvaluation {
  return isDrug(input, "hydroxyzine")
    ? fail(
        "D03",
        "ESCALATE",
        ["HYDROXYZINE_ALWAYS_ESCALATE"],
        "hydroxyzine quantity/age limits not sourced (TODO: source needed); always escalate",
      )
    : pass("D03", "not hydroxyzine, check not applicable");
}
