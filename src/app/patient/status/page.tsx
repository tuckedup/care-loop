import Link from "next/link";
import { listOwnedRenewals, nextStepFor } from "../_lib/renewal-service";
import { requirePatient, stepPath } from "../_lib/session";
import { statusLabel } from "../_lib/status-copy";

export default async function StatusPage() {
  const { patientId, sql } = await requirePatient();
  const renewals = await listOwnedRenewals(sql, patientId);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Renewal status</h1>
      {renewals.length === 0 ? (
        <p className="mt-6" data-testid="no-renewals">
          You have no renewals yet.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3" aria-label="Your renewals">
          {renewals.map((r) => (
            <li
              key={r.renewalId}
              data-testid={`renewal-${r.renewalId}`}
              data-status={r.status}
              className="rounded border border-slate-300 p-4 dark:border-slate-700"
            >
              <p className="font-medium">{r.drugName ?? r.prescriptionId}</p>
              <p className="text-sm" data-testid="renewal-status">
                {statusLabel(r.status, r.pharmacyStatus)}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Last update{" "}
                <time dateTime={r.updatedAt}>
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "UTC",
                  }).format(new Date(r.updatedAt))}{" "}
                  UTC
                </time>
              </p>
              {nextStepFor(r.status) !== "result" ? (
                <Link
                  href={stepPath(r.renewalId, nextStepFor(r.status))}
                  className="mt-2 inline-block text-sm underline"
                >
                  Continue this renewal
                </Link>
              ) : (
                <Link
                  href={`/patient/renew/${r.renewalId}/result`}
                  className="mt-2 inline-block text-sm underline"
                >
                  View result
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
