import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { resetAndSeedDb } from "./support/db";
import { loginAs, submitRenewalAsPatient } from "./support/clinician";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("RBAC: anonymous -> login, patient/pharmacist -> forbidden, admin read-only, clinician sees queue", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto("/clinician/queue");
  await expect(page).toHaveURL(/\/login$/);
  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto("/clinician/queue");
  await expect(page).toHaveURL(/\/forbidden$/);
  await loginAs(context, "pharmacist", DEMO_SUBJECTS.pharmacist);
  await page.goto("/clinician/queue");
  await expect(page).toHaveURL(/\/forbidden$/);
  await page.goto("/clinician/renewals/anything");
  await expect(page).toHaveURL(/\/forbidden$/);
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/clinician/queue");
  await expect(page.getByTestId("read-only-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open and start review" })).toHaveCount(0);
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/queue");
  await expect(page.getByRole("heading", { name: "Clinician queue" })).toBeVisible();
});

test("seeded history: approved renewals are completed; an unevaluated check-in is visible as Awaiting evaluation", async ({
  page,
  context,
}) => {
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/queue");
  const done = page.locator("li[data-status='completed']");
  await expect(done).toHaveCount(2);
  await expect(page.getByTestId("queue-item-renewal-refill-limit-1")).toContainText("fluoxetine");
  // Seeded prior-phq9 renewal has a check-in but was never evaluated: open, labelled, not hidden.
  const awaiting = page.getByTestId("queue-item-renewal-prior-phq9-1");
  await expect(awaiting).toHaveAttribute("data-awaiting-evaluation", "true");
  await expect(awaiting).toHaveAttribute("data-status", "requested");
  await expect(awaiting.getByTestId("awaiting-badge")).toContainText("Awaiting evaluation");
});

test("item-9 check-in: pipeline escalates (no AI key => fail closed), queue shows it first with reason codes; opening starts review", async ({
  page,
  context,
}) => {
  const renewalId = await submitRenewalAsPatient(page, context, {
    patientId: DEMO_PATIENT_ID,
    lastName: DEMO_PATIENT_IDENTITY.lastName,
    dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });
  // The patient sees "under review" from the real projections.
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );

  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto("/clinician/queue");
  const item = page.getByTestId(`queue-item-${renewalId}`);
  await expect(item).toHaveAttribute("data-status", "requested");
  await expect(item).toHaveAttribute("data-escalated", "true");
  await expect(item.getByTestId("escalated-badge")).toContainText("open until a clinician acts");
  await expect(item.locator("[data-reason-code='PHQ9_ITEM9_POSITIVE']")).toBeVisible();
  await expect(item.locator("[data-reason-code='LLM_FAILURE']")).toBeVisible();
  await expect(item).toHaveAttribute("data-awaiting-evaluation", "false");
  // Escalated first within the requested list.
  const first = page.locator("ul[aria-label='Requested renewals'] > li").first();
  await expect(first).toHaveAttribute("data-escalated", "true");

  // Opening the item calls StartReview: it moves to in-progress.
  await item.getByRole("button", { name: "Open and start review" }).click();
  await expect(page).toHaveURL(new RegExp(`/clinician/renewals/${renewalId}$`));
  await expect(page.getByTestId("review-panel")).toHaveAttribute("data-review-state", "started");
  await page.goto("/clinician/queue");
  await expect(page.getByTestId(`queue-item-${renewalId}`)).toHaveAttribute(
    "data-status",
    "in-progress",
  );
  // Still escalated and still open (not completed) until a clinician decides.
  await expect(page.getByTestId(`queue-item-${renewalId}`)).toHaveAttribute(
    "data-escalated",
    "true",
  );
  // The patient still sees under review.
  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto(`/patient/renew/${renewalId}/result`);
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "under_review",
  );
});
