// v0.1 end-to-end patient flow against the seeded database:
// login (demo auth) -> renew -> verify identity -> check-in -> result -> status.
// Also reads the database afterwards to prove the events and the audit chain.
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { verifyAuditChain } from "../src/infra/audit";
import { loginAsDemoPatient } from "./support/auth";
import { fillCheckIn } from "./support/checkin";
import { resetAndSeedDb } from "./support/db";

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("patient renews sertraline: renew -> verify -> check-in -> status", async ({ page }) => {
  await loginAsDemoPatient(page);

  // renew
  await page
    .getByTestId("med-rx-demo-sertraline")
    .getByRole("button", { name: /Request renewal/ })
    .click();

  // verify
  await expect(page.getByRole("heading", { name: "Verify your identity" })).toBeVisible();
  const renewalId = page.url().split("/").pop()!.split("?")[0]!;
  await page.getByLabel("Last name").fill(DEMO_PATIENT_IDENTITY.lastName);
  await page.getByLabel("Date of birth").fill(DEMO_PATIENT_IDENTITY.dateOfBirth);
  await page.getByRole("button", { name: "Verify identity" }).click();

  // check-in
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
  await fillCheckIn(page, { score: 0, pregnancy: "no" });
  await page.getByRole("button", { name: "Submit check-in" }).click();

  // result: safe default, never auto-approved before the decision pipeline exists
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );

  // status
  await page.getByRole("link", { name: "View renewal status" }).click();
  const item = page.getByTestId(`renewal-${renewalId}`);
  await expect(item).toContainText("sertraline");
  await expect(item.getByTestId("renewal-status")).toHaveText("Under review");

  // what actually happened in the event store
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const events = await sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id = ${"renewal-" + renewalId} ORDER BY stream_version`;
    expect(events.map((e) => e.type)).toEqual([
      "RenewalRequested",
      "IdentityVerified",
      "CheckInSubmitted",
    ]);
    const audit = await sql<{ actor: string; role: string; action: string }[]>`
      SELECT actor, role, action FROM audit_log WHERE entity = ${"renewal-" + renewalId} ORDER BY seq`;
    expect(audit.map((a) => a.action)).toEqual([
      "patient:RequestRenewal",
      "patient:VerifyIdentity",
      "patient:SubmitCheckIn",
    ]);
    expect(audit.every((a) => a.actor === "patient-demo-001" && a.role === "patient")).toBe(true);
    expect(await verifyAuditChain(sql)).toMatchObject({ valid: true });
  } finally {
    await sql.end();
  }
});
