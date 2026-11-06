import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FORMULARY } from "@/domain/formulary";
import { createTestDb, type TestDb } from "@/test/db";
import {
  findFormularyByRxcui,
  getFormularyRow,
  listFormulary,
  seedFormulary,
} from "./formulary-repo";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seedFormulary(db.sql);
});
afterAll(async () => {
  await db.drop();
});

describe("formulary table", () => {
  it("mirrors the pure formulary and is idempotent", async () => {
    expect(await seedFormulary(db.sql)).toBe(FORMULARY.length);
    const rows = await listFormulary(db.sql);
    expect(rows.map((r) => r.id).sort()).toEqual(FORMULARY.map((e) => e.id).sort());
    for (const e of FORMULARY) {
      const row = rows.find((r) => r.id === e.id)!;
      expect(row.rxcui).toBe(e.rxcui);
      expect(row.allowlisted).toBe(e.allowlisted);
      expect(row.controlledSchedule).toBe(e.controlledSchedule);
    }
  });

  it("has 15 allowlisted drugs and controlled entries that are never allowlisted", async () => {
    const rows = await listFormulary(db.sql);
    expect(rows.filter((r) => r.allowlisted)).toHaveLength(15);
    const controlled = rows.filter((r) => r.controlledSchedule !== null);
    expect(controlled.map((r) => r.id).sort()).toEqual(["alprazolam", "lisdexamfetamine"]);
    expect(controlled.every((r) => !r.allowlisted)).toBe(true);
  });

  it("the database rejects an allowlisted controlled entry", async () => {
    await expect(
      db.sql.unsafe(
        `INSERT INTO formulary (id, name, allowlisted, controlled_schedule, aliases, form_tokens)
         VALUES ('bad', 'bad', true, 'II', '[]', '[]')`,
      ),
    ).rejects.toThrow();
  });

  it("read helpers: by id, by RxCUI (shared bupropion ingredient), null never matches", async () => {
    expect((await getFormularyRow(db.sql, "alprazolam"))?.controlledSchedule).toBe("IV");
    expect(await getFormularyRow(db.sql, "nope")).toBeNull();
    const bup = await findFormularyByRxcui(db.sql, "42347");
    expect(bup.map((r) => r.id)).toEqual(["bupropion_sr", "bupropion_xl"]);
    expect(await findFormularyByRxcui(db.sql, null)).toEqual([]);
    expect(await findFormularyByRxcui(db.sql, "")).toEqual([]);
  });
});
