import Link from "next/link";
import { RESULT_COPY, resultStateFor } from "../../../_lib/status-copy";
import { loadRenewalForStep } from "../../../_lib/session";

export default async function ResultPage({ params }: { params: Promise<{ renewalId: string }> }) {
  const { renewalId } = await params;
  const { renewal } = await loadRenewalForStep(renewalId, "result");
  // State comes from the rx_status projection (fed by the decision pipeline and clinician commands); unknown => under review.
  const state = resultStateFor(renewal.status, renewal.pharmacyStatus);
  const copy = RESULT_COPY[state];

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Renewal result</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        {renewal.drugName ?? "Your medication"}
      </p>
      <section
        aria-labelledby="result-heading"
        data-testid="renewal-result"
        data-result-state={state}
        className={`mt-6 rounded border p-5 ${copy.tone}`}
      >
        <h2 id="result-heading" className="text-lg font-semibold">
          {copy.title}
        </h2>
        <p className="mt-1 text-sm">
          {renewal.status === "follow_up_required"
            ? "This synthetic demo routes the renewal for clinician follow-up before it can proceed. Booking creates a demo visit only; it does not renew your medication."
            : copy.body}
        </p>
        {renewal.status === "follow_up_required" ? (
          <Link
            href={`/patient/follow-up/${encodeURIComponent(renewalId)}`}
            data-testid="book-follow-up-link"
            className="mt-3 inline-block text-sm font-medium underline"
          >
            Book a follow-up visit
          </Link>
        ) : null}
      </section>
      <Link href="/patient/status" className="mt-6 inline-block text-sm underline">
        View renewal status
      </Link>
    </main>
  );
}
