import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";
import { RoleNav } from "../_components/role-nav";

// Server-side RBAC for everything under /clinician. Pages and actions re-check on their own.
export default async function ClinicianLayout({ children }: { children: ReactNode }) {
  await requirePageRole("clinician", "admin");
  return (
    <div>
      <RoleNav
        label="Clinician"
        links={[
          { href: "/clinician/queue", label: "Renewal queue" },
          { href: "/clinician/visits", label: "Follow-up visits" },
          { href: "/clinician/pharmacy-alerts", label: "Pharmacy alerts" },
          { href: "/clinician/retro-review", label: "Retro review" },
        ]}
      />
      {children}
    </div>
  );
}
