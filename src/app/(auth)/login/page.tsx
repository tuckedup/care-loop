import { demoAuthEnabled } from "@/infra/auth/production-guards";
import { ROLES } from "@/infra/auth/session";
import {
  Badge,
  Card,
  ChartIcon,
  Notice,
  PageHeader,
  PageShell,
  PillIcon,
  StethoscopeIcon,
  StoreIcon,
  buttonClass,
} from "../../_components/ui";
import { signOut } from "./actions";

const ERRORS: Record<string, string> = {
  "invalid-role": "Invalid role.",
  "invalid-origin": "The request could not be verified. Reload the page and try again.",
  disabled: "Demo auth is disabled on this deployment.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  "not-configured": "Session signing is not configured, so no session can be created.",
};

const ROLE_INFO: Record<
  (typeof ROLES)[number],
  { blurb: string; sees: string; icon: React.ReactNode }
> = {
  patient: {
    blurb: "Request a renewal and follow it to the pharmacy.",
    sees: "Medication list, identity check, check-in, result and status.",
    icon: <PillIcon className="h-6 w-6" />,
  },
  clinician: {
    blurb: "Review escalations and decide.",
    sees: "Review queue, visit view with cited summary, retro review.",
    icon: <StethoscopeIcon className="h-6 w-6" />,
  },
  pharmacist: {
    blurb: "Handle messages coming back from the pharmacy.",
    sees: "Pharmacist inbox and acknowledgements.",
    icon: <StoreIcon className="h-6 w-6" />,
  },
  admin: {
    blurb: "Oversee autonomy, audit and evaluation results.",
    sees: "Audit chain, autonomy mode, dashboard, eval results.",
    icon: <ChartIcon className="h-6 w-6" />,
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const enabled = demoAuthEnabled();
  return (
    <PageShell width="max-w-5xl">
      <PageHeader
        eyebrow="Demo"
        title="Choose how you want to explore"
        lead="Pick a role to receive a signed demo session. Every role sees a different part of the same synthetic renewal loop."
      />
      <div className="mt-4">
        <Badge tone="warning">
          <span data-testid="demo-auth-label">Demo auth - not real authentication</span>
        </Badge>
        <p className="mt-2 text-sm text-muted">
          Demo auth: choose a role to receive a signed session cookie. Not real authentication.
          Synthetic data only.
        </p>
      </div>
      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-muted">
        Role switcher (demo auth)
      </h2>
      {error ? (
        <div className="mt-6">
          <Notice tone="danger" role="alert">
            {ERRORS[error] ?? "Something went wrong."}
          </Notice>
        </div>
      ) : null}
      {enabled ? (
        <form
          action="/api/demo-auth/switch"
          method="post"
          className="mt-8 grid gap-4 sm:grid-cols-2"
          data-testid="role-switcher"
        >
          {ROLES.map((role) => (
            <Card key={role} as="div" className="flex flex-col gap-4">
              <div className="flex items-start gap-4">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-800 dark:bg-sunken dark:text-brand-300">
                  {ROLE_INFO[role].icon}
                </span>
                <div>
                  <p className="text-lg font-semibold capitalize">{role}</p>
                  <p className="mt-0.5 text-sm text-muted">{ROLE_INFO[role].blurb}</p>
                </div>
              </div>
              <p className="text-sm text-muted">
                <span className="font-semibold text-ink">You will see: </span>
                {ROLE_INFO[role].sees}
              </p>
              <button
                type="submit"
                name="role"
                value={role}
                className={buttonClass(role === "patient" ? "primary" : "secondary", "mt-auto")}
              >
                Continue as {role}
              </button>
            </Card>
          ))}
        </form>
      ) : (
        <div className="mt-8">
          <Notice tone="warning" role="status" data-testid="demo-auth-disabled">
            Demo auth is disabled on this deployment. Set DEMO_AUTH_ENABLED=true to enable the role
            switcher (never for real use: it lets anyone pick a role).
          </Notice>
        </div>
      )}
      <form action={signOut} className="mt-8">
        <button type="submit" className={buttonClass("ghost")}>
          Sign out
        </button>
      </form>
    </PageShell>
  );
}
