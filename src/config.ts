import { z } from "zod";

// Empty strings (as in .env.example) mean "unset", not 0 or a present key.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const envSchema = z.object({
  DATABASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  ANTHROPIC_MODEL: z.preprocess(blankToUndefined, z.string().optional()),
  SESSION_SECRET: z.preprocess(blankToUndefined, z.string().min(32).optional()),
  REFILL_LIMIT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).default(2)),
  SAMPLE_RATE: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(1).default(0.2)),
  SEED: z.preprocess(blankToUndefined, z.coerce.number().int().default(42)),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return envSchema.parse(env);
}
