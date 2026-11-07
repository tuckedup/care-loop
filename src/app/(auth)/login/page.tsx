import { demoAuthEnabled } from "@/infra/auth/production-guards";
import { ROLES } from "@/infra/auth/session";
import { switchRole, signOut } from "./actions";

const ERRORS: Record<string, string> = {
  "invalid-role": "Invalid role.",
  disabled: "Demo auth is disabled on this deployment.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  "not-configured": "Session signing is not configured, so no session can be created.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const enabled = demoAuthEnabled();
  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold">Role switcher (demo auth)</h1>
      <p
        data-testid="demo-auth-label"
        className="mt-2 inline-block rounded bg-amber-100 px-2 py-1 text-xs font-medium uppercase tracking-wide text-amber-900"
      >
        Demo auth - not real authentication
      </p>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Demo auth: choose a role to receive a signed session cookie. Not real authentication.
        Synthetic data only.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {ERRORS[error] ?? "Something went wrong."}
        </p>
      ) : null}
      {enabled ? (
        <form action={switchRole} className="mt-6 flex flex-col gap-2" data-testid="role-switcher">
          {ROLES.map((role) => (
            <button
              key={role}
              type="submit"
              name="role"
              value={role}
              className="rounded border px-4 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              Continue as {role}
            </button>
          ))}
        </form>
      ) : (
        <p
          role="status"
          data-testid="demo-auth-disabled"
          className="mt-6 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Demo auth is disabled on this deployment. Set DEMO_AUTH_ENABLED=true to enable the role
          switcher (never for real use: it lets anyone pick a role).
        </p>
      )}
      <form action={signOut} className="mt-4">
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
