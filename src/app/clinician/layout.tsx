import Link from "next/link";
import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";

// Server-side RBAC for everything under /clinician. Pages and actions re-check on their own.
export default async function ClinicianLayout({ children }: { children: ReactNode }) {
  await requirePageRole("clinician", "admin");
  return (
    <div>
      <nav
        aria-label="Clinician"
        className="flex gap-4 border-b border-slate-200 px-6 py-3 text-sm dark:border-slate-800"
      >
        <Link href="/clinician/queue" className="underline">
          Renewal queue
        </Link>
        <Link href="/clinician/pharmacy-alerts" className="underline">
          Pharmacy alerts
        </Link>
        <Link href="/login" className="ml-auto underline">
          Switch role (demo auth)
        </Link>
      </nav>
      {children}
    </div>
  );
}
