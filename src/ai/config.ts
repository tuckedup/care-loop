// AI config from env. Unset model or key means the AI path fails closed (escalate).
import { z } from "zod";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const aiEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(blank, z.string().min(1).optional()),
  ANTHROPIC_MODEL: z.preprocess(blank, z.string().min(1).optional()),
});

export interface AiConfig {
  apiKey: string | undefined;
  model: string | undefined;
}

export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const parsed = aiEnvSchema.safeParse(env);
  if (!parsed.success) return { apiKey: undefined, model: undefined };
  return { apiKey: parsed.data.ANTHROPIC_API_KEY, model: parsed.data.ANTHROPIC_MODEL };
}
