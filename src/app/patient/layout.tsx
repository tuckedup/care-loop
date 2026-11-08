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
      <aside
        aria-label="Demo support and urgent help"
        className="border-b border-amber-300 bg-amber-50 px-6 py-3 text-sm text-amber-950"
        data-testid="patient-help-note"
      >
        <p className="mx-auto max-w-5xl">
          This synthetic demo is not monitored and has no on-call care team. For medication supply
          questions, contact your own prescriber or pharmacy. In the U.S., call or text{" "}
          <a className="font-semibold underline" href="https://988lifeline.org/get-help/">
            988 for crisis support
          </a>
          ; call 911 if you or someone else is in immediate danger.
        </p>
      </aside>
      {children}
    </div>
  );
}
