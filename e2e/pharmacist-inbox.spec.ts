// F054: a pharmacy escalation reaches the pharmacist inbox (pharmacist/admin only), can be
// acknowledged, and is visible to the clinician. The escalation event is created through the real
// response consumer (the same code the outbox handler runs on the mock pharmacy's answer).
import { expect, test } from "@playwright/test";
import { consumePharmacyResponse } from "../src/domain/renewal/pharmacy-responses";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { e2eSql, loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let renewalId = "";
let messageId = "";

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("a pharmacy escalation is recorded on the renewal", async ({ page, context }) => {
  renewalId = await submitRenewalAsPatient(page, context, {
    patientId: DEMO_PATIENT_ID,
    lastName: DEMO_PATIENT_IDENTITY.lastName,
    dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });
  messageId = `esc-${renewalId}`;
  const sql = e2eSql();
  try {
    await consumePharmacyResponse(
      sql,
      {
        renewalId,
        messageId: `rxmsg-${renewalId}`,
        idempotencyKey: `rx-renewal:${renewalId}`,
        httpStatus: 200,
        body: {
          messages: [
            { type: "Status", messageId: `st-${renewalId}`, status: "OK" },
            { type: "PharmacistEscalation", messageId, message: "Please confirm the dose." },
          ],
        },
      },
      { actor: "e2e-pharmacy", role: "system", action: "e2e:pharmacy-response" },
    );
    const rows = await sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id = ${"renewal-" + renewalId}
        AND type = 'PharmacistEscalationReceived'`;
    expect(rows).toHaveLength(1);
  } finally {
    await sql.end();
  }
});

test("the inbox is for pharmacist and admin only (server-side)", async ({ page, context }) => {
  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto("/pharmacist/inbox");
  await expect(page).toHaveURL(/\/forbidden$/);
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/pharmacist/inbox");
  await expect(page).toHaveURL(/\/forbidden$/);
  await context.clearCookies();
  await page.goto("/pharmacist/inbox");
  await expect(page).toHaveURL(/\/login/);
});

test("the clinician sees the open escalation", async ({ page, context }) => {
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/pharmacy-alerts");
  const item = page.getByTestId(`clinician-alert-${messageId}`);
  await expect(item).toHaveAttribute("data-status", "open");
  await expect(item).toContainText("Please confirm the dose.");
});

test("the pharmacist sees it and acknowledges it; the clinician sees it acknowledged", async ({
  page,
  context,
}) => {
  await loginAs(context, "pharmacist", DEMO_SUBJECTS.pharmacist);
  await page.goto("/pharmacist/inbox");
  await expect(page.getByRole("heading", { name: "Pharmacist inbox" })).toBeVisible();
  const item = page.getByTestId(`alert-${messageId}`);
  await expect(item).toHaveAttribute("data-status", "open");
  await expect(item).toContainText("Please confirm the dose.");
  await item.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByTestId(`alert-${messageId}`)).toHaveAttribute(
    "data-status",
    "acknowledged",
  );
  await expect(page.getByTestId(`alert-${messageId}`).getByTestId("acknowledged")).toContainText(
    DEMO_SUBJECTS.pharmacist,
  );

  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/pharmacy-alerts");
  await expect(page.getByTestId(`clinician-alert-${messageId}`)).toHaveAttribute(
    "data-status",
    "acknowledged",
  );
});

test("an admin can open the inbox", async ({ page, context }) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/pharmacist/inbox");
  await expect(page.getByRole("heading", { name: "Pharmacist inbox" })).toBeVisible();
  await expect(page.getByTestId("inbox-open-count")).toHaveText("0 open");
});
