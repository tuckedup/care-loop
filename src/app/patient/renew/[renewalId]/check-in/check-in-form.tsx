"use client";
// Accessible PHQ-9 / GAD-7 check-in. Native fieldset/legend + radio groups, errors tied to
// fields with aria-describedby and aria-invalid, and an error summary that takes focus.
// Validation is authoritative on the server (Zod); nothing here is trusted.
import { useActionState, useEffect, useRef } from "react";
import {
  GAD7_ITEMS,
  initialCheckInState,
  PHQ9_ITEMS,
  RESPONSE_OPTIONS,
  SIDE_EFFECT_OPTIONS,
  type CheckInFormState,
} from "../../../_lib/check-in-content";

type Action = (prev: CheckInFormState, formData: FormData) => Promise<CheckInFormState>;

function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="mt-1 text-sm text-red-800 dark:text-red-300">
      <span className="sr-only">Error: </span>
      {message}
    </p>
  );
}

function ScaleQuestion({
  name,
  index,
  text,
  checked,
  error,
}: {
  name: "phq9" | "gad7";
  index: number;
  text: string;
  checked: number | null | undefined;
  error?: string | undefined;
}) {
  const id = `${name}_${index}`;
  return (
    <fieldset
      id={id}
      aria-describedby={error ? `${id}-error` : undefined}
      className="border-t border-slate-200 py-3 dark:border-slate-800"
    >
      <legend className="text-sm font-medium">
        {index + 1}. {text}
      </legend>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {RESPONSE_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={id}
              value={o.value}
              defaultChecked={checked === o.value}
              data-testid={`${id}-${o.value}`}
            />
            {o.label}
          </label>
        ))}
      </div>
      <FieldError id={id} message={error} />
    </fieldset>
  );
}

function YesNo({
  name,
  legend,
  help,
  checked,
  error,
  options = [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
}: {
  name: string;
  legend: string;
  help?: string;
  checked: string | null | undefined;
  error?: string | undefined;
  options?: { value: string; label: string }[];
}) {
  return (
    <fieldset
      id={name}
      aria-describedby={error ? `${name}-error` : undefined}
      className="border-t border-slate-200 py-3 dark:border-slate-800"
    >
      <legend className="text-sm font-medium">{legend}</legend>
      {help ? <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{help}</p> : null}
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={checked === o.value}
              data-testid={`${name}-${o.value}`}
            />
            {o.label}
          </label>
        ))}
      </div>
      <FieldError id={name} message={error} />
    </fieldset>
  );
}

const yn = (v: boolean | null | undefined) => (v === true ? "yes" : v === false ? "no" : null);

