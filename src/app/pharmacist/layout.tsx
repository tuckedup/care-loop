import Link from "next/link";
import type { ReactNode } from "react";
import { requirePageRole } from "@/infra/auth/guard";

// Server-side RBAC for everything under /pharmacist. Pages and actions re-check on their own.
export default async function PharmacistLayout({ children }: { children: ReactNode }) {
  await requirePageRole("pharmacist", "admin");
  return (
    <div>
      <nav
        aria-label="Pharmacist"
        className="flex gap-4 border-b border-slate-200 px-6 py-3 text-sm dark:border-slate-800"
      >
        <Link href="/pharmacist/inbox" className="underline">
          Pharmacist inbox
        </Link>
        <Link href="/login" className="ml-auto underline">
          Switch role (demo auth)
        </Link>
      </nav>
      {children}
    </div>
  );
}
