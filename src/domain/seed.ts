// Deterministic synthetic seed plan. Pure: the same SEED always yields the same plan.
// ALL DATA IS SYNTHETIC. Persisting the plan (through command handlers) lives in
// scripts/db-seed-lib.ts.
import { DEMO_SUBJECTS } from "@/infra/auth/session";
import type { CheckInAnswers } from "./events";
import { getFormularyEntry, type ControlledSchedule } from "./formulary";
import { generatePharmacies, type Pharmacy } from "./pharmacy";

/** mulberry32: small, fast, fully deterministic 32-bit PRNG. Returns floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The demo-auth patient (session subject) with fixed identity so docs and e2e can use it. */
export const DEMO_PATIENT_ID = DEMO_SUBJECTS.patient;
export const DEMO_PATIENT_IDENTITY = {
  firstName: "Alex",
  lastName: "Demoson",
  dateOfBirth: "1988-03-14",
} as const;

export interface SeedStaff {
  id: string;
  role: "clinician" | "pharmacist" | "prescriber";
  name: string;
}
export const SEED_STAFF: readonly SeedStaff[] = [
  { id: DEMO_SUBJECTS.clinician, role: "clinician", name: "Dr. Sam Clinician (synthetic)" },
  { id: DEMO_SUBJECTS.pharmacist, role: "pharmacist", name: "Pat Pharmacist (synthetic)" },
  { id: "prescriber-001", role: "prescriber", name: "Dr. Jordan Prescriber (synthetic)" },
  { id: "prescriber-002", role: "prescriber", name: "Dr. Taylor Prescriber (synthetic)" },
  { id: "prescriber-003", role: "prescriber", name: "Dr. Morgan Prescriber (synthetic)" },
];
const PRESCRIBER_IDS = SEED_STAFF.filter((s) => s.role !== "pharmacist").map((s) => s.id);

export interface SeedMedication {
  prescriptionId: string;
  drugId: string; // formulary id
  rxcui: string;
  drugName: string;
  dose: { amountMg: number };
  frequency: { timesPerDay: number; timing: "morning" | "midday" | "evening" | "nightly" | "any" };
  sig: string;
  controlledSchedule: ControlledSchedule | null;
  prescriberId: string;
  metabolicMonitoring?: { baselineAt?: string; lastSixMonthAt?: string };
}

export interface SeedPriorRenewal {
  renewalId: string;
  prescriptionId: string;
  checkIn: CheckInAnswers;
}

export interface SeedPatient {
  /** Which E2E scenario this patient covers (or "filler"). */
  scenario: string;
  patientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  medications: SeedMedication[];
  /** Completed (request, verify, check-in) renewals that happened before now. */
  priorRenewals: SeedPriorRenewal[];
}

export interface SeedPlan {
  seed: number;
  patients: SeedPatient[];
  pharmacies: Pharmacy[];
  staff: readonly SeedStaff[];
}

const FIRST = [
  "Casey",
  "Riley",
  "Jamie",
  "Quinn",
  "Devon",
  "Rowan",
  "Skyler",
  "Emerson",
  "Harper",
  "Reese",
  "Blake",
  "Sage",
];
const LAST = [
  "Alder",
  "Brook",
  "Carver",
  "Dale",
  "Ember",
  "Frost",
  "Glen",
  "Hale",
  "Ives",
  "Knoll",
  "Lowe",
  "Marsh",
];

function med(
  prescriptionId: string,
  drugId: string,
  doseMg: number,
  frequency: SeedMedication["frequency"],
  sig: string,
  prescriberId: string,
  extra: Partial<SeedMedication> = {},
): SeedMedication {
  const entry = getFormularyEntry(drugId);
  if (!entry) throw new Error(`seed: unknown formulary id ${drugId}`);
  // Never invent an RxCUI: an unresolved cache entry stops the seed (TODO in the cache).
  if (!entry.rxcui) throw new Error(`seed: formulary entry ${drugId} has no RxCUI (TODO)`);
  return {
    prescriptionId,
    drugId,
    rxcui: entry.rxcui,
    drugName: entry.name,
    dose: { amountMg: doseMg },
    frequency,
    sig,
    controlledSchedule: entry.controlledSchedule,
    prescriberId,
    ...extra,
  };
}

const CALM: CheckInAnswers = {
  phq9: [0, 1, 0, 1, 0, 0, 1, 0, 0],
  gad7: [1, 0, 1, 0, 0, 1, 0],
  sideEffects: [],
  severeSideEffect: false,
  pregnancy: "no",
  maniaScreen: false,
  freeText: "",
  requestedHuman: false,
  requestedChange: "none",
};

