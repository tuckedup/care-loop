// Formulary table: seed (idempotent upsert from the pure module + cached RxNav results) and
// read helpers. Reference data, not an event-sourced aggregate.
import type { Db } from "@/infra/event-store/types";
import { FORMULARY, type ControlledSchedule } from "@/domain/formulary";

export interface FormularyRow {
  id: string;
  name: string;
  rxcui: string | null;
  allowlisted: boolean;
  controlledSchedule: ControlledSchedule | null;
  aliases: string[];
  formTokens: string[];
}

interface DbRow {
  id: string;
  name: string;
  rxcui: string | null;
  allowlisted: boolean;
  controlled_schedule: ControlledSchedule | null;
  aliases: string[];
  form_tokens: string[];
}

const toRow = (r: DbRow): FormularyRow => ({
  id: r.id,
  name: r.name,
  rxcui: r.rxcui,
  allowlisted: r.allowlisted,
  controlledSchedule: r.controlled_schedule,
  aliases: r.aliases,
  formTokens: r.form_tokens,
});

/** Upsert every entry from the pure formulary. Safe to re-run. Returns the entry count. */
export async function seedFormulary(sql: Db): Promise<number> {
  for (const e of FORMULARY) {
    await sql.unsafe(
      `INSERT INTO formulary (id, name, rxcui, allowlisted, controlled_schedule, aliases, form_tokens)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, rxcui = EXCLUDED.rxcui, allowlisted = EXCLUDED.allowlisted,
         controlled_schedule = EXCLUDED.controlled_schedule, aliases = EXCLUDED.aliases,
         form_tokens = EXCLUDED.form_tokens`,
      [
        e.id,
        e.name,
        e.rxcui,
        e.allowlisted,
        e.controlledSchedule,
        JSON.stringify(e.aliases),
        JSON.stringify(e.formTokens),
      ],
    );
  }
  return FORMULARY.length;
}

export async function listFormulary(sql: Db): Promise<FormularyRow[]> {
  const rows = await sql.unsafe<DbRow[]>(`SELECT * FROM formulary ORDER BY id`);
  return rows.map(toRow);
}

export async function getFormularyRow(sql: Db, id: string): Promise<FormularyRow | null> {
  const [row] = await sql.unsafe<DbRow[]>(`SELECT * FROM formulary WHERE id = $1`, [id]);
  return row ? toRow(row) : null;
}

/** Rows sharing an RxCUI (release forms share an ingredient RxCUI). Null/empty never matches. */
export async function findFormularyByRxcui(
  sql: Db,
  rxcui: string | null | undefined,
): Promise<FormularyRow[]> {
  if (!rxcui) return [];
  const rows = await sql.unsafe<DbRow[]>(`SELECT * FROM formulary WHERE rxcui = $1 ORDER BY id`, [
    rxcui,
  ]);
  return rows.map(toRow);
}
