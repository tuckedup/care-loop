import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { registerAllProjections } from "@/infra/projections/all";
import { listPharmacyAlerts, type PharmacyAlert } from "@/infra/projections/pharmacy-alerts";
import { runAllProjections } from "@/infra/projections/registry";
import { acknowledgeAlertAction } from "./actions";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<PharmacyAlert["kind"], string> = {
  escalation: "Pharmacist escalation",
  error: "Pharmacy error (not retried)",
  cancel: "Cancel acknowledged",
};

/** Pharmacist and admin only (the layout and this page both enforce it server side). */
export default async function Page() {
  await requirePageRole("pharmacist", "admin");
  const sql = getSql();
  await runAllProjections(sql, registerAllProjections());
  const alerts = await listPharmacyAlerts(sql);
  const open = alerts.filter((a) => a.status === "open");
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Pharmacist inbox</h1>
      <p className="mt-2 text-sm text-muted">
        Messages from the (simulated) pharmacy that need a person. Synthetic data only.
      </p>
      {alerts.length === 0 ? (
        <p data-testid="inbox-empty" className="mt-6">
          Nothing needs attention.
        </p>
      ) : (
        <>
          <p data-testid="inbox-open-count" className="mt-4 text-sm">
            {open.length} open
          </p>
          <ul className="mt-4 flex flex-col gap-3" aria-label="Pharmacy alerts">
            {alerts.map((a) => (
              <li
                key={a.messageId}
                data-testid={`alert-${a.messageId}`}
                data-status={a.status}
                data-kind={a.kind}
                className="rounded-xl border bg-surface border-line-strong p-4"
              >
                <p className="text-sm font-medium">{KIND_LABEL[a.kind]}</p>
                <p className="mt-1">{a.message}</p>
                <p className="mt-1 text-xs text-muted">
                  Renewal {a.renewalId}
                  {a.code ? ` · ${a.code}` : ""} · received{" "}
                  <time dateTime={a.raisedAt}>{a.raisedAt.replace("T", " ").slice(0, 16)} UTC</time>
                </p>
                {a.status === "open" ? (
                  <form action={acknowledgeAlertAction} className="mt-3">
                    <input type="hidden" name="renewalId" value={a.renewalId} />
                    <input type="hidden" name="messageId" value={a.messageId} />
                    <button
                      type="submit"
                      className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-800 disabled:opacity-60"
                    >
                      Acknowledge
                    </button>
                  </form>
                ) : (
                  <p data-testid="acknowledged" className="mt-3 text-sm">
                    Acknowledged by {a.acknowledgedBy}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
