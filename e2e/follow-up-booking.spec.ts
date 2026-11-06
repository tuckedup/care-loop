// F051: a renewal held at the refill limit shows "follow-up needed" and the patient books a visit.
// Needs the app server started with RISK_FIXTURE=synthetic-handwritten (development) so the AI
// step returns "no signals" instead of failing closed; otherwise LLM_FAILURE escalation would
// outrank the R06 follow-up. The rules path is real: seeded patient-refill-limit has 2 approved
// renewals since the last signed visit (REFILL_LIMIT=2).
import { expect, test } from "@playwright/test";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";
import { seededIdentity, streamTypes } from "./support/followup";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(
  process.env.RISK_FIXTURE !== "synthetic-handwritten",
  "needs RISK_FIXTURE=synthetic-handwritten on the app server",
);

const PATIENT = "patient-refill-limit";
let renewalId = "";

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("refill-limit renewal shows follow-up needed and offers booking, not approval", async ({
  page,
  context,
}) => {
  const who = await seededIdentity(PATIENT);
  renewalId = await submitRenewalAsPatient(page, context, {
    patientId: PATIENT,
    lastName: who.lastName,
    dateOfBirth: who.dateOfBirth,
    prescriptionId: "rx-refill-limit-fluoxetine",
  });
  const result = page.getByTestId("renewal-result");
  await expect(result).toHaveAttribute("data-result-state", "follow_up_needed");
  await expect(result).toContainText("Follow-up needed");
  await expect(page.getByTestId("book-follow-up-link")).toBeVisible();

  const types = await streamTypes(`renewal-${renewalId}`);
  expect(types).toContain("FollowUpRequired");
  expect(types).not.toContain("RenewalApproved");
  expect(types).not.toContain("RenewalEscalated");
});

test("patient books a visit slot; the renewal is still not approved", async ({ page, context }) => {
  await loginAs(context, "patient", PATIENT);
  await page.goto(`/patient/renew/${renewalId}/result`);
  await page.getByTestId("book-follow-up-link").click();
  await expect(page.getByTestId("follow-up-status")).toBeVisible();
  const select = page.getByLabel(/Choose a visit time/);
  const firstValue = await select.locator("option").first().getAttribute("value");
  expect(firstValue).toBeTruthy();
  await select.selectOption(firstValue!);
  await page.getByRole("button", { name: "Book visit" }).click();
  await expect(page.getByTestId("visit-booked")).toBeVisible();
  await expect(page.getByTestId("booking-form")).toHaveCount(0);

  const visitTypes = await streamTypes(`visit-fu-${renewalId}`);
  expect(visitTypes).toEqual(["VisitBooked"]);
  const renewalTypes = await streamTypes(`renewal-${renewalId}`);
  expect(renewalTypes).not.toContain("RenewalApproved");
  // The patient's status page does not say approved.
  await page.goto("/patient/status");
  await expect(page.getByTestId(`renewal-${renewalId}`)).not.toContainText(/approved/i);
});

test("another patient and a clinician cannot open the booking page", async ({ page, context }) => {
  await loginAs(context, "patient", DEMO_SUBJECTS.patient);
  await page.goto(`/patient/follow-up/${renewalId}`);
  await expect(page).toHaveURL(/error=NOT_FOUND/);
  // A clinician cannot use the patient page at all (server-side RBAC).
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/patient/follow-up/${renewalId}`);
  await expect(page).toHaveURL(/\/forbidden/);
});
