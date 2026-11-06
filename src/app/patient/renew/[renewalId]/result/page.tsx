import Link from "next/link";
import { resultStateFor, type ResultState } from "../../../_lib/renewal-service";
import { loadRenewalForStep } from "../../../_lib/session";

const COPY: Record<ResultState, { title: string; body: string; tone: string }> = {
  approved: {
    title: "Approved",
    body: "Your renewal was approved and is being sent to your pharmacy.",
    tone: "border-green-300 bg-green-50 text-green-900",
  },
  under_review: {
    title: "Under review",
    body: "Your check-in was received. Your care team will review your renewal. You do not need to do anything else right now.",
    tone: "border-slate-300 bg-slate-50 text-slate-900",
  },
  follow_up_needed: {
    title: "Follow-up needed",
    body: "Your care team needs to see you before this medication can be renewed. We will contact you about booking a visit.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
};

export default async function ResultPage({ params }: { params: Promise<{ renewalId: string }> }) {
  const { renewalId } = await params;
  const { renewal } = await loadRenewalForStep(renewalId, "result");
  // State comes from the rx_status projection (fed by the decision pipeline and clinician commands); unknown => under review.
  const state = resultStateFor(renewal.status);
  const copy = COPY[state];

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
        <p className="mt-1 text-sm">{copy.body}</p>
      </section>
      <Link href="/patient/status" className="mt-6 inline-block text-sm underline">
        View renewal status
      </Link>
    </main>
  );
}
