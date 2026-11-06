import type { Sql } from "postgres";
import { projectionRegistry, type ProjectionRegistry } from "./registry";
import { runProjection, type RunResult } from "./runner";

/**
 * Rebuild projections from position 0: empty each projection's own tables and its checkpoint in
 * one transaction (so a live runner never sees tables without a matching checkpoint), then replay
 * every event. Reads the events table only; it never writes to it.
 */
export async function rebuildProjections(
  sql: Sql,
  registry: ProjectionRegistry = projectionRegistry,
  opts: { names?: string[]; batchSize?: number } = {},
): Promise<Record<string, RunResult>> {
  const selected = registry.all().filter((p) => !opts.names || opts.names.includes(p.name));
  if (opts.names) {
    const missing = opts.names.filter((n) => !registry.get(n));
    if (missing.length > 0) throw new Error(`Unknown projection(s): ${missing.join(", ")}`);
  }
  const out: Record<string, RunResult> = {};
  for (const projection of selected) {
    await sql.begin(async (tx) => {
      await projection.reset(tx);
      await tx.unsafe(`DELETE FROM projection_checkpoints WHERE name = $1`, [projection.name]);
    });
    out[projection.name] = await runProjection(sql, projection, { batchSize: opts.batchSize });
  }
  return out;
}
