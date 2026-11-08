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
import { confirmPharmacy } from "./support/pharmacy";

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

  // pharmacy (confirm-before-send; recorded on the renewal), then check-in
  await confirmPharmacy(page);
  await expect(page.getByRole("heading", { name: "Check-in" })).toBeVisible();
  await fillCheckIn(page, { score: 0, pregnancy: "no" });
  await page.getByRole("button", { name: "Submit check-in" }).click();

  // result: the pipeline ran; with no AI key the AI result is "failed" => ESCALATE (fail closed).
  // Never approved without a clinician: the patient sees "under review".
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );

  // status
  await page.getByRole("link", { name: "View renewal status" }).click();
  const item = page.getByTestId(`renewal-${renewalId}`);
  await expect(item).toContainText("sertraline");
  await expect(item).toHaveAttribute("data-status", "escalated");
  await expect(item.getByTestId("renewal-status")).toHaveText(
    "Waiting in the clinician review queue",
  );

  // what actually happened in the event store
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const events = await sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id = ${"renewal-" + renewalId} ORDER BY stream_version`;
    expect(events.map((e) => e.type)).toEqual([
      "RenewalRequested",
      "IdentityVerified",
      "PharmacySelected",
      "CheckInSubmitted",
      // No RiskSignalsExtracted: failed AI with no local tripwire hit emits no signals event.
      "EligibilityEvaluated",
      "RenewalEscalated",
    ]);
    expect(events.map((e) => e.type)).not.toContain("RenewalApproved");
    const audit = await sql<{ actor: string; role: string; action: string }[]>`
      SELECT actor, role, action FROM audit_log WHERE entity = ${"renewal-" + renewalId} ORDER BY seq`;
    expect(audit.map((a) => a.action)).toEqual([
      "patient:RequestRenewal",
      "patient:VerifyIdentity",
      "patient:SelectPharmacy",
      "patient:SubmitCheckIn",
      "system:RecordEvaluation",
    ]);
    const patientRows = audit.slice(0, 4);
    expect(patientRows.every((a) => a.actor === "patient-demo-001" && a.role === "patient")).toBe(
      true,
    );
    // The evaluation is written by the pipeline, never attributed to the patient or a clinician.
    expect(audit[4]).toMatchObject({ actor: "system:decision-pipeline", role: "system" });
    const escalation = await sql<{ data: { reasonCodes: string[] } }[]>`
      SELECT data FROM events WHERE stream_id = ${"renewal-" + renewalId}
        AND type = 'RenewalEscalated'`;
    expect(escalation[0]!.data.reasonCodes).toContain("LLM_FAILURE");
    expect(await verifyAuditChain(sql)).toMatchObject({ valid: true });
  } finally {
    await sql.end();
  }
});
