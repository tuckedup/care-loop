import Link from "next/link";
import {
  AlertIcon,
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  FlowSteps,
  PageHeader,
  PageShell,
  buttonClass,
  cx,
} from "../../../../_components/ui";
import { RESULT_COPY, resultStateFor } from "../../../_lib/status-copy";
import { loadRenewalForStep } from "../../../_lib/session";

// Visual treatment per result state. Meaning is always carried by the title and copy as well.
function toneFor(state: string): { box: string; icon: React.ReactNode; ring: string } {
  if (state === "approved" || state === "filled")
    return {
      box: "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
      icon: <CheckIcon className="h-6 w-6" />,
      ring: "bg-emerald-600 text-white",
    };
  if (state === "under_review" || state === "approved_waiting" || state === "replaced")
    return {
      box: "border-line-strong bg-surface text-ink",
      icon: <ClockIcon className="h-6 w-6" />,
      ring: "bg-sunken text-brand-800 dark:text-brand-300",
    };
  return {
    box: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
    icon: <AlertIcon className="h-6 w-6" />,
    ring: "bg-amber-500 text-white",
  };
}

export default async function ResultPage({ params }: { params: Promise<{ renewalId: string }> }) {
  const { renewalId } = await params;
  const { renewal } = await loadRenewalForStep(renewalId, "result");
  // State comes from the rx_status projection (fed by the decision pipeline and clinician commands); unknown => under review.
  const state = resultStateFor(renewal.status, renewal.pharmacyStatus);
  const copy = RESULT_COPY[state];
  const t = toneFor(state);

  return (
    <PageShell width="max-w-2xl">
      <FlowSteps current={4} />
      <PageHeader title="Renewal result" lead={renewal.drugName ?? "Your medication"} />
      <section
        aria-labelledby="result-heading"
        data-testid="renewal-result"
        data-result-state={state}
        className={cx("mt-8 rounded-card border p-6 shadow-card sm:p-7", t.box)}
      >
        <div className="flex items-start gap-4">
          <span className={cx("grid h-12 w-12 shrink-0 place-items-center rounded-full", t.ring)}>
            {t.icon}
          </span>
          <div className="min-w-0">
            <h2 id="result-heading" className="font-display text-2xl font-semibold">
              {copy.title}
            </h2>
            <p className="mt-2 leading-7">
              {renewal.status === "follow_up_required"
                ? "This synthetic demo routes the renewal for clinician follow-up before it can proceed. Booking creates a demo visit only; it does not renew your medication."
                : copy.body}
            </p>
            {renewal.status === "follow_up_required" ? (
              <Link
                href={`/patient/follow-up/${encodeURIComponent(renewalId)}`}
                data-testid="book-follow-up-link"
                className={buttonClass("primary", "mt-4")}
              >
                Book a follow-up visit
                <ArrowRightIcon />
              </Link>
            ) : null}
          </div>
        </div>
      </section>
      <div className="mt-6">
        <Link href="/patient/status" className={buttonClass("secondary")}>
          View renewal status
        </Link>
      </div>
    </PageShell>
  );
}
