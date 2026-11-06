// Pure content + state shapes for the check-in form. No server imports, so client components
// can use it. Instrument wording below is the standard public PHQ-9 / GAD-7 item text.
// TODO: clinical review of all patient-facing wording (incl. the mania screen) before any real use.

export const SIDE_EFFECT_OPTIONS = [
  "Nausea",
  "Headache",
  "Drowsiness",
  "Trouble sleeping",
  "Dizziness",
  "Dry mouth",
  "Weight change",
  "Sexual side effects",
] as const;

export const RESPONSE_OPTIONS = [
  { value: 0, label: "Not at all" },
  { value: 1, label: "Several days" },
  { value: 2, label: "More than half the days" },
  { value: 3, label: "Nearly every day" },
] as const;

export const PHQ9_ITEMS = [
  "Little interest or pleasure in doing things",
  "Feeling down, depressed, or hopeless",
  "Trouble falling or staying asleep, or sleeping too much",
  "Feeling tired or having little energy",
  "Poor appetite or overeating",
  "Feeling bad about yourself, or that you are a failure or have let yourself or your family down",
  "Trouble concentrating on things, such as reading or watching television",
  "Moving or speaking so slowly that other people could have noticed, or the opposite: being so fidgety or restless that you have been moving around a lot more than usual",
  "Thoughts that you would be better off dead, or of hurting yourself in some way",
] as const;

export const GAD7_ITEMS = [
  "Feeling nervous, anxious, or on edge",
  "Not being able to stop or control worrying",
  "Worrying too much about different things",
  "Trouble relaxing",
  "Being so restless that it is hard to sit still",
  "Becoming easily annoyed or irritable",
  "Feeling afraid, as if something awful might happen",
] as const;

/** State carried between check-in submissions (useActionState). */
export interface CheckInFormState {
  attempt: number;
  fieldErrors: Record<string, string>;
  formError: string | null;
  /** The raw answers last submitted, so the form can be re-filled after validation errors. */
  values: {
    phq9: (number | null)[];
    gad7: (number | null)[];
    sideEffects: string[];
    severeSideEffect: boolean | null;
    pregnancy: string | null;
    maniaScreen: boolean | null;
    freeText: string;
    requestedHuman: boolean;
    requestedChange: string;
  } | null;
}

export const initialCheckInState: CheckInFormState = {
  attempt: 0,
  fieldErrors: {},
  formError: null,
  values: null,
};
