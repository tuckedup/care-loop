import Link from "next/link";
import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { registerAllProjections } from "@/infra/projections/all";
import {
  countNonConcurrenceAlerts,
  getDashboardMetrics,
} from "@/infra/projections/renewal-metrics";
import { runAllProjections } from "@/infra/projections/registry";
import { AutonomySwitch } from "../_components/autonomy-switch";
import { formatDuration, formatPercent } from "./format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Admin only, server side: other roles are redirected to /forbidden.
  await requirePageRole("admin");
  const sql = getSql();
  await runAllProjections(sql, registerAllProjections());
  const [m, alerts] = await Promise.all([getDashboardMetrics(sql), countNonConcurrenceAlerts(sql)]);
  const c = m.concurrence;
  const t = m.timeToDecision;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Admin dashboard</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Projection-backed metrics over synthetic renewals. Nothing here is a clinical performance
        claim.
      </p>
      <nav aria-label="Admin sections" className="mt-2 flex gap-4 text-sm">
        <Link href="/admin/evals" className="underline">
          Eval results
        </Link>
        <Link href="/clinician/retro-review" className="underline">
          Retrospective review
        </Link>
        <Link href="/admin/audit" className="underline">
          Audit log
        </Link>
      </nav>

      {alerts > 0 && (
        <p
          role="alert"
          data-testid="non-concurrence-alert"
          className="mt-4 rounded border-2 border-red-700 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {alerts} auto-approval{alerts === 1 ? "" : "s"} had a clinician non-concurrence. Consider
          switching to Shadow mode.
        </p>
      )}

      <div className="mt-6">
        <AutonomySwitch />
      </div>

      <section aria-labelledby="concurrence-heading" className="mt-8">
        <h2 id="concurrence-heading" className="text-lg font-semibold">
          Retrospective concurrence
        </h2>
        {c.rate === null ? (
          <p data-testid="concurrence-empty" className="mt-2 text-sm">
            No retrospective reviews recorded yet, so there is no concurrence rate to show.
          </p>
        ) : (
          <p className="mt-2 text-sm">
            <span
              data-testid="metric-concurrence"
              data-rate={c.rate}
              className="text-2xl font-semibold"
            >
              {formatPercent(c.rate)}
            </span>{" "}
            concurrence in this demo ({c.concur} of {c.reviewed} reviewed auto-approvals;{" "}
            {c.nonConcur} did not concur).
          </p>
        )}
        <p
          data-testid="concurrence-target"
          className="mt-1 text-sm text-slate-600 dark:text-slate-400"
        >
          TARGET: {formatPercent(c.target)} or higher concurrence, taken from public reporting. It
          is a goal for this design, not a result this demo has achieved.
        </p>
      </section>

      <section aria-labelledby="volume-heading" className="mt-8">
        <h2 id="volume-heading" className="text-lg font-semibold">
          Volume
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt>Renewals requested</dt>
            <dd data-testid="metric-requested" className="text-xl font-semibold">
              {m.requested}
            </dd>
          </div>
          <div>
            <dt>Decided</dt>
            <dd data-testid="metric-decided" className="text-xl font-semibold">
              {m.decided}
            </dd>
          </div>
          <div>
            <dt>Auto-approved</dt>
            <dd data-testid="metric-auto-approved" className="text-xl font-semibold">
              {m.autoApproved}
            </dd>
          </div>
          <div>
            <dt>Awaiting retro review</dt>
            <dd data-testid="metric-awaiting-review" className="text-xl font-semibold">
              {m.awaitingReview}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="mix-heading" className="mt-8">
        <h2 id="mix-heading" className="text-lg font-semibold">
          Escalation mix by reason code
        </h2>
        {m.escalationMix.length === 0 ? (
          <p data-testid="mix-empty" className="mt-2 text-sm">
            No escalated renewals yet.
          </p>
        ) : (
          <table data-testid="escalation-mix" className="mt-2 text-left text-sm">
            <thead>
              <tr>
                <th className="pr-6">Reason code</th>
                <th>Renewals</th>
              </tr>
            </thead>
            <tbody>
              {m.escalationMix.map((r) => (
                <tr key={r.code} data-testid={`mix-${r.code}`} data-count={r.count}>
                  <td className="pr-6">{r.code}</td>
                  <td>{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          A renewal with several reasons is counted once per reason ({m.escalated} escalated
          renewals).
        </p>
      </section>

      <section aria-labelledby="ttd-heading" className="mt-8">
        <h2 id="ttd-heading" className="text-lg font-semibold">
          Time to decision
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          From renewal request to approval, denial or follow-up requirement.
        </p>
        {t.count === 0 ? (
          <p data-testid="ttd-empty" className="mt-2 text-sm">
            No decided renewals yet.
          </p>
        ) : (
          <>
            <dl className="mt-2 grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt>Median</dt>
                <dd data-testid="ttd-median" className="text-xl font-semibold">
                  {formatDuration(t.medianSeconds)}
                </dd>
              </div>
              <div>
                <dt>Mean</dt>
                <dd data-testid="ttd-mean" className="text-xl font-semibold">
                  {formatDuration(t.meanSeconds)}
                </dd>
              </div>
              <div>
                <dt>90th percentile</dt>
                <dd data-testid="ttd-p90" className="text-xl font-semibold">
                  {formatDuration(t.p90Seconds)}
                </dd>
              </div>
            </dl>
            <table className="mt-3 text-left text-sm">
              <thead>
                <tr>
                  <th className="pr-6">Decision</th>
                  <th className="pr-6">Renewals</th>
                  <th>Median</th>
                </tr>
              </thead>
              <tbody>
                {t.byDecision.map((d) => (
                  <tr key={d.decision} data-testid={`ttd-${d.decision}`} data-count={d.count}>
                    <td className="pr-6">{d.decision}</td>
                    <td className="pr-6">{d.count}</td>
                    <td>{formatDuration(d.medianSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}