const FILLER_DRUGS = [
  "fluoxetine",
  "sertraline",
  "escitalopram",
  "citalopram",
  "paroxetine",
  "duloxetine",
  "buspirone",
  "venlafaxine_er",
  "bupropion_xl",
] as const;

export function buildSeedPlan(seed: number): SeedPlan {
  const rng = createRng(seed);
  const int = (n: number) => Math.floor(rng() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const prescriber = () => pick(PRESCRIBER_IDS);
  const dob = () =>
    `${1950 + int(50)}-${String(1 + int(12)).padStart(2, "0")}-${String(1 + int(28)).padStart(2, "0")}`;
  const identity = () => ({ firstName: pick(FIRST), lastName: pick(LAST), dateOfBirth: dob() });
  const daily = { timesPerDay: 1, timing: "morning" } as const;
  const nightly = { timesPerDay: 1, timing: "nightly" } as const;
  const clinician = DEMO_SUBJECTS.clinician;

  const patients: SeedPatient[] = [];
  const add = (
    scenario: string,
    patientId: string,
    who: { firstName: string; lastName: string; dateOfBirth: string },
    medications: SeedMedication[],
    priorRenewals: SeedPriorRenewal[] = [],
  ) => patients.push({ scenario, patientId, ...who, medications, priorRenewals });

  // 1. Clean stable patient: the demo-auth patient. Two non-controlled maintenance meds.
  add("clean-stable", DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY, [
    med("rx-demo-sertraline", "sertraline", 100, daily, "Take 1 tablet by mouth daily", clinician),
    med("rx-demo-buspirone", "buspirone", 10, daily, "Take 1 tablet by mouth daily", clinician),
  ]);

  // 2. A prior PHQ-9 exists (total 6), so the "rise of 5" rule has a baseline.
  add(
    "prior-phq9",
    "patient-prior-phq9",
    identity(),
    [
      med(
        "rx-prior-phq9-escitalopram",
        "escitalopram",
        10,
        daily,
        "Take 1 tablet daily",
        prescriber(),
      ),
    ],
    [
      {
        renewalId: "renewal-prior-phq9-1",
        prescriptionId: "rx-prior-phq9-escitalopram",
        checkIn: { ...CALM, phq9: [1, 1, 1, 1, 1, 0, 1, 0, 0] },
      },
    ],
  );

  // 3. At the refill limit (default REFILL_LIMIT 2): two prior renewals, no visit since.
  add(
    "refill-limit",
    "patient-refill-limit",
    identity(),
    [
      med(
        "rx-refill-limit-fluoxetine",
        "fluoxetine",
        20,
        daily,
        "Take 1 capsule daily",
        prescriber(),
      ),
    ],
    [1, 2].map((n) => ({
      renewalId: `renewal-refill-limit-${n}`,
      prescriptionId: "rx-refill-limit-fluoxetine",
      checkIn: { ...CALM },
    })),
  );

  // 4. Drug-specific agreement conditions. Doses are plausible synthetic values, not thresholds.
  add("trazodone", "patient-trazodone", identity(), [
    med("rx-trazodone-1", "trazodone", 100, nightly, "Take 1 tablet at bedtime", prescriber()),
  ]);
  add("mirtazapine", "patient-mirtazapine", identity(), [
    med("rx-mirtazapine-1", "mirtazapine", 30, nightly, "Take 1 tablet at bedtime", prescriber(), {
      metabolicMonitoring: { baselineAt: "2026-01-15", lastSixMonthAt: "2026-07-20" },
    }),
  ]);
  add("hydroxyzine", "patient-hydroxyzine", identity(), [
    med(
      "rx-hydroxyzine-1",
      "hydroxyzine_hcl",
      25,
      { timesPerDay: 2, timing: "any" },
      "Take 1 tablet twice daily as needed",
      prescriber(),
    ),
  ]);

  // 5. Controlled medication: visibly not renewable, never on the AI path.
  add("controlled", "patient-controlled", identity(), [
    med(
      "rx-controlled-alprazolam",
      "alprazolam",
      0.5,
      { timesPerDay: 2, timing: "any" },
      "Take 1 tablet twice daily as needed",
      prescriber(),
    ),
  ]);

  // Filler patients: a random allowlisted drug each, so lists are not trivially tiny.
  for (let i = 1; i <= 8; i++) {
    const n = String(i).padStart(3, "0");
    const drug = pick(FILLER_DRUGS);
    add("filler", `patient-filler-${n}`, identity(), [
      med(
        `rx-filler-${n}`,
        drug,
        [10, 20, 25, 50, 75][int(5)]!,
        daily,
        "Take 1 daily",
        prescriber(),
      ),
    ]);
  }

  return { seed, patients, pharmacies: generatePharmacies(rng, 6), staff: SEED_STAFF };
}
