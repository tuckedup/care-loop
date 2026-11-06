// F054: pharmacist inbox. Pure acknowledge decision + DB-backed projection round trip.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvedRenewal, scriptedFetch } from "@/infra/outbox/test-fixture";
import { createDefaultRegistry } from "@/infra/outbox/registry";
import { mulberry32 } from "@/infra/outbox/rng";
import { runOnce } from "@/infra/outbox/worker";
import { registerAllProjections } from "@/infra/projections/all";
import { listPharmacyAlerts } from "@/infra/projections/pharmacy-alerts";
import { rebuildProjections } from "@/infra/projections/rebuild";
import { runAllProjections } from "@/infra/projections/registry";
import { readStream } from "@/infra/event-store";
import { createTestDb, type TestDb } from "@/test/db";
import { DomainError } from "./aggregate";
import type { DomainEvent } from "./events";
import {
  acknowledgeAlert,
  alertInitialState,
  decideAlerts,
  evolveAlerts,
  type AcknowledgeAlert,
} from "./pharmacist";

const escalation = {
  type: "PharmacistEscalationReceived",
  data: { v: 1, renewalId: "r1", messageId: "m-esc", message: "call me" },
} as DomainEvent;
const retryableErr = {
  type: "PharmacyErrorReceived",
  data: { v: 1, renewalId: "r1", messageId: "m-r", code: "BUSY", retryable: true },
} as DomainEvent;
const fatalErr = {
  type: "PharmacyErrorReceived",
  data: { v: 1, renewalId: "r1", messageId: "m-f", code: "NOPE", retryable: false },
} as DomainEvent;
const cmd = (over: Partial<AcknowledgeAlert> = {}): AcknowledgeAlert => ({
  type: "AcknowledgeAlert",
  renewalId: "r1",
  messageId: "m-esc",
  actorId: "ph1",
  actorRole: "pharmacist",
  ...over,
});
const fold = (...events: DomainEvent[]) => events.reduce(evolveAlerts, alertInitialState);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as DomainError).code;
  }
  return null;
};

describe("decideAlerts (pure)", () => {
  it("a pharmacist or admin acknowledges an escalation; the event names who", () => {
    for (const role of ["pharmacist", "admin"] as const) {
      expect(decideAlerts(fold(escalation), cmd({ actorRole: role }))).toEqual([
        {
          type: "PharmacyAlertAcknowledged",
          data: { v: 1, renewalId: "r1", messageId: "m-esc", acknowledgedBy: "ph1" },
        },
      ]);
    }
  });
  it("other roles are refused, whatever the alert", () => {
    for (const role of ["patient", "clinician", "system"] as const) {
      expect(code(() => decideAlerts(fold(escalation), cmd({ actorRole: role })))).toBe(
        "NOT_A_PHARMACIST",
      );
    }
  });
  it("unknown message ids and retryable errors (not alerts) are refused", () => {
    expect(code(() => decideAlerts(fold(escalation), cmd({ messageId: "nope" })))).toBe(
      "ALERT_NOT_FOUND",
    );
    expect(code(() => decideAlerts(fold(retryableErr), cmd({ messageId: "m-r" })))).toBe(
      "ALERT_NOT_FOUND",
    );
    expect(decideAlerts(fold(fatalErr), cmd({ messageId: "m-f" }))).toHaveLength(1);
  });
  it("is idempotent once acknowledged", () => {
    const acked = fold(escalation, ...decideAlerts(fold(escalation), cmd()));
    expect(decideAlerts(acked, cmd())).toEqual([]);
  });
  it("rejects malformed commands", () => {
    expect(code(() => decideAlerts(fold(escalation), cmd({ messageId: "" })))).toBe(
      "INVALID_COMMAND",
    );
  });
});

describe("pharmacist inbox end to end (DB)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });
  const sync = () => runAllProjections(db.sql, registerAllProjections());

  it("an escalation from the pharmacy reaches the inbox, is acknowledged once, and survives a rebuild", async () => {
    const r = await approvedRenewal(db.sql);
    const pharmacy = scriptedFetch([
      {
        status: 200,
        messages: [
          { type: "Status", messageId: `${r.renewalId}:s`, status: "OK" },
          { type: "PharmacistEscalation", messageId: `${r.renewalId}:e`, message: "dose?" },
          { type: "PharmacistEscalation", messageId: `${r.renewalId}:e`, message: "dose?" },
        ],
      },
    ]);
    await runOnce(db.sql, {
      registry: createDefaultRegistry({
        sql: db.sql,
        baseUrl: "http://p.test",
        fetch: pharmacy.fetch,
      }),
      rng: mulberry32(1),
      now: () => new Date(Date.now() + 60_000),
    });
    await sync();
    const open = await listPharmacyAlerts(db.sql, { status: "open" });
    expect(open).toHaveLength(1); // the duplicate escalation is one alert
    expect(open[0]).toMatchObject({
      kind: "escalation",
      renewalId: r.renewalId,
      patientId: r.patientId,
      message: "dose?",
    });

    await expect(
      acknowledgeAlert(
        db.sql,
        { role: "clinician", id: "c-1" },
        {
          renewalId: r.renewalId,
          messageId: `${r.renewalId}:e`,
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_A_PHARMACIST" });

    const actor = { role: "pharmacist" as const, id: "pharm-1" };
    const input = { renewalId: r.renewalId, messageId: `${r.renewalId}:e` };
    const first = await acknowledgeAlert(db.sql, actor, input);
    expect(first.appended).not.toBeNull();
    const second = await acknowledgeAlert(db.sql, actor, input);
    expect(second.appended).toBeNull();
    expect(
      (await readStream(db.sql, `renewal-${r.renewalId}`)).filter(
        (e) => e.type === "PharmacyAlertAcknowledged",
      ),
    ).toHaveLength(1);
    const [audit] = await db.sql.unsafe(
      `SELECT actor, role FROM audit_log WHERE action = 'pharmacist:AcknowledgeAlert'`,
    );
    expect(audit).toMatchObject({ actor: "pharm-1", role: "pharmacist" });

    await sync();
    const all = await listPharmacyAlerts(db.sql);
    expect(all[0]).toMatchObject({ status: "acknowledged", acknowledgedBy: "pharm-1" });
    expect(await listPharmacyAlerts(db.sql, { status: "open" })).toEqual([]);

    const before = await listPharmacyAlerts(db.sql);
    await rebuildProjections(db.sql, registerAllProjections());
    expect(await listPharmacyAlerts(db.sql)).toEqual(before);
  });
});