export function CheckInForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, initialCheckInState);
  const summaryRef = useRef<HTMLDivElement>(null);
  const v = state.values;
  const errs = state.fieldErrors;
  const errorKeys = Object.keys(errs);

  useEffect(() => {
    if (state.attempt > 0) summaryRef.current?.focus();
  }, [state.attempt]);

  const knownSideEffects = new Set<string>(SIDE_EFFECT_OPTIONS);
  const otherSideEffect = v?.sideEffects.find((s) => !knownSideEffects.has(s)) ?? "";

  return (
    // Remount after a failed submit so defaults (the re-filled answers) apply.
    <form action={formAction} key={state.attempt} className="mt-6" data-testid="checkin-form">
      <div
        ref={summaryRef}
        tabIndex={-1}
        role="alert"
        data-testid="checkin-errors"
        className={
          errorKeys.length > 0 || state.formError
            ? "mb-6 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900"
            : "sr-only"
        }
      >
        {state.formError ? <p>{state.formError}</p> : null}
        {errorKeys.length > 0 ? (
          <>
            <p className="font-medium">
              Please fix {errorKeys.length} {errorKeys.length === 1 ? "answer" : "answers"} below.
            </p>
            <ul className="mt-1 list-disc pl-5">
              {errorKeys.map((k) => (
                <li key={k}>
                  <a href={`#${k}`} className="underline">
                    {labelFor(k)}
                  </a>
                  : {errs[k]}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <p className="mb-4 rounded bg-slate-100 p-3 text-sm dark:bg-slate-900">
        If you are thinking about harming yourself or are in crisis, call or text 988 (US) or your
        local emergency number now. Do not wait for this form.
      </p>

      <h2 className="text-lg font-semibold">Over the last 2 weeks (PHQ-9)</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        How often have you been bothered by the following problems?
      </p>
      {PHQ9_ITEMS.map((text, i) => (
        <ScaleQuestion
          key={i}
          name="phq9"
          index={i}
          text={text}
          checked={v?.phq9[i]}
          error={errs[`phq9_${i}`]}
        />
      ))}

      <h2 className="mt-8 text-lg font-semibold">Over the last 2 weeks (GAD-7)</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        How often have you been bothered by the following problems?
      </p>
      {GAD7_ITEMS.map((text, i) => (
        <ScaleQuestion
          key={i}
          name="gad7"
          index={i}
          text={text}
          checked={v?.gad7[i]}
          error={errs[`gad7_${i}`]}
        />
      ))}

      <h2 className="mt-8 text-lg font-semibold">About your medication</h2>
      <fieldset id="sideEffects" className="border-t border-slate-200 py-3 dark:border-slate-800">
        <legend className="text-sm font-medium">
          Any side effects since your last renewal? (select all that apply)
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {SIDE_EFFECT_OPTIONS.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="sideEffects"
                value={o}
                defaultChecked={v?.sideEffects.includes(o) ?? false}
              />
              {o}
            </label>
          ))}
        </div>
        <label htmlFor="sideEffectOther" className="mt-3 block text-sm">
          Other side effect (optional)
        </label>
        <input
          id="sideEffectOther"
          name="sideEffectOther"
          type="text"
          maxLength={200}
          defaultValue={otherSideEffect}
          className="mt-1 w-full rounded border border-slate-400 px-3 py-2 dark:bg-slate-900"
        />
        <FieldError id="sideEffects" message={errs.sideEffects} />
      </fieldset>

      <YesNo
        name="severeSideEffect"
        legend="Have you had a severe or frightening side effect?"
        checked={yn(v?.severeSideEffect)}
        error={errs.severeSideEffect}
      />
      <YesNo
        name="pregnancy"
        legend="Are you pregnant, or could you be pregnant?"
        checked={v?.pregnancy}
        error={errs.pregnancy}
        options={[
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
          { value: "unsure", label: "Not sure" },
        ]}
      />
      <YesNo
        name="maniaScreen"
        legend="In the past few weeks, have you had a period of unusually high energy, much less need for sleep, or racing thoughts?"
        help="Synthetic demo wording; not for patient care."
        checked={yn(v?.maniaScreen)}
        error={errs.maniaScreen}
      />

      <div className="border-t border-slate-200 py-3 dark:border-slate-800">
        <label htmlFor="requestedChange" className="block text-sm font-medium">
          Do you want to change anything about this medication?
        </label>
        <select
          id="requestedChange"
          name="requestedChange"
          defaultValue={v?.requestedChange ?? "none"}
          aria-describedby={errs.requestedChange ? "requestedChange-error" : undefined}
          className="mt-1 rounded border border-slate-400 px-3 py-2 dark:bg-slate-900"
        >
          <option value="none">No change, renew as is</option>
          <option value="dose">Change the dose</option>
          <option value="frequency">Change how often I take it</option>
          <option value="drug">Switch to a different medication</option>
          <option value="other">Something else</option>
        </select>
        <FieldError id="requestedChange" message={errs.requestedChange} />
      </div>

      <div className="border-t border-slate-200 py-3 dark:border-slate-800">
        <label htmlFor="freeText" className="block text-sm font-medium">
          Anything else you want your care team to know? (optional)
        </label>
        <textarea
          id="freeText"
          name="freeText"
          rows={4}
          maxLength={2000}
          defaultValue={v?.freeText ?? ""}
          aria-describedby={errs.freeText ? "freeText-error" : undefined}
          className="mt-1 w-full rounded border border-slate-400 px-3 py-2 dark:bg-slate-900"
        />
        <FieldError id="freeText" message={errs.freeText} />
      </div>

      <div className="border-t border-slate-200 py-3 dark:border-slate-800">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="requestedHuman"
            defaultChecked={v?.requestedHuman ?? false}
          />
          I would like to speak with a person on my care team.
        </label>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-4 rounded bg-slate-900 px-5 py-2 text-white hover:bg-slate-700 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900"
      >
        {pending ? "Submitting..." : "Submit check-in"}
      </button>
    </form>
  );
}

function labelFor(key: string): string {
  const m = /^(phq9|gad7)_(\d+)$/.exec(key);
  if (m) return `${m[1] === "phq9" ? "PHQ-9" : "GAD-7"} question ${Number(m[2]) + 1}`;
  const names: Record<string, string> = {
    severeSideEffect: "Severe side effect",
    pregnancy: "Pregnancy",
    maniaScreen: "Energy and sleep question",
    sideEffects: "Side effects",
    freeText: "Additional information",
    requestedChange: "Requested change",
  };
  return names[key] ?? "Form";
}
