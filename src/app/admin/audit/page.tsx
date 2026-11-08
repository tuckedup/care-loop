import Link from "next/link";
import { toAuditEvent } from "@/infra/audit/audit-event";
import { verifyAuditChain } from "@/infra/audit";
import { requirePageRole } from "@/infra/auth/guard";
import { getSql } from "@/infra/db/client";
import { registerAllProjections } from "@/infra/projections/all";
import { listAuditView } from "@/infra/projections/audit-view";
import { runAllProjections } from "@/infra/projections/registry";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  // Admin only, server side. Clinicians, patients and pharmacists are redirected to /forbidden.
  await requirePageRole("admin");
  const { before } = await searchParams;
  const sql = getSql();
  await runAllProjections(sql, registerAllProjections());
  const [chain, rows] = await Promise.all([
    verifyAuditChain(sql),
    listAuditView(sql, {
      limit: PAGE_SIZE,
      ...(before && /^\d{1,18}$/.test(before) ? { before } : {}),
    }),
  ]);
  const events = rows.map(toAuditEvent);
  const oldest = rows.at(-1)?.auditSeq;

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-1 text-sm text-muted">
        FHIR AuditEvent-shaped JSON (not a conformant FHIR server). Synthetic data. The hash chain
        is tamper-evident: it shows when rows were altered, it does not prevent a database superuser
        from altering them.
      </p>

      {chain.valid ? (
        <p
          data-testid="chain-status"
          data-chain-valid="true"
          className="mt-4 inline-block rounded-xl border bg-surface border-green-700 bg-green-50 px-3 py-1 text-sm font-medium text-green-900 dark:bg-green-950 dark:text-green-100"
        >
          Chain intact: {chain.checked} entries verified (head seq {chain.headSeq})
        </p>
      ) : (
        <p
          data-testid="chain-status"
          data-chain-valid="false"
          role="alert"
          className="mt-4 inline-block rounded border-2 border-red-700 bg-red-50 px-3 py-1 text-sm font-semibold text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          TAMPER DETECTED at seq {chain.brokenAtSeq}: {chain.reason}
        </p>
      )}

      <ol className="mt-6 space-y-3" data-testid="audit-list">
        {events.length === 0 ? <li className="text-sm">No audit entries yet.</li> : null}
        {events.map((e) => (
          <li
            key={e.id}
            data-testid={`audit-${e.id}`}
            data-action={e.subtype[0]?.code}
            data-role={e.agent[0]?.role[0]?.text}
            className="rounded-xl border bg-surface border-line-strong p-3"
          >
            <pre className="overflow-x-auto text-xs">{JSON.stringify(e, null, 2)}</pre>
          </li>
        ))}
      </ol>

      {rows.length === PAGE_SIZE && oldest ? (
        <Link
          href={`/admin/audit?before=${oldest}`}
          data-testid="audit-older"
          className="mt-6 inline-block text-sm underline"
        >
          Older entries
        </Link>
      ) : null}
      <div className="mt-6">
        <Link href="/admin" className="text-sm underline">
          Admin
        </Link>
      </div>
    </main>
  );
}
