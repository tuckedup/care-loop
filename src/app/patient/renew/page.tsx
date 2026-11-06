import { requirePageRole } from "@/infra/auth/guard";

// Placeholder: replaced by the real patient renewal flow in a later feature.
export default async function Page() {
  await requirePageRole("patient");
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Patient renewal</h1>
    </main>
  );
}
