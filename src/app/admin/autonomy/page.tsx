import Link from "next/link";
import { requirePageRole } from "@/infra/auth/guard";
import { AutonomySwitch } from "../_components/autonomy-switch";

export const dynamic = "force-dynamic";

export default async function AutonomyPage() {
  // Admin only, server side: other roles are redirected to /forbidden.
  await requirePageRole("admin");
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Autonomy</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Synthetic data. The setting is stored as an event and every change is audited.
      </p>
      <div className="mt-6">
        <AutonomySwitch />
      </div>
      <p className="mt-6 text-sm">
        <Link href="/admin/dashboard" className="underline">
          Dashboard
        </Link>
      </p>
    </main>
  );
}
