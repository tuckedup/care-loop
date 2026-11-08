import { signingNow } from "@/domain/visit/clock";
import { getSession } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import {
  listCalendarSlots,
  listFollowUpTasks,
  listVisits,
} from "@/infra/projections/visit-schedule";
import { signVisitNoteAction } from "../_actions/visit-actions";
import { syncProjections } from "../_lib/data";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  VISIT_NOT_STARTED: "A note can only be signed once the visit has started.",
  NOTE_ID_CONFLICT: "That note id is already used by another visit.",
  TASK_CONFLICT: "A conflicting follow-up task already exists.",
  NOT_VISIT_CLINICIAN: "Only the clinician this visit was booked with can sign its note.",
  VISIT_ALREADY_SIGNED: "This visit already has a signed note.",
  VISIT_NOT_FOUND: "That visit was not found.",
  FORBIDDEN: "Only a clinician can sign a visit note.",
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " UTC";

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await getSession(); // the layout already enforced clinician/admin
  const sql = getSql();
  await syncProjections(sql);
  const [visits, slots, tasks] = await Promise.all([
    listVisits(sql),
    listCalendarSlots(sql),
    listFollowUpTasks(sql),
  ]);
  const canSign = session?.role === "clinician";
  const now = signingNow(new Date());

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Follow-up visits</h1>
      <p className="mt-1 text-sm text-muted">
        Synthetic demo data. Signing a note creates a follow-up task and a calendar slot; the note
        text itself is not stored in this demo.
      </p>
      {error ? (
        <p role="alert" data-testid="visit-error" className="mt-4 text-sm text-red-700">
          {ERRORS[error] ?? "That action could not be completed."}
        </p>
      ) : null}

      <section aria-labelledby="visits-h" className="mt-6">
        <h2 id="visits-h" className="text-lg font-semibold">
          Visits
        </h2>
        <ul className="mt-2 space-y-3" data-testid="visit-list">
          {visits.length === 0 ? <li className="text-sm">No visits.</li> : null}
          {visits.map((v) => (
            <li
              key={v.visitId}
              data-testid={`visit-${v.visitId}`}
              data-status={v.status}
              className="rounded-xl border bg-surface border-line-strong p-4"
            >
              <div className="text-sm font-medium">
                {fmt(v.start)} to {fmt(v.end)}
              </div>
              <div className="text-sm text-muted">
                patient {v.patientId}
                {v.renewalId ? ` · renewal ${v.renewalId}` : ""} · clinician{" "}
                {v.clinicianId ?? "unassigned"}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <span className="rounded-xl border bg-surface border-line-strong px-2 py-0.5 text-xs font-medium">
                  {v.status === "note_signed" ? "Note signed" : "Booked"}
                </span>
                {v.status === "booked" && canSign && v.clinicianId === session?.sub ? (
                  Date.parse(v.start) <= now.getTime() ? (
                    <form action={signVisitNoteAction}>
                      <input type="hidden" name="visitId" value={v.visitId} />
                      <button
                        type="submit"
                        className="rounded-xl border bg-surface border-line-strong px-3 py-1.5 text-sm font-medium"
                      >
                        Sign visit note
                      </button>
                    </form>
                  ) : (
                    <span data-testid={`sign-locked-${v.visitId}`} className="text-sm">
                      <button
                        type="button"
                        disabled
                        aria-describedby={`sign-help-${v.visitId}`}
                        className="rounded-xl border bg-surface border-line-strong px-3 py-1.5 text-sm font-medium opacity-50"
                      >
                        Sign visit note
                      </button>
                      <span id={`sign-help-${v.visitId}`} className="ml-2">
                        Available once the visit has started ({fmt(v.start)}).
                      </span>
                    </span>
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="tasks-h" className="mt-8">
        <h2 id="tasks-h" className="text-lg font-semibold">
          Follow-up tasks
        </h2>
        <ul className="mt-2 space-y-2" data-testid="task-list">
          {tasks.length === 0 ? <li className="text-sm">No tasks.</li> : null}
          {tasks.map((t) => (
            <li
              key={t.taskId}
              data-testid={`task-${t.taskId}`}
              data-status={t.status}
              className="rounded-xl border bg-surface border-line-strong p-3 text-sm"
            >
              <span className="font-medium">Follow-up visit</span> for patient {t.patientId}
              {t.visitId ? ` (visit ${t.visitId})` : ""} · status {t.status}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="slots-h" className="mt-8">
        <h2 id="slots-h" className="text-lg font-semibold">
          Calendar slots
        </h2>
        <ul className="mt-2 space-y-2" data-testid="slot-list">
          {slots.length === 0 ? <li className="text-sm">No calendar slots.</li> : null}
          {slots.map((s) => (
            <li
              key={s.slotId}
              data-testid={`slot-${s.slotId}`}
              className="rounded-xl border bg-surface border-line-strong p-3 text-sm"
            >
              {fmt(s.start)} to {fmt(s.end)} · visit {s.visitId}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
