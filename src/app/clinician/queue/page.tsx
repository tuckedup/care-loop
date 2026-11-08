import Link from "next/link";
import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { isEscalated, type QueueStatus } from "@/infra/projections/renewal-queue";
import { openRenewalAction } from "../_actions/queue-actions";
import { loadQueueItems, type QueueItem } from "../_lib/data";
import { isItem9Code, reasonLabel } from "../_lib/view-model";

export const dynamic = "force-dynamic";

const SECTIONS: { status: QueueStatus; title: string; help: string }[] = [
  {
    status: "requested",
    title: "Requested",
    help: "Open: waiting for a clinician to start review.",
  },
  { status: "in-progress", title: "In progress", help: "A clinician has started review." },
  { status: "completed", title: "Completed", help: "A decision or follow-up has been recorded." },
];

function Badge({
  children,
  tone,
  testId,
}: {
  children: ReactNode;
  tone: "red" | "amber" | "slate";
  testId?: string;
}) {
  const cls = {
    red: "border-red-700 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
    amber: "border-amber-700 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
    slate: "border-line-strong bg-slate-50 text-slate-900 dark:text-slate-100",
  }[tone];
  return (
    <span
      data-testid={testId}
      className={`inline-block rounded-xl border bg-surface px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

function Item({ item, canStart }: { item: QueueItem; canStart: boolean }) {
  const { row } = item;
  const escalated = isEscalated(row);
  const open = row.status !== "completed";
  const anomalies = row.anomalies.filter((a) => a !== "NOT_IN_QUEUE_PROJECTION");
  return (
    <li
      data-testid={`queue-item-${row.renewalId}`}
      data-status={row.status}
      data-escalated={escalated ? "true" : "false"}
      data-awaiting-evaluation={item.awaitingEvaluation ? "true" : "false"}
      className={`rounded border p-4 ${escalated && open ? "border-2 border-red-700" : "border-line-strong"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {item.drugName ?? row.prescriptionId ?? "Unknown medication"}
        </span>
        <span className="text-sm text-muted">
          patient {row.patientId ?? "unknown"} · renewal {row.renewalId}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge tone="slate" testId="status-badge">
          {row.status}
        </Badge>
        {escalated ? (
          <Badge tone="red" testId="escalated-badge">
            {open ? "ESCALATED: open until a clinician acts" : "Escalated (decided by clinician)"}
          </Badge>
        ) : null}
        {item.awaitingEvaluation ? (
          <Badge tone="amber" testId="awaiting-badge">
            Awaiting evaluation
            {item.checkInSubmitted ? "" : " (patient check-in pending)"}
          </Badge>
        ) : null}
        {row.riskSignalCount > 0 ? (
          <Badge tone="red">
            {row.riskSignalCount} risk signal{row.riskSignalCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {row.decision ? <Badge tone="slate">{row.decision.replaceAll("_", " ")}</Badge> : null}
      </div>
      {row.reasonCodes.length > 0 ? (
        <ul
          aria-label="Escalation reasons"
          data-testid="reason-codes"
          className="mt-2 flex flex-wrap gap-2"
        >
          {row.reasonCodes.map((c) => (
            <li key={c} data-reason-code={c}>
              <Badge tone={isItem9Code(c) ? "red" : "amber"}>
                <span className="font-mono">{c}</span>: {reasonLabel(c)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {anomalies.length > 0 ? (
        <ul
          aria-label="Data anomalies"
          data-testid="anomalies"
          className="mt-2 flex flex-wrap gap-2"
        >
          {anomalies.map((a) => (
            <li key={a}>
              <Badge tone="amber">
                Anomaly: <span className="font-mono">{a}</span>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-4">
        {canStart && open && !item.awaitingEvaluation && row.clinicianId === null ? (
          <form action={openRenewalAction}>
            <input type="hidden" name="renewalId" value={row.renewalId} />
            <button
              type="submit"
              className="rounded-xl border bg-surface border-line-strong px-3 py-1.5 text-sm font-medium focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
            >
              Open and start review
            </button>
          </form>
        ) : null}
        <Link
          href={`/clinician/renewals/${encodeURIComponent(row.renewalId)}`}
          className="text-sm underline"
        >
          Open visit view
        </Link>
      </div>
    </li>
  );
}

export default async function QueuePage() {
  const session = await requirePageRole("clinician", "admin");
  const items = await loadQueueItems(getSql());
  const canStart = session.role === "clinician";
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Clinician queue</h1>
      <p className="mt-1 text-sm text-muted">
        Escalated renewals are listed first and stay open until a clinician approves, denies or
        books a visit. Renewals that have not been evaluated yet are shown too.
      </p>
      {!canStart ? (
        <p className="mt-2 text-sm" data-testid="read-only-note">
          Signed in as admin: read-only. Only clinicians can start a review or decide.
        </p>
      ) : null}
      {SECTIONS.map((s) => {
        const list = items.filter((i) => i.row.status === s.status);
        return (
          <section key={s.status} aria-labelledby={`h-${s.status}`} className="mt-8">
            <h2 id={`h-${s.status}`} className="text-lg font-semibold">
              {s.title} <span className="text-sm font-normal">({list.length})</span>
            </h2>
            <p className="text-sm text-muted">{s.help}</p>
            {list.length === 0 ? (
              <p className="mt-2 text-sm" data-testid={`empty-${s.status}`}>
                None.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-3" aria-label={`${s.title} renewals`}>
                {list.map((i) => (
                  <Item key={i.row.renewalId} item={i} canStart={canStart} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}
