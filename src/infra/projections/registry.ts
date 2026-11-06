import type { Sql } from "postgres";
import { runProjection, type Projection, type RunResult } from "./runner";

export class ProjectionRegistry {
  private readonly byName = new Map<string, Projection>();

  register(projection: Projection): this {
    if (this.byName.has(projection.name)) {
      throw new Error(`Projection already registered: ${projection.name}`);
    }
    this.byName.set(projection.name, projection);
    return this;
  }

  get(name: string): Projection | undefined {
    return this.byName.get(name);
  }

  all(): Projection[] {
    return [...this.byName.values()];
  }
}

/** The application registry. Concrete projections are registered in ./all.ts. */
export const projectionRegistry = new ProjectionRegistry();

/** Bring every registered projection up to date. */
export async function runAllProjections(
  sql: Sql,
  registry: ProjectionRegistry = projectionRegistry,
): Promise<Record<string, RunResult>> {
  const out: Record<string, RunResult> = {};
  for (const p of registry.all()) out[p.name] = await runProjection(sql, p);
  return out;
}
