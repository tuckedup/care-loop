import {
  Card,
  Field,
  FlowSteps,
  LockIcon,
  Notice,
  PageHeader,
  PageShell,
  buttonClass,
  inputClass,
} from "../../../_components/ui";
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
    <PageShell width="max-w-2xl">
      <FlowSteps current={2} />
      <PageHeader
        title="Verify your identity"
        lead={
          <>
            Renewing {renewal.drugName ?? "your medication"}. Enter your date of birth and last name
            exactly as they appear on file.
          </>
        }
      />
      {error ? (
        <div className="mt-6">
          <Notice tone="danger" role="alert" data-testid="verify-error">
            {error === "IDENTITY_MISMATCH"
              ? "We could not verify your identity with those details. Please check them and try again."
              : "Please enter your date of birth and last name."}
          </Notice>
        </div>
      ) : null}
      <Card className="mt-8">
        <form action={action} className="flex flex-col gap-5" noValidate={false}>
          <Field id="lastName" label="Last name">
            <input
              id="lastName"
              name="lastName"
              type="text"
              required
              maxLength={100}
              autoComplete="off"
              className={inputClass}
            />
          </Field>
          <Field id="dateOfBirth" label="Date of birth">
            <input
              id="dateOfBirth"
              name="dateOfBirth"
              type="date"
              required
              autoComplete="off"
              className={inputClass}
            />
          </Field>
          <button
            type="submit"
            className={buttonClass("primary", "w-full sm:w-auto sm:self-start")}
          >
            Verify identity
          </button>
        </form>
      </Card>
      <p className="mt-4 flex items-start gap-2 text-sm text-muted">
        <LockIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Used only to match the synthetic record on file. Failed attempts are not stored in this
          demo.
        </span>
      </p>
    </PageShell>
  );
}
