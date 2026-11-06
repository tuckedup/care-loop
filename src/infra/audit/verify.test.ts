// F056: `pnpm audit:verify` recomputes the hash chain and reports the first broken seq.
// Tampering is done through a PRIVILEGED raw connection (trigger disabled) in an isolated schema,
// which is exactly what the append-only triggers cannot stop and the chain must detect.
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeEvent } from "@/domain/events";
import { createTestDb, type TestDb } from "@/test/db";
import { appendToStream } from "./audit-log";
import { runAuditVerify } from "./verify-cli";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.drop();
});

const ctx = { actor: "verify-test", role: "system", action: "test:verify" } as const;
let stream = 0;
async function seedChain(n: number) {
  for (let i = 0; i < n; i++) {
    stream++;
    await appendToStream(
      db.sql,
      `patient-vt-${stream}`,
      0,
      [
        makeEvent("PatientRegistered", {
          v: 1,
          patientId: `vt-${stream}`,
          firstName: "Test",
          lastName: "Patient",
          dateOfBirth: "1990-01-01",
        }),
      ],
      ctx,
    );
  }
}

/** Run `fn` with the append-only triggers disabled (what a superuser/owner can do). */
async function privileged(fn: () => Promise<unknown>) {
  await db.sql.unsafe(`ALTER TABLE audit_log DISABLE TRIGGER USER`);
  try {
    await fn();
  } finally {
    await db.sql.unsafe(`ALTER TABLE audit_log ENABLE TRIGGER USER`);
  }
}

beforeEach(async () => {
  // Only the audit chain is reset between tests (the events they append use fresh stream ids).
  await privileged(async () => {
    await db.sql.unsafe(`DELETE FROM audit_log`);
    await db.sql.unsafe(`UPDATE audit_chain_head SET seq = 0, hash = repeat('0', 64) WHERE id = 1`);
  });
});

describe("runAuditVerify", () => {
  it("an empty and a valid chain exit 0", async () => {
    expect((await runAuditVerify(db.sql)).exitCode).toBe(0);
    await seedChain(4);
    const r = await runAuditVerify(db.sql);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/OK.*4 entries, head seq 4/);
  });

  it("the application path cannot mutate rows (trigger), so tampering needs privileges", async () => {
    await seedChain(2);
    await expect(db.sql.unsafe(`UPDATE audit_log SET actor = 'x' WHERE seq = 1`)).rejects.toThrow();
    await expect(db.sql.unsafe(`DELETE FROM audit_log WHERE seq = 2`)).rejects.toThrow();
  });

  it("an altered entry is detected at exactly its seq", async () => {
    await seedChain(5);
    await privileged(() => db.sql.unsafe(`UPDATE audit_log SET actor = 'mallory' WHERE seq = 3`));
    const r = await runAuditVerify(db.sql);
    expect(r.exitCode).toBe(1);
    expect(r.result).toMatchObject({ valid: false, brokenAtSeq: "3" });
    expect(r.lines.join("\n")).toMatch(/TAMPER DETECTED.*seq 3/);
  });

  it("an altered detail is detected too", async () => {
    await seedChain(3);
    await privileged(() =>
      db.sql.unsafe(`UPDATE audit_log SET detail = '{"streamId":"forged"}'::jsonb WHERE seq = 2`),
    );
    expect(await runAuditVerify(db.sql)).toMatchObject({
      exitCode: 1,
      result: { brokenAtSeq: "2" },
    });
  });

  it("a deleted middle entry is detected at the gap", async () => {
    await seedChain(5);
    await privileged(() => db.sql.unsafe(`DELETE FROM audit_log WHERE seq = 3`));
    const r = await runAuditVerify(db.sql);
    expect(r.exitCode).toBe(1);
    expect(r.result).toMatchObject({ valid: false, brokenAtSeq: "4" });
  });

  it("a rewritten entry with a forged own hash is still detected", async () => {
    await seedChain(4);
    await privileged(() =>
      db.sql.unsafe(`UPDATE audit_log SET actor = 'mallory', hash = repeat('a', 64) WHERE seq = 2`),
    );
    const r = await runAuditVerify(db.sql);
    expect(r.exitCode).toBe(1);
    expect(r.result).toMatchObject({ valid: false, brokenAtSeq: "2" });
  });

  it("removing the last entry is detected via the chain head", async () => {
    await seedChain(3);
    await privileged(() => db.sql.unsafe(`DELETE FROM audit_log WHERE seq = 3`));
    const r = await runAuditVerify(db.sql);
    expect(r.exitCode).toBe(1);
    expect(r.result).toMatchObject({ valid: false });
    expect(r.lines.join("\n")).toMatch(/chain head/);
  });
});

describe("pnpm audit:verify (the real script, separate process)", () => {
  const run = (schema: string) => {
    const url = new URL(
      process.env.DATABASE_URL ?? "postgres://careloop:careloop@localhost:54329/careloop",
    );
    url.searchParams.set("options", `-c search_path=${schema}`);
    return spawnSync("pnpm", ["exec", "tsx", "scripts/audit-verify.ts"], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  };

  it("exits 0 on a valid chain and non-zero, naming the seq, after tampering", async () => {
    await seedChain(3);
    const ok = run(db.schema);
    expect(ok.stdout + ok.stderr).toMatch(/OK/);
    expect(ok.status).toBe(0);

    await privileged(() => db.sql.unsafe(`UPDATE audit_log SET role = 'admin' WHERE seq = 2`));
    const bad = run(db.schema);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/TAMPER DETECTED.*seq 2/);
  }, 60_000);

  it("exits 2 (not 0) without a database URL", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = spawnSync("pnpm", ["exec", "tsx", "scripts/audit-verify.ts"], {
      env,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(r.status).toBe(2);
  }, 60_000);
});
