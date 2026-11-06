import postgres from "postgres";
import { registerAllProjections } from "../src/infra/projections/all";
import { rebuildProjections } from "../src/infra/projections/rebuild";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("projections:rebuild: DATABASE_URL is required.");
  // prepare:false keeps this compatible with Supabase's transaction-mode pooler.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const results = await rebuildProjections(sql, registerAllProjections());
    for (const [name, r] of Object.entries(results)) {
      console.log(
        `projections:rebuild: ${name} replayed ${r.applied} event(s), checkpoint ${r.lastPosition}`,
      );
    }
    console.log("projections:rebuild: done.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
