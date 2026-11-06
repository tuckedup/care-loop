import Link from "next/link";
import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";

// Server-side RBAC for everything under /patient: only the patient role gets through.
export default async function PatientLayout({ children }: { children: ReactNode }) {
  await requirePageRole("patient");
  return (
    <div>
      <nav
        aria-label="Patient"
        className="flex gap-4 border-b border-slate-200 px-6 py-3 text-sm dark:border-slate-800"
      >
        <Link href="/patient/renew" className="underline">
          Renew a medication
        </Link>
        <Link href="/patient/status" className="underline">
          Renewal status
        </Link>
        <Link href="/login" className="ml-auto underline">
          Switch role (demo auth)
        </Link>
      </nav>
      {children}
    </div>
  );
}
