// `pnpm audit:verify`: recompute the audit hash chain from the database and report.
// Exit code contract: 0 = chain valid, 1 = tamper detected (first broken seq is printed),
// 2 = could not verify (no DATABASE_URL / connection error). Never reports success on error.
//
// What this proves, honestly: the chain is tamper-EVIDENT, not tamper-proof. The append-only
// triggers stop the application role from updating or deleting rows, but a database superuser (or
// table owner) can disable triggers and rewrite rows. Doing so breaks the hash chain, and this
// command detects it. A superuser who rewrites the WHOLE chain from some point forward and also
// resets audit_chain_head leaves a self-consistent chain; closing that needs the head hash
// anchored outside the database (TODO: periodic external anchor). Synthetic data only; this is
// a design aid, not a compliance certification.
import type { Sql } from "postgres";
import { verifyAuditChain, type VerifyResult } from "./audit-log";

export interface VerifyReport {
  exitCode: 0 | 1;
  lines: string[];
  result: VerifyResult;
}

export async function runAuditVerify(sql: Sql): Promise<VerifyReport> {
  const result = await verifyAuditChain(sql);
  if (result.valid) {
    return {
      exitCode: 0,
      result,
      lines: [
        `audit:verify: OK. Hash chain intact: ${result.checked} entries, head seq ${result.headSeq}.`,
      ],
    };
  }
  return {
    exitCode: 1,
    result,
    lines: [
      `audit:verify: TAMPER DETECTED. First broken entry: seq ${result.brokenAtSeq} (${result.reason}).`,
      `audit:verify: ${result.checked} entries verified before the break.`,
    ],
  };
}
