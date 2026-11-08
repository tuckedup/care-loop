import { redirect } from "next/navigation";
import { FlowSteps, PageHeader, PageShell } from "../../../../_components/ui";
import { renewalHasPharmacy } from "../../../_lib/pharmacy-service";
import { loadRenewalForStep } from "../../../_lib/session";
import { submitCheckInAction } from "../actions";
import { CheckInForm } from "./check-in-form";

export default async function CheckInPage({ params }: { params: Promise<{ renewalId: string }> }) {
  const { renewalId } = await params;
  const { renewal, sql } = await loadRenewalForStep(renewalId, "check-in");
  // The pharmacy is confirmed (and recorded) before the check-in.
  if (!(await renewalHasPharmacy(sql, renewalId))) {
    redirect(`/patient/pharmacy?renewalId=${encodeURIComponent(renewalId)}`);
  }
  const action = submitCheckInAction.bind(null, renewalId);

  return (
    <PageShell width="max-w-2xl">
      <FlowSteps current={3} />
      <PageHeader
        title="Check-in"
        lead={
          <>
            Renewing {renewal.drugName ?? "your medication"}. Answer every question; it takes a few
            minutes.
          </>
        }
      />
      <CheckInForm action={action} />
    </PageShell>
  );
}
