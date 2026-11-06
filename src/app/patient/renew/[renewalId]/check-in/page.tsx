import { loadRenewalForStep } from "../../../_lib/session";
import { submitCheckInAction } from "../actions";
import { CheckInForm } from "./check-in-form";

export default async function CheckInPage({ params }: { params: Promise<{ renewalId: string }> }) {
  const { renewalId } = await params;
  const { renewal } = await loadRenewalForStep(renewalId, "check-in");
  const action = submitCheckInAction.bind(null, renewalId);

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Check-in</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Renewing {renewal.drugName ?? "your medication"}. Step 2 of 2. Answer every question; it
        takes a few minutes.
      </p>
      <CheckInForm action={action} />
    </main>
  );
}
