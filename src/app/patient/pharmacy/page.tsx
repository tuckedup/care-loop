import { selectPharmacy, toPharmacyConfirmation } from "@/domain/pharmacy";
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
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Choose your pharmacy</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Check the details before your renewal is sent. Synthetic pharmacies only.
      </p>

      {selection && !selection.ok ? (
        <p
          role="alert"
          data-testid="pharmacy-error"
          className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          {ERRORS[selection.error]}
        </p>
      ) : null}

      {chosen && confirmed === "1" && !renewalId ? (
        <section
          aria-labelledby="done-heading"
          data-testid="pharmacy-confirmed"
          className="mt-6 rounded border border-green-300 bg-green-50 p-4 text-green-900"
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
          className="mt-6 rounded border border-slate-300 p-4 dark:border-slate-700"
        >
          <h2 id="confirm-heading" className="font-medium">
            Confirm this pharmacy
          </h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-600 dark:text-slate-400">Name</dt>
            <dd data-testid="confirm-name">{chosen.name}</dd>
            <dt className="text-slate-600 dark:text-slate-400">Address</dt>
            <dd data-testid="confirm-address">{chosen.address}</dd>
            <dt className="text-slate-600 dark:text-slate-400">Phone</dt>
            <dd data-testid="confirm-phone">{chosen.phone}</dd>
          </dl>
          <form
            {...(renewalId ? { action: confirmRenewalPharmacyAction } : { method: "get" })}
            className="mt-4 flex flex-wrap gap-3"
          >
            {renewalId ? <input type="hidden" name="renewalId" value={renewalId} /> : null}
            <input type="hidden" name="pharmacyId" value={chosen.pharmacyId} />
            {renewalId ? null : <input type="hidden" name="confirmed" value="1" />}
            <button
              type="submit"
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
            >
              Confirm pharmacy
            </button>
            <a
              href={
                renewalId
                  ? `/patient/pharmacy?renewalId=${encodeURIComponent(renewalId)}`
                  : "/patient/pharmacy"
              }
              className="px-2 py-2 text-sm underline"
            >
              Choose a different pharmacy
            </a>
          </form>
        </section>
      ) : (
        <form method="get" className="mt-6">
          {renewalId ? <input type="hidden" name="renewalId" value={renewalId} /> : null}
          <fieldset>
            <legend className="font-medium">Pharmacies</legend>
            <ul className="mt-3 flex flex-col gap-2">
              {pharmacies.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-3 rounded border border-slate-300 p-3 dark:border-slate-700">
                    <input type="radio" name="pharmacyId" value={p.id} required />
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
          <button
            type="submit"
            className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
          >
            Review pharmacy
          </button>
        </form>
      )}
    </main>
  );
}
