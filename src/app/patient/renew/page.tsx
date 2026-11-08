import {
  Badge,
  Card,
  FlowSteps,
  Notice,
  PageHeader,
  PageShell,
  PillIcon,
  buttonClass,
} from "../../_components/ui";
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
    <PageShell>
      <FlowSteps current={1} />
      <PageHeader
        title="Patient renewal"
        lead="Choose a current medication to renew. Synthetic data only."
      />
      {error ? (
        <div className="mt-6">
          <Notice tone="danger" role="alert">
            {ERRORS[error] ?? "Something went wrong. Please try again."}
          </Notice>
        </div>
      ) : null}

      <section className="mt-8" aria-labelledby="meds-heading">
        <h2 id="meds-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Your active medications
        </h2>
        {meds.length === 0 ? (
          <Card className="mt-3">
            <p data-testid="no-meds">You have no active medications on file.</p>
          </Card>
        ) : (
          <ul className="mt-3 flex flex-col gap-3" aria-label="Your active medications">
            {meds.map((m) => (
              <li
                key={m.prescriptionId}
                data-testid={`med-${m.prescriptionId}`}
                className="rounded-card border border-line bg-surface p-5 shadow-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-800 dark:bg-sunken dark:text-brand-300">
                      <PillIcon className="h-6 w-6" />
                    </span>
                    <div>
                      <p className="text-lg font-semibold">{m.drugName}</p>
                      <p className="text-sm text-muted">
                        {m.doseMg} mg, {formatFrequency(m.frequency)}
                      </p>
                    </div>
                  </div>
                  {m.blocked === null ? (
                    <form action={startRenewalAction}>
                      <input type="hidden" name="prescriptionId" value={m.prescriptionId} />
                      <button type="submit" className={buttonClass("primary")}>
                        Request renewal<span className="sr-only"> for {m.drugName}</span>
                      </button>
                    </form>
                  ) : (
                    <div data-testid={`not-renewable-${m.prescriptionId}`} className="max-w-sm">
                      <Badge tone="warning">Not renewable here</Badge>
                      <p className="mt-2 text-sm text-muted">
                        {m.blocked === "controlled"
                          ? `Controlled medication${m.controlledSchedule ? ` (Schedule ${m.controlledSchedule})` : ""}: not renewable here. Please contact your clinician.`
                          : "Not renewable here. Please contact your clinician."}
                      </p>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 text-sm text-muted">
        Renewals are for stable, existing, non-controlled prescriptions only. Anything else is
        routed to a clinician.
      </p>
    </PageShell>
  );
}
