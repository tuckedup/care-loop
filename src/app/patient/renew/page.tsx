import {
  formatFrequency,
  listPatientMedsForRenewal,
  syncProjections,
} from "../_lib/renewal-service";
import { requirePatient } from "../_lib/session";
import { startRenewalAction } from "./actions";

const ERRORS: Record<string, string> = {
  CONTROLLED_NOT_RENEWABLE:
    "Controlled medications cannot be renewed here. Please contact your clinician.",
  NOT_RENEWABLE: "That medication cannot be renewed here. Please contact your clinician.",
  NOT_FOUND: "We could not find that medication or renewal.",
  ALREADY_IN_PROGRESS:
    "A renewal for this medication is already in progress. See its progress under Renewal status.",
  INVALID_INPUT: "Please choose a medication.",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { patientId, sql } = await requirePatient();
  const { error } = await searchParams;
  await syncProjections(sql);
  const meds = await listPatientMedsForRenewal(sql, patientId);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Patient renewal</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Choose a current medication to renew. Synthetic data only.
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          {ERRORS[error] ?? "Something went wrong. Please try again."}
        </p>
      ) : null}

      {meds.length === 0 ? (
        <p className="mt-6" data-testid="no-meds">
          You have no active medications on file.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3" aria-label="Your active medications">
          {meds.map((m) => (
            <li
              key={m.prescriptionId}
              data-testid={`med-${m.prescriptionId}`}
              className="rounded border border-slate-300 p-4 dark:border-slate-700"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium">{m.drugName}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {m.doseMg} mg, {formatFrequency(m.frequency)}
                  </p>
                </div>
                {m.blocked === null ? (
                  <form action={startRenewalAction}>
                    <input type="hidden" name="prescriptionId" value={m.prescriptionId} />
                    <button
                      type="submit"
                      className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
                    >
                      Request renewal<span className="sr-only"> for {m.drugName}</span>
                    </button>
                  </form>
                ) : (
                  <p
                    data-testid={`not-renewable-${m.prescriptionId}`}
                    className="rounded bg-amber-100 px-3 py-2 text-sm text-amber-900"
                  >
                    {m.blocked === "controlled"
                      ? `Controlled medication${m.controlledSchedule ? ` (Schedule ${m.controlledSchedule})` : ""}: not renewable here. Please contact your clinician.`
                      : "Not renewable here. Please contact your clinician."}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
