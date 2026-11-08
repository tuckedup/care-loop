import Link from "next/link";
import {
  Badge,
  Card,
  ClockIcon,
  PageHeader,
  PageShell,
  PillIcon,
  buttonClass,
} from "../../_components/ui";
import { listOwnedRenewals, nextStepFor } from "../_lib/renewal-service";
import { requirePatient, stepPath } from "../_lib/session";
import { statusLabel } from "../_lib/status-copy";

function toneFor(status: string): "success" | "warning" | "info" | "neutral" {
  if (
    status === "filled" ||
    status === "approved" ||
    status === "queued" ||
    status === "transmitted"
  )
    return "success";
  if (
    status === "denied" ||
    status === "follow_up_required" ||
    status === "pharmacy_error" ||
    status === "cancelled"
  )
    return "warning";
  if (status === "escalated" || status === "evaluated" || status === "in_review") return "info";
  return "neutral";
}

export default async function StatusPage() {
  const { patientId, sql } = await requirePatient();
  const renewals = await listOwnedRenewals(sql, patientId);

  return (
    <PageShell>
      <PageHeader
        title="Renewal status"
        lead="Every request you have made in this demo, and where it stands."
      />
      {renewals.length === 0 ? (
        <Card className="mt-8">
          <p data-testid="no-renewals">You have no renewals yet.</p>
          <Link href="/patient/renew" className={buttonClass("primary", "mt-4")}>
            Start a renewal
          </Link>
        </Card>
      ) : (
        <ul className="mt-8 flex flex-col gap-3" aria-label="Your renewals">
          {renewals.map((r) => (
            <li
              key={r.renewalId}
              data-testid={`renewal-${r.renewalId}`}
              data-status={r.status}
              className="rounded-card border border-line bg-surface p-5 shadow-card"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-800 dark:bg-sunken dark:text-brand-300">
                    <PillIcon />
                  </span>
                  <div>
                    <p className="text-lg font-semibold">{r.drugName ?? r.prescriptionId}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted">
                      <ClockIcon className="h-3.5 w-3.5" />
                      <span>
                        Last update{" "}
                        <time dateTime={r.updatedAt}>
                          {new Intl.DateTimeFormat("en-US", {
                            dateStyle: "medium",
                            timeStyle: "short",
                            timeZone: "UTC",
                          }).format(new Date(r.updatedAt))}{" "}
                          UTC
                        </time>
                      </span>
                    </p>
                  </div>
                </div>
                <Badge tone={toneFor(r.status)}>
                  <span data-testid="renewal-status">
                    {statusLabel(r.status, r.pharmacyStatus)}
                  </span>
                </Badge>
              </div>
              <div className="mt-4">
                {nextStepFor(r.status) !== "result" ? (
                  <Link
                    href={stepPath(r.renewalId, nextStepFor(r.status))}
                    className={buttonClass("secondary")}
                  >
                    Continue this renewal
                  </Link>
                ) : (
                  <Link
                    href={`/patient/renew/${r.renewalId}/result`}
                    className={buttonClass("secondary")}
                  >
                    View result
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
