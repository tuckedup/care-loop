import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { registerAllProjections } from "@/infra/projections/all";
import { countNonConcurrenceAlerts, listRetroReviews } from "@/infra/projections/renewal-metrics";
import { runAllProjections } from "@/infra/projections/registry";
import { retroReviewFormAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function RetroReviewPage() {
  // Clinicians review; an admin may look (read-only); everyone else is redirected.
  const session = await requirePageRole("clinician", "admin");
  const canReview = session.role === "clinician";
  const sql = getSql();
  await runAllProjections(sql, registerAllProjections());
  const [items, alerts] = await Promise.all([
    listRetroReviews(sql),
    countNonConcurrenceAlerts(sql),
  ]);
  const pending = items.filter((i) => !i.reviewed);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Retrospective review</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Renewals the system approved automatically (rules said AUTO_ELIGIBLE, every check clean) and
        queued for a clinician to review afterwards. Synthetic data.
      </p>

      {alerts > 0 && (
        <p
          role="alert"
          data-testid="non-concurrence-alert"
          className="mt-4 rounded border-2 border-red-700 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {alerts} auto-approval{alerts === 1 ? "" : "s"} had a clinician non-concurrence. Review
          the autonomy mode.
        </p>
      )}
      {!canReview && (
        <p data-testid="read-only-note" className="mt-4 text-sm">
          Read-only view: only a clinician can record a review.
        </p>
      )}

      <p className="mt-4 text-sm" data-testid="retro-pending-count" data-count={pending.length}>
        {pending.length} awaiting review, {items.length - pending.length} reviewed.
      </p>

      {items.length === 0 ? (
        <p data-testid="retro-empty" className="mt-6 text-sm">
          Nothing is queued for retrospective review. Auto-approvals appear here when the autonomy
          mode is Retrospective or Sampled.
        </p>
      ) : (
        <ul aria-label="Retrospective review queue" className="mt-4 space-y-3">
          {items.map((i) => (
            <li
              key={i.renewalId}
              data-testid={`retro-item-${i.renewalId}`}
              data-reviewed={i.reviewed}
              data-concur={i.concur === null ? "" : String(i.concur)}
              className="rounded border border-slate-300 p-3 text-sm dark:border-slate-700"
            >
              <p>
                <span className="font-medium">{i.drugName ?? "Medication"}</span>{" "}
                <span className="text-slate-600 dark:text-slate-400">
                  renewal {i.renewalId}, auto-approved{" "}
                  {i.autoApprovedAt ? i.autoApprovedAt.slice(0, 16).replace("T", " ") : "?"} UTC
                  {i.autonomyMode ? ` (${i.autonomyMode})` : ""}, reason {i.sampleReason ?? "n/a"}
                </span>
              </p>
              {i.reviewed ? (
                <p data-testid="retro-outcome" className="mt-2">
                  {i.concur ? "Concurred" : "Did NOT concur (alert raised)"} by {i.reviewerId}
                </p>
              ) : canReview ? (
                <form action={retroReviewFormAction} className="mt-2 flex gap-2">
                  <input type="hidden" name="renewalId" value={i.renewalId} />
                  <button
                    type="submit"
                    name="concur"
                    value="yes"
                    className="rounded border border-slate-400 px-3 py-1"
                  >
                    Concur
                  </button>
                  <button
                    type="submit"
                    name="concur"
                    value="no"
                    className="rounded border border-red-700 px-3 py-1"
                  >
                    Do not concur
                  </button>
                </form>
              ) : (
                <p className="mt-2">Awaiting clinician review.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
