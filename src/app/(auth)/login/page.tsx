import { ROLES } from "@/infra/auth/session";
import { switchRole, signOut } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-md px-6 py-12">
      <h1 className="text-2xl font-semibold">Role switcher (demo auth)</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Demo auth: choose a role to receive a signed session cookie. Not real authentication.
        Synthetic data only.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          Invalid role.
        </p>
      ) : null}
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
      <form action={signOut} className="mt-4">
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
