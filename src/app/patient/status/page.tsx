import Link from "next/link";
import { listOwnedRenewals, nextStepFor } from "../_lib/renewal-service";
import { requirePatient, stepPath } from "../_lib/session";

// Patient-friendly wording for every rx_status value. Unknown values fall back to "Under review".
const LABELS: Record<string, string> = {
  requested: "Started: identity not yet verified",
  identity_verified: "Identity verified: check-in needed",
  checked_in: "Under review",
  evaluated: "Under review",
  escalated: "Under review by your care team",
  in_review: "Being reviewed by your care team",
  approved: "Approved",
  denied: "Follow-up needed",
  queued: "Approved: sending to pharmacy",
  transmitted: "Sent to pharmacy",
  pharmacy_status: "Pharmacy is processing",
  pharmacy_error: "Pharmacy problem: your care team is working on it",
  filled: "Filled",
  follow_up_required: "Follow-up visit needed",
};

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
                {LABELS[r.status] ?? "Under review"}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Last update{" "}
                <time dateTime={r.updatedAt}>{r.updatedAt.replace("T", " ").slice(0, 16)} UTC</time>
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
