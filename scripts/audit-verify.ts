import postgres from "postgres";
import { runAuditVerify } from "../src/infra/audit/verify-cli";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("audit:verify: DATABASE_URL is required.");
    return 2;
  }
  // prepare:false keeps this compatible with Supabase's transaction-mode pooler.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const report = await runAuditVerify(sql);
    for (const line of report.lines) (report.exitCode === 0 ? console.log : console.error)(line);
    return report.exitCode;
  } finally {
    await sql.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      `audit:verify: could not verify (${err instanceof Error ? err.message : "error"}).`,
    );
    process.exit(2);
  },
);
