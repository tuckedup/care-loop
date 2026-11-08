import { selectPharmacy, toPharmacyConfirmation } from "@/domain/pharmacy";
import {
  FlowSteps,
  Notice,
  PageHeader,
  PageShell,
  StoreIcon,
  buttonClass,
} from "../../_components/ui";
import { listPharmacies } from "../_lib/pharmacy-service";
import { loadRenewalForStep, requirePatient } from "../_lib/session";
import { confirmRenewalPharmacyAction } from "./actions";

const ERRORS: Record<string, string> = {
  INVALID_ID: "Please choose a pharmacy from the list.",
  NOT_FOUND: "We could not find that pharmacy. Please choose one from the list.",
};

/**
 * Confirm-before-send step: choose a (fake, synthetic) pharmacy, then see its name, address and
 * phone and confirm. With `?renewalId=` (the renewal flow, after identity verification and before
 * the check-in) confirming records PharmacySelected on that renewal; without it the page is a
 * read-only preview and nothing is recorded.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ pharmacyId?: string; confirmed?: string; renewalId?: string }>;
}) {
  const { pharmacyId, confirmed, renewalId } = await searchParams;
  // In the renewal flow: must be the patient's own renewal, verified and not yet checked in.
  const sql = renewalId
    ? (await loadRenewalForStep(renewalId, "check-in")).sql
    : (await requirePatient()).sql;
  const pharmacies = await listPharmacies(sql);
  const selection = pharmacyId === undefined ? null : selectPharmacy(pharmacies, pharmacyId);
  const chosen = selection?.ok ? toPharmacyConfirmation(selection.pharmacy) : null;

  return (
    <PageShell width="max-w-2xl">
      {renewalId ? <FlowSteps current={3} /> : null}
      <PageHeader
        title="Choose your pharmacy"
        lead="Check the details before your renewal is sent. Synthetic pharmacies only."
      />

      {selection && !selection.ok ? (
        <div className="mt-6">
          <Notice tone="danger" role="alert" data-testid="pharmacy-error">
            {ERRORS[selection.error]}
          </Notice>
        </div>
      ) : null}

      {chosen && confirmed === "1" && !renewalId ? (
        <section
          aria-labelledby="done-heading"
          data-testid="pharmacy-confirmed"
          className="mt-8 rounded-card border border-emerald-300 bg-emerald-50 p-5 text-emerald-950 shadow-card"
        >
          <h2 id="done-heading" className="font-medium">
            Pharmacy confirmed
          </h2>
          <p className="mt-1 text-sm">{chosen.summary}</p>
        </section>
      ) : chosen ? (
        <section
          aria-labelledby="confirm-heading"
          data-testid="pharmacy-confirm"
          className="mt-8 rounded-card border border-line bg-surface p-5 shadow-card sm:p-6"
        >
          <h2 id="confirm-heading" className="flex items-center gap-2 text-lg font-semibold">
            <StoreIcon className="h-5 w-5 text-brand-700" />
            Confirm this pharmacy
          </h2>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Name</dt>
            <dd data-testid="confirm-name">{chosen.name}</dd>
            <dt className="text-muted">Address</dt>
            <dd data-testid="confirm-address">{chosen.address}</dd>
            <dt className="text-muted">Phone</dt>
            <dd data-testid="confirm-phone">{chosen.phone}</dd>
          </dl>
          <form
            {...(renewalId ? { action: confirmRenewalPharmacyAction } : { method: "get" })}
            className="mt-6 flex flex-wrap items-center gap-3"
          >
            {renewalId ? <input type="hidden" name="renewalId" value={renewalId} /> : null}
            <input type="hidden" name="pharmacyId" value={chosen.pharmacyId} />
            {renewalId ? null : <input type="hidden" name="confirmed" value="1" />}
            <button type="submit" className={buttonClass("primary")}>
              Confirm pharmacy
            </button>
            <a
              href={
                renewalId
                  ? `/patient/pharmacy?renewalId=${encodeURIComponent(renewalId)}`
                  : "/patient/pharmacy"
              }
              className={buttonClass("ghost")}
            >
              Choose a different pharmacy
            </a>
          </form>
        </section>
      ) : (
        <form method="get" className="mt-6">
          {renewalId ? <input type="hidden" name="renewalId" value={renewalId} /> : null}
          <fieldset className="mt-8">
            <legend className="text-sm font-semibold uppercase tracking-wide text-muted">
              Pharmacies
            </legend>
            <ul className="mt-3 flex flex-col gap-2">
              {pharmacies.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-line-strong bg-surface p-3 hover:border-brand-600 has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50 dark:has-[:checked]:bg-sunken">
                    <input
                      type="radio"
                      className="h-4 w-4 accent-brand-700"
                      name="pharmacyId"
                      value={p.id}
                      required
                    />
                    <span>{p.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {pharmacies.length === 0 ? (
            <p data-testid="no-pharmacies" className="mt-3 text-sm">
              No pharmacies are available.
            </p>
          ) : null}
          <button type="submit" className={buttonClass("primary", "mt-6")}>
            Review pharmacy
          </button>
        </form>
      )}
    </PageShell>
  );
}
