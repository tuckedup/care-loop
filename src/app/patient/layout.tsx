import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";
import { InfoIcon } from "../_components/ui";
import { RoleNav } from "../_components/role-nav";

// Server-side RBAC for everything under /patient: only the patient role gets through.
export default async function PatientLayout({ children }: { children: ReactNode }) {
  await requirePageRole("patient");
  return (
    <div>
      <RoleNav
        label="Patient"
        links={[
          { href: "/patient/renew", label: "Renew a medication" },
          { href: "/patient/status", label: "Renewal status" },
        ]}
      />
      <aside
        aria-label="Demo support and urgent help"
        className="border-b border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        data-testid="patient-help-note"
      >
        <p className="mx-auto flex max-w-6xl items-start gap-2.5 px-5 py-2.5 text-sm leading-6 sm:px-8">
          <InfoIcon className="mt-1 h-4 w-4 shrink-0" />
          <span>
            This synthetic demo is not monitored and has no on-call care team. For medication supply
            questions, contact your own prescriber or pharmacy. In the U.S., call or text{" "}
            <a className="font-semibold underline" href="https://988lifeline.org/get-help/">
              988 for crisis support
            </a>
            ; call 911 if you or someone else is in immediate danger.
          </span>
        </p>
      </aside>
      {children}
    </div>
  );
}
