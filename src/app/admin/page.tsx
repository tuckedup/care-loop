import Link from "next/link";
import { requirePageRole } from "@/infra/auth/guard";

// Placeholder: replaced by the real admin dashboard in a later feature.
export default async function Page() {
  await requirePageRole("admin");
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <nav aria-label="Admin sections" className="mt-4 flex gap-4 text-sm">
        <Link href="/admin/audit" className="underline">
          Audit log
        </Link>
      </nav>
    </main>
  );
}
