import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

async function insert(streamId: string, version: number) {
  const [row] = await db.sql`
    INSERT INTO events (stream_id, stream_version, type, data)
    VALUES (${streamId}, ${version}, 'PatientRegistered', ${JSON.stringify({ ok: true })}::jsonb)
    RETURNING global_position
  `;
  return row!;
}

// The mutating statements below are issued only from this test, as a privileged raw attempt,
// to prove the database itself refuses them. Application code never contains such statements.
describe("events append-only triggers (F002)", () => {
  it("allows INSERT", async () => {
    await expect(insert("patient-ao", 1)).resolves.toBeDefined();
  });

  it("rejects UPDATE", async () => {
    await insert("patient-upd", 1);
    await expect(
      db.sql.unsafe(`UPDATE events SET type = 'Tampered' WHERE stream_id = 'patient-upd'`),
    ).rejects.toMatchObject({ code: "23001", message: expect.stringContaining("append-only") });
  });

  it("rejects DELETE", async () => {
    await insert("patient-del", 1);
    await expect(
      db.sql.unsafe(`DELETE FROM events WHERE stream_id = 'patient-del'`),
    ).rejects.toMatchObject({ code: "23001" });
  });

  it("rejects TRUNCATE", async () => {
    await expect(db.sql.unsafe(`TRUNCATE events`)).rejects.toMatchObject({ code: "23001" });
  });

  it("leaves rows unchanged after the rejected attempts", async () => {
    const rows = await db.sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id IN ('patient-upd', 'patient-del')
    `;
    expect(rows.map((r) => r.type)).toEqual(["PatientRegistered", "PatientRegistered"]);
  });
});
