// Run: pnpm exec tsx scripts/visits-repair.ts  (needs DATABASE_URL). Idempotent repair sweep for
// visit-note signings that crashed before the follow-up task was written.
import postgres from "postgres";
import { repairUnfinishedSignings } from "../src/domain/visit/handlers";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("visits-repair: DATABASE_URL is required.");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const r = await repairUnfinishedSignings(sql);
    console.log(
      `visits-repair: checked ${r.checked}, repaired ${r.repaired.length}, missing slot ${r.missingSlot.length}, failed ${r.failed.length}`,
    );
    process.exitCode = r.failed.length > 0 || r.missingSlot.length > 0 ? 1 : 0;
  } finally {
    await sql.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
