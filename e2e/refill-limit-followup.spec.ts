// F053 / E2E (d): refill limit -> follow-up needed -> patient books -> clinician signs the note ->
// follow-up Task and calendar slot are visible -> the next renewal is no longer held at the limit.
// The rules path is real (seeded patient-refill-limit has 2 approved renewals since the last
// signed visit, REFILL_LIMIT=2). The app server must run with RISK_FIXTURE=synthetic-handwritten
// (development) so the AI step answers "no signals" instead of failing closed: with no API key,
// R13 LLM_FAILURE escalation would outrank the R06 follow-up. Production keeps failing closed.
import { expect, test } from "@playwright/test";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";
import { seededIdentity, streamTypes } from "./support/followup";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(
  process.env.RISK_FIXTURE !== "synthetic-handwritten" || !process.env.VISIT_CLOCK_OFFSET_DAYS,
  "needs RISK_FIXTURE=synthetic-handwritten and VISIT_CLOCK_OFFSET_DAYS=60 on the app server " +
    "(the dev/test-only clock offset lets a booked visit count as started; production ignores it)",
);

const PATIENT = "patient-refill-limit";
const RX = "rx-refill-limit-fluoxetine";
let renewalId = "";
let visitId = "";

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("1. new renewal at the refill limit -> follow-up needed (not approved)", async ({
  page,
  context,
}) => {
  const who = await seededIdentity(PATIENT);
  renewalId = await submitRenewalAsPatient(page, context, {
    patientId: PATIENT,
    lastName: who.lastName,
    dateOfBirth: who.dateOfBirth,
    prescriptionId: RX,
  });
  visitId = `fu-${renewalId}`;
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "follow_up_needed",
  );
  expect(await streamTypes(`renewal-${renewalId}`)).toContain("FollowUpRequired");
});

test("2. the patient books a visit", async ({ page, context }) => {
  await loginAs(context, "patient", PATIENT);
  await page.goto(`/patient/follow-up/${renewalId}`);
  const select = page.getByLabel(/Choose a visit time/);
  await select.selectOption({ index: 0 });
  await page.getByRole("button", { name: "Book visit" }).click();
  await expect(page.getByTestId("visit-booked")).toBeVisible();
  expect(await streamTypes(`visit-${visitId}`)).toEqual(["VisitBooked"]);
  expect(await streamTypes(`renewal-${renewalId}`)).not.toContain("RenewalApproved");
});

test("3. the clinician sees the booked visit and signs the note: Task and calendar slot appear", async ({
  page,
  context,
}) => {
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/visits");
  const visit = page.getByTestId(`visit-${visitId}`);
  await expect(visit).toHaveAttribute("data-status", "booked");
  // Before signing there is no task and no calendar slot for this visit.
  await expect(page.getByTestId(`task-fu-${visitId}`)).toHaveCount(0);
  await expect(page.getByTestId(`slot-slot-${visitId}`)).toHaveCount(0);

  await visit.getByRole("button", { name: "Sign visit note" }).click();
  await expect(page.getByTestId(`visit-${visitId}`)).toHaveAttribute("data-status", "note_signed");
  await expect(page.getByTestId(`visit-${visitId}`).getByRole("button")).toHaveCount(0);

  // FHIR-Task-style: status "requested". Calendar slot visible.
  const task = page.getByTestId(`task-fu-${visitId}`);
  await expect(task).toBeVisible();
  await expect(task).toHaveAttribute("data-status", "requested");
  await expect(task).toContainText(PATIENT);
  await expect(page.getByTestId(`slot-slot-${visitId}`)).toBeVisible();

  expect(await streamTypes(`visit-${visitId}`)).toEqual([
    "VisitBooked",
    "VisitNoteSigned",
    "CalendarSlotCreated",
  ]);
  expect(await streamTypes(`task-fu-${visitId}`)).toEqual(["FollowUpTaskCreated"]);

  // A reload (the retry/idempotency path of the UI) neither duplicates the task nor the slot.
  await page.reload();
  await expect(page.getByTestId("task-list").locator("li[data-testid^='task-']")).toHaveCount(1);
  await expect(page.getByTestId("slot-list").locator("li[data-testid^='slot-']")).toHaveCount(1);
});

test("4. an admin sees the visit but cannot sign", async ({ page, context }) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/clinician/visits");
  await expect(page.getByTestId(`visit-${visitId}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign visit note" })).toHaveCount(0);
});

test("5. after the signed note the counter reset: the next renewal is not held at the limit", async ({
  page,
  context,
}) => {
  const who = await seededIdentity(PATIENT);
  const next = await submitRenewalAsPatient(page, context, {
    patientId: PATIENT,
    lastName: who.lastName,
    dateOfBirth: who.dateOfBirth,
    prescriptionId: RX,
  });
  expect(next).not.toBe(renewalId);
  const result = page.getByTestId("renewal-result");
  await expect(result).not.toHaveAttribute("data-result-state", "follow_up_needed");
  await expect(result).toHaveAttribute("data-result-state", "under_review");
  const types = await streamTypes(`renewal-${next}`);
  expect(types).not.toContain("FollowUpRequired");
  expect(types).toContain("EligibilityEvaluated");
  expect(types).not.toContain("RenewalApproved");
});
