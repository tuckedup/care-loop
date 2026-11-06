import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { isEscalated } from "@/infra/projections/renewal-queue";
import type { MedRow } from "@/infra/projections/patient-med-list";
import { ReviewPanel } from "../../_components/review-panel";
import { Sparkline } from "../../_components/sparkline";
import { loadVisitData, type VisitData } from "../../_lib/data";
import { loadSummary } from "../../_lib/summary";
import { panelState } from "../../_lib/panel-state";
import { anchorId, describeEvent, isItem9Code, reasonLabel } from "../../_lib/view-model";

export const dynamic = "force-dynamic";

const FreqShape = z.object({ timesPerDay: z.number(), timing: z.string() });
const freqText = (raw: unknown) => {
  const f = FreqShape.safeParse(raw);
  return f.success
    ? `${f.data.timesPerDay}x daily${f.data.timing === "any" ? "" : ` (${f.data.timing})`}`
    : "";
};
const fmt = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

function Med({ m, requested }: { m: MedRow; requested: boolean }) {
  return (
    <li
      data-testid={`med-${m.prescriptionId}`}
      data-med-status={m.status}
      data-dose-changed={m.doseChanged ? "true" : "false"}
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1"
    >
      <span className="text-base font-semibold">{m.drugName}</span>
      <span>
        {m.doseMg} mg {freqText(m.frequency)}
      </span>
      {m.doseChanged ? (
        <span className="rounded border border-amber-700 bg-amber-50 px-2 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          DOSE CHANGED
        </span>
      ) : null}
      {requested ? (
        <span className="rounded border border-blue-700 px-2 text-xs font-semibold">
          Requested for renewal
        </span>
      ) : null}
      {m.status === "stopped" && m.stoppedAt ? (
        <span className="text-sm text-slate-600 dark:text-slate-400">
          stopped {m.stoppedAt.slice(0, 10)}
        </span>
      ) : null}
    </li>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

async function SummarySection({ data }: { data: VisitData }) {
  const result = await loadSummary(getSql(), data);
  if (result.status !== "ok") {
    // Fail closed: no summary text at all.
    return (
      <p data-testid="summary-unavailable" data-reason={result.reason} role="status">
        Summary unavailable
      </p>
    );
  }
  const labels = new Map<string, string>();
  for (const e of data.events) labels.set(e.id, e.type);
  for (const v of data.visits) labels.set(v.eventId, "VisitBooked");
  for (const n of data.notes) labels.set(n.sourceId, `Visit note ${n.noteId}`);
  return (
    <div data-testid="summary-ok">
      <ul className="mt-2 list-disc pl-5" data-testid="summary-lines">
        {result.lines.map((l, i) => (
          <li key={i} data-source-id={l.sourceId}>
            {l.text}{" "}
            <a
              href={`#${anchorId(l.sourceId)}`}
              className="text-sm underline"
              data-testid="citation"
            >
              [source: {labels.get(l.sourceId) ?? l.sourceId}]
            </a>
          </li>
        ))}
      </ul>
      {result.droppedLines > 0 ? (
        <p className="mt-2 text-sm" data-testid="summary-dropped">
          {result.droppedLines} line{result.droppedLines === 1 ? "" : "s"} removed: uncited, citing
          an unknown source, or recommendation / reassurance wording.
        </p>
      ) : null}
    </div>
  );
}

export default async function VisitPage({
  params,
  searchParams,
}: {
  params: Promise<{ renewalId: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requirePageRole("clinician", "admin");
  const { renewalId } = await params;
  const { notice } = await searchParams;
  if (!z.string().min(1).max(200).safeParse(renewalId).success) notFound();
  const data = await loadVisitData(getSql(), renewalId);
  if (!data) notFound();
  const { row } = data;

  const evalEvent = [...data.events].reverse().find((e) => e.event.type === "EligibilityEvaluated");
  const results =
    evalEvent && evalEvent.event.type === "EligibilityEvaluated"
      ? evalEvent.event.data.results
      : [];
  const outcome =
    evalEvent && evalEvent.event.type === "EligibilityEvaluated"
      ? evalEvent.event.data.outcome
      : null;
  const awaiting = outcome === null;
  const failedRuleIds = results.filter((r) => !r.passed).map((r) => r.ruleId);
  const escalated = isEscalated(row);
  const completed = row.status === "completed";
  const requestedRx = row.prescriptionId;
  const active = data.meds.filter((m) => m.status === "active");
  const stopped = data.meds.filter((m) => m.status === "stopped");
  const eventIds = new Set(data.events.map((e) => e.id));
  const signals = data.events.flatMap((e) =>
    e.event.type === "RiskSignalsExtracted" ? e.event.data.signals : [],
  );
  const latest = data.trend.at(-1);
  const panel = panelState(data, session.role, session.sub, awaiting, failedRuleIds, outcome);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <p className="text-sm">
        <Link href="/clinician/queue" className="underline">
          Back to queue
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">Visit view</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="visit-header">
        {data.patientName ? `${data.patientName} (synthetic) · ` : ""}patient{" "}
        {row.patientId ?? "unknown"} · renewal {row.renewalId} · status{" "}
        <span data-testid="visit-status">{row.status}</span>
      </p>

      {notice ? (
        <p
          role="alert"
          className="mt-3 rounded border border-amber-700 p-2 text-sm"
          data-testid="notice"
        >
          Could not start the review ({notice}). See the actions panel.
        </p>
      ) : null}

      {escalated ? (
        <div
          data-testid="escalation-banner"
          data-open={completed ? "false" : "true"}
          className="mt-4 rounded border-2 border-red-700 bg-red-50 p-3 text-red-950 dark:bg-red-950 dark:text-red-50"
        >
          <p className="font-semibold">
            {completed
              ? "Escalated renewal: decided by a clinician."
              : "ESCALATED: this renewal stays OPEN until a clinician approves, denies or books a visit."}
          </p>
          <ul
            aria-label="Escalation reasons"
            data-testid="reason-codes"
            className="mt-2 flex flex-wrap gap-2"
          >
            {row.reasonCodes.map((c) => (
              <li
                key={c}
                data-reason-code={c}
                className={`rounded border px-2 py-0.5 text-sm ${isItem9Code(c) ? "border-red-900 bg-red-700 font-bold text-white" : "border-red-700"}`}
              >
                <span className="font-mono">{c}</span>: {reasonLabel(c)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {awaiting ? (
        <p
          data-testid="awaiting-banner"
          className="mt-4 rounded border-2 border-amber-700 bg-amber-50 p-3 font-semibold text-amber-950 dark:bg-amber-950 dark:text-amber-50"
        >
          Awaiting evaluation: this renewal is open and has not been evaluated yet.
        </p>
      ) : null}
      {row.anomalies.length > 0 ? (
        <ul
          aria-label="Data anomalies"
          data-testid="anomalies"
          className="mt-3 flex flex-wrap gap-2"
        >
          {row.anomalies.map((a) => (
            <li key={a} className="rounded border border-amber-700 px-2 text-sm">
              Anomaly: <span className="font-mono">{a}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <Section id="meds-heading" title="Medications">
        <div className="grid gap-4 sm:grid-cols-2">
          <div data-testid="meds-active" className="rounded border border-green-700 p-3">
            <h3 className="font-semibold">Active ({active.length})</h3>
            {active.length === 0 ? (
              <p className="text-sm">None.</p>
            ) : (
              <ul>
                {active.map((m) => (
                  <Med key={m.prescriptionId} m={m} requested={m.prescriptionId === requestedRx} />
                ))}
              </ul>
            )}
          </div>
          <div
            data-testid="meds-stopped"
            className="rounded border border-slate-500 p-3 text-slate-700 dark:text-slate-300"
          >
            <h3 className="font-semibold">Stopped ({stopped.length})</h3>
            {stopped.length === 0 ? (
              <p className="text-sm">None.</p>
            ) : (
              <ul>
                {stopped.map((m) => (
                  <Med key={m.prescriptionId} m={m} requested={m.prescriptionId === requestedRx} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      <Section id="trend-heading" title="PHQ-9 and GAD-7 trend">
        {data.trend.length === 0 ? (
          <p className="text-sm">No check-ins recorded.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <Sparkline
              id="phq9"
              label="PHQ-9"
              max={27}
              points={data.trend.map((t) => ({ date: t.recordedAt, value: t.phq9Total }))}
            />
            <Sparkline
              id="gad7"
              label="GAD-7"
              max={21}
              points={data.trend.map((t) => ({ date: t.recordedAt, value: t.gad7Total }))}
            />
            {latest && latest.item9 !== null && latest.item9 >= 1 ? (
              <p className="font-semibold text-red-800 dark:text-red-300" data-testid="item9-note">
                Latest PHQ-9 item 9 = {latest.item9}
              </p>
            ) : null}
            <details>
              <summary className="cursor-pointer text-sm">Show values as a table</summary>
              <table className="mt-2 text-sm">
                <caption className="sr-only">PHQ-9 and GAD-7 totals per check-in</caption>
                <thead>
                  <tr>
                    <th scope="col" className="pr-4 text-left">
                      Recorded
                    </th>
                    <th scope="col" className="pr-4 text-left">
                      PHQ-9
                    </th>
                    <th scope="col" className="pr-4 text-left">
                      Item 9
                    </th>
                    <th scope="col" className="text-left">
                      GAD-7
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.trend.map((t) => (
                    <tr key={`${t.renewalId}-${t.position}`}>
                      <td className="pr-4">{fmt(t.recordedAt)}</td>
                      <td className="pr-4">{t.phq9Total ?? "n/a"}</td>
                      <td className="pr-4">{t.item9 ?? "n/a"}</td>
                      <td>{t.gad7Total ?? "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </Section>

      <Section id="rules-heading" title="Rule results">
        {results.length === 0 ? (
          <p className="text-sm" data-testid="no-rules">
            No rule results yet (not evaluated).
          </p>
        ) : (
          <>
            <p className="text-sm">
              Outcome: <strong data-testid="rule-outcome">{outcome}</strong>
            </p>
            <ul data-testid="rule-results" className="mt-2 flex flex-col gap-1">
              {results.map((r, i) => (
                <li
                  key={`${r.ruleId}-${i}`}
                  data-rule-id={r.ruleId}
                  data-passed={r.passed ? "true" : "false"}
                  className="text-sm"
                >
                  <span className="font-mono font-semibold">{r.ruleId}</span>{" "}
                  <span
                    className={
                      r.passed ? "font-semibold" : "font-bold text-red-800 dark:text-red-300"
                    }
                  >
                    {r.passed ? "PASS" : "FAIL"}
                  </span>
                  : {r.detail}
                </li>
              ))}
            </ul>
          </>
        )}
        {signals.length > 0 ? (
          <div className="mt-3" data-testid="risk-signals">
            <h3 className="font-semibold">Risk signals in patient text</h3>
            <ul className="list-disc pl-5 text-sm">
              {signals.map((s, i) => (
                <li key={i}>
                  <span className="font-mono">{s.type}</span> in {s.sourceField}: &ldquo;{s.quote}
                  &rdquo;
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="summary-heading" title="Summary">
        <p className="text-sm font-medium" data-testid="summary-label">
          AI-generated summary, not a recommendation; escalation reason codes above are
          authoritative
        </p>
        <Suspense fallback={<p role="status">Generating summary...</p>}>
          <SummarySection data={data} />
        </Suspense>
      </Section>

      <div className="mt-8">
        <ReviewPanel {...panel} />
      </div>

      <Section id="history-heading" title="Visit history">
        {data.visits.length === 0 ? (
          <p className="text-sm">No prior visits.</p>
        ) : (
          <ul className="text-sm">
            {data.visits.map((v) => (
              <li
                key={v.visitId}
                id={eventIds.has(v.eventId) ? undefined : anchorId(v.eventId)}
                data-testid="visit-history-item"
              >
                Visit {v.visitId}: {fmt(v.start)} to {fmt(v.end)}
                {data.notes
                  .filter((n) => n.visitId === v.visitId)
                  .map((n) => (
                    <span key={n.noteId} id={anchorId(n.sourceId)} data-testid="visit-note">
                      {" "}
                      · note {n.noteId} signed by {n.clinicianId}
                    </span>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="sources-heading" title="Source events">
        <ol className="text-sm" data-testid="source-events">
          {data.events.map((e) => (
            <li
              key={e.id}
              id={anchorId(e.id)}
              data-event-id={e.id}
              className="py-1 target:bg-yellow-100 target:text-slate-900"
            >
              <span className="font-mono">{e.id}</span> <strong>{e.type}</strong>{" "}
              <time dateTime={e.at}>{fmt(e.at)}</time>: {describeEvent(e.event)}
            </li>
          ))}
        </ol>
      </Section>
    </main>
  );
}
