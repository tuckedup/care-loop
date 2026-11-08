import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { registerAllProjections } from "@/infra/projections/all";
import { listPharmacyAlerts } from "@/infra/projections/pharmacy-alerts";
import { runAllProjections } from "@/infra/projections/registry";

export const dynamic = "force-dynamic";

const LABEL = {
  escalation: "Pharmacist escalation",
  error: "Pharmacy error (not retried)",
  cancel: "Cancel acknowledged",
} as const;

/** Read-only view for clinicians: what the pharmacy raised and whether a pharmacist handled it. */
export default async function Page() {
  await requirePageRole("clinician", "admin");
  const sql = getSql();
  await runAllProjections(sql, registerAllProjections());
  const alerts = await listPharmacyAlerts(sql);
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Pharmacy alerts</h1>
      <p className="mt-2 text-sm text-muted">
        Escalations and problems reported by the pharmacy. A pharmacist acknowledges them.
      </p>
      {alerts.length === 0 ? (
        <p data-testid="clinician-alerts-empty" className="mt-6">
          No pharmacy alerts.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3" aria-label="Pharmacy alerts">
          {alerts.map((a) => (
            <li
              key={a.messageId}
              data-testid={`clinician-alert-${a.messageId}`}
              data-status={a.status}
              data-kind={a.kind}
              className="rounded-xl border bg-surface border-line-strong p-4"
            >
              <p className="text-sm font-medium">
                {LABEL[a.kind]} ·{" "}
                {a.status === "open" ? "open" : `acknowledged by ${a.acknowledgedBy}`}
              </p>
              <p className="mt-1">{a.message}</p>
              <p className="mt-1 text-xs">
                Renewal{" "}
                <a className="underline" href={`/clinician/renewals/${a.renewalId}`}>
                  {a.renewalId}
                </a>
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
