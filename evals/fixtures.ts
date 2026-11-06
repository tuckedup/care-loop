// AI fixtures: canned model responses used by CI so `pnpm eval` never calls a live API.
// IMPORTANT: every fixture in this repo is HAND-WRITTEN by the author ("synthetic-handwritten").
// None was recorded from a live model. `pnpm eval:live` is the path that exercises a real model.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = () => process.env.EVAL_FIXTURES_DIR ?? join(here, "fixtures");

export const AiFixtureSchema = z
  .object({
    header: z
      .object({
        kind: z.literal("synthetic-handwritten"),
        description: z.string().min(1),
        /** false for fixtures that simulate transport failures or a fooled model; skipped in live mode. */
        liveApplicable: z.boolean(),
      })
      .strict(),
    response: z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }).strict(),
      z.object({ type: z.literal("error"), error: z.enum(["http_500", "timeout"]) }).strict(),
    ]),
  })
  .strict();

export type AiFixture = z.infer<typeof AiFixtureSchema>;

export function loadFixture(name: string, dir: string = fixturesDir()): AiFixture {
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`AI fixture not found: ${name}`);
  const parsed = AiFixtureSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid AI fixture ${name}: ${parsed.error.message}`);
  return parsed.data;
}
