import { expect, test } from "@playwright/test";
import { buildSeedPlan, DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { prescribeMedication } from "../src/domain/patient/handlers";
import { getFormularyEntry } from "../src/domain/formulary";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { resetAndSeedDb } from "./support/db";
import { e2eSql, loginAs, submitRenewalAsPatient } from "./support/clinician";

test.describe.configure({ mode: "serial" });

const demo = {
  patientId: DEMO_PATIENT_ID,
  lastName: DEMO_PATIENT_IDENTITY.lastName,
  dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
};
let approveId = "";
let denyId = "";
let bookId = "";

test.beforeAll(async () => {
  await resetAndSeedDb();
  // Dose change: a new sertraline prescription supersedes the old one (old = stopped).
  const sql = e2eSql();
  try {
    const e = getFormularyEntry("sertraline")!;
    await prescribeMedication(
      sql,
      {
        type: "PrescribeMedication",
        prescriptionId: "rx-demo-sertraline-150",
        patientId: DEMO_PATIENT_ID,
        rxcui: e.rxcui!,
        drugName: e.name,
        dose: { amountMg: 150 },
        frequency: { timesPerDay: 1, timing: "morning" },
        sig: "Take 1 tablet daily",
        controlledSchedule: e.controlledSchedule,
        prescriberId: "prescriber-001",
      },
      { actor: "e2e-setup", role: "admin", action: "e2e:PrescribeMedication" },
    );
  } finally {
    await sql.end();
  }
});

test("visit view: meds, sparkline, rule results; buttons disabled with explanation until review starts", async ({
  page,
  context,
}) => {
  approveId = await submitRenewalAsPatient(page, context, {
    ...demo,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/clinician/renewals/${approveId}`);

  // Active vs stopped meds with the dose change flagged.
  const active = page.getByTestId("meds-active");
  const stopped = page.getByTestId("meds-stopped");
  await expect(active.getByTestId("med-rx-demo-sertraline-150")).toContainText("150 mg");
  await expect(active.getByTestId("med-rx-demo-sertraline-150")).toContainText("DOSE CHANGED");
  await expect(active.getByTestId("med-rx-demo-buspirone")).toContainText("Requested for renewal");
  await expect(stopped.getByTestId("med-rx-demo-sertraline")).toContainText("100 mg");
  await expect(active.getByTestId("med-rx-demo-sertraline")).toHaveCount(0);

  // Sparkline: inline SVG with an accessible name and description.
  const svg = page.getByTestId("sparkline-phq9").getByRole("img", { name: /PHQ-9 trend/ });
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAccessibleDescription(/latest 9 of 27/);
  await expect(page.getByTestId("sparkline-gad7").getByRole("img")).toBeVisible();

  // Rule results with ruleId, pass/fail and detail.
  const r07 = page.locator('[data-testid="rule-results"] [data-rule-id="R07"]');
  await expect(r07).toHaveAttribute("data-passed", "false");
  await expect(r07).toContainText("FAIL");
  await expect(r07).toContainText("item 9");
  await expect(page.locator('[data-rule-id="R03"]')).toHaveAttribute("data-passed", "true");

  // Escalation: banner + item-9 reason code always visible.
  await expect(page.getByTestId("escalation-banner")).toContainText("stays OPEN");
  await expect(page.locator('[data-reason-code="PHQ9_ITEM9_POSITIVE"]').first()).toBeVisible();

  // Buttons disabled with an explanation until review is started.
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "not_started");
  for (const name of ["Approve", "Deny", "Book visit"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await expect(page.getByTestId("decision-help")).toContainText("Start the review first");
  await expect(
    panel.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveAccessibleDescription(/Start the review first/);
  await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();
});

test("start review enables the buttons; approve completes the renewal and the patient sees approved", async ({
  page,
  context,
}) => {
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/clinician/renewals/${approveId}`);
  await page.getByRole("button", { name: "Start review" }).click();
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "started");
  await expect(panel.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  // Deny needs a reason.
  await expect(panel.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(panel).toHaveAttribute("data-review-state", "decided");
  await expect(page.getByTestId("visit-status")).toHaveText("completed");
  await expect(panel.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();

  await page.goto("/clinician/queue");
  await expect(page.getByTestId(`queue-item-${approveId}`)).toHaveAttribute(
    "data-status",
    "completed",
  );

  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto(`/patient/renew/${approveId}/result`);
  await expect(page.getByTestId("renewal-result")).toHaveAttribute("data-result-state", "approved");
});

test("deny with a reason: the patient sees follow-up needed", async ({ page, context }) => {
  denyId = await submitRenewalAsPatient(page, context, {
    ...demo,
    prescriptionId: "rx-demo-sertraline-150",
    score: 0,
  });
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/clinician/renewals/${denyId}`);
  await page.getByRole("button", { name: "Start review" }).click();
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "started");
  await panel.getByLabel("Reason for denial").fill("Needs an in-person review first");
  await panel.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(panel).toHaveAttribute("data-review-state", "decided");
  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto(`/patient/renew/${denyId}/result`);
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "follow_up_needed",
  );
});

test("book visit: records the visit and the patient sees follow-up needed", async ({
  page,
  context,
}) => {
  const p = buildSeedPlan(42).patients.find((x) => x.scenario === "prior-phq9")!;
  bookId = await submitRenewalAsPatient(page, context, {
    patientId: p.patientId,
    lastName: p.lastName,
    dateOfBirth: p.dateOfBirth,
    prescriptionId: "rx-prior-phq9-escitalopram",
    score: 0,
  });
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/clinician/renewals/${bookId}`);
  await page.getByRole("button", { name: "Start review" }).click();
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "started");
  await panel.getByLabel("Visit start").fill("2030-01-15T10:00");
  await panel.getByLabel("Visit end").fill("2030-01-15T10:30");
  await panel.getByRole("button", { name: "Book visit", exact: true }).click();
  await expect(panel).toHaveAttribute("data-review-state", "decided");
  await expect(page.getByTestId("visit-history-item")).toContainText("2030-01-15");
  // One DOM element per source id (the booked visit is both a renewal event and a patient visit).
  const ids = await page.locator("[id^='src-']").evaluateAll((els) => els.map((e) => e.id));
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  await loginAs(context, "patient", p.patientId);
  await page.goto(`/patient/renew/${bookId}/result`);
  await expect(page.getByTestId("renewal-result")).toHaveAttribute(
    "data-result-state",
    "follow_up_needed",
  );
});

test("a second clinician cannot decide a renewal another clinician is reviewing", async ({
  page,
  context,
}) => {
  const id = await submitRenewalAsPatient(page, context, {
    ...demo,
    prescriptionId: "rx-demo-buspirone",
    score: 0,
  });
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/clinician/renewals/${id}`);
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByTestId("review-panel")).toHaveAttribute("data-review-state", "started");
  await loginAs(context, "clinician", "clinician-other-002");
  await page.goto(`/clinician/renewals/${id}`);
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "other_reviewer");
  await expect(panel.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByTestId("decision-help")).toContainText("clinician-demo-001");
});

test("admin can view the visit page but every action is disabled", async ({ page, context }) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto(`/clinician/renewals/${approveId}`);
  await expect(page.getByTestId("review-panel")).toHaveAttribute("data-review-state", "read_only");
  await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
});
