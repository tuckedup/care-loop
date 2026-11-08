import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";
import { RoleNav } from "../_components/role-nav";

// Server-side RBAC for everything under /pharmacist. Pages and actions re-check on their own.
export default async function PharmacistLayout({ children }: { children: ReactNode }) {
  await requirePageRole("pharmacist", "admin");
  return (
    <div>
      <RoleNav
        label="Pharmacist"
        links={[{ href: "/pharmacist/inbox", label: "Pharmacist inbox" }]}
      />
      {children}
    </div>
  );
}
