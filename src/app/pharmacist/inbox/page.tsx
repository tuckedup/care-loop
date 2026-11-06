import { requirePageRole } from "@/infra/auth/guard";

// Placeholder: replaced by the real pharmacist inbox in a later feature.
export default async function Page() {
  await requirePageRole("pharmacist");
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Pharmacist inbox</h1>
    </main>
  );
}
