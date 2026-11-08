import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";
import { RoleNav } from "../_components/role-nav";

// Server-side RBAC for everything under /admin. Pages re-check on their own.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requirePageRole("admin");
  return (
    <div>
      <RoleNav
        label="Admin"
        links={[
          { href: "/admin/dashboard", label: "Dashboard" },
          { href: "/admin/autonomy", label: "Autonomy" },
          { href: "/admin/evals", label: "Eval results" },
          { href: "/admin/audit", label: "Audit log" },
        ]}
      />
      {children}
    </div>
  );
}
