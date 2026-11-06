import { loadRenewalForStep } from "../../_lib/session";
import { verifyIdentityAction } from "./actions";

export default async function VerifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ renewalId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { renewalId } = await params;
  const { error } = await searchParams;
  const { renewal } = await loadRenewalForStep(renewalId, "verify");
  const action = verifyIdentityAction.bind(null, renewalId);

  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold">Verify your identity</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Renewing {renewal.drugName ?? "your medication"}. Enter your date of birth and last name
        exactly as they appear on file. Step 1 of 2.
      </p>
      {error ? (
        <p
          role="alert"
          data-testid="verify-error"
          className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          {error === "IDENTITY_MISMATCH"
            ? "We could not verify your identity with those details. Please check them and try again."
            : "Please enter your date of birth and last name."}
        </p>
      ) : null}
      <form action={action} className="mt-6 flex flex-col gap-4" noValidate={false}>
        <div className="flex flex-col gap-1">
          <label htmlFor="lastName" className="text-sm font-medium">
            Last name
          </label>
          <input
            id="lastName"
            name="lastName"
            type="text"
            required
            maxLength={100}
            autoComplete="off"
            className="rounded border border-slate-400 px-3 py-2 dark:bg-slate-900"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="dateOfBirth" className="text-sm font-medium">
            Date of birth
          </label>
          <input
            id="dateOfBirth"
            name="dateOfBirth"
            type="date"
            required
            autoComplete="off"
            className="rounded border border-slate-400 px-3 py-2 dark:bg-slate-900"
          />
        </div>
        <button
          type="submit"
          className="rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
        >
          Verify identity
        </button>
      </form>
    </main>
  );
}
