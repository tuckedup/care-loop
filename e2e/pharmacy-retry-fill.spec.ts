// F050: approved renewal -> outbox -> mock pharmacy answers a retryable error, then OK + RxFill.
// Requires the app server to run with MOCK_PHARMACY_FORCE=retry-then-fill and a CRON_SECRET
// (the worker is driven through the real cron route).
import { expect, test } from "@playwright/test";
import { DEMO_PATIENT_ID, DEMO_PATIENT_IDENTITY } from "../src/domain/seed";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { e2eSql, loginAs, submitRenewalAsPatient } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial", timeout: 120_000 });
test.skip(
  process.env.MOCK_PHARMACY_FORCE !== "retry-then-fill" || !process.env.CRON_SECRET,
  "needs MOCK_PHARMACY_FORCE=retry-then-fill and CRON_SECRET on the app server",
);

let renewalId = "";
const cron = { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` };

test.beforeAll(async () => {
  await resetAndSeedDb();
});

async function patientStatus(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
) {
  await loginAs(context, "patient", DEMO_PATIENT_ID);
  await page.goto("/patient/status");
  return page.getByTestId(`renewal-${renewalId}`);
}

test("clinician approval queues the transmission; the patient sees it is being sent", async ({
  page,
  context,
}) => {
  renewalId = await submitRenewalAsPatient(page, context, {
    patientId: DEMO_PATIENT_ID,
    lastName: DEMO_PATIENT_IDENTITY.lastName,
    dateOfBirth: DEMO_PATIENT_IDENTITY.dateOfBirth,
    prescriptionId: "rx-demo-buspirone",
    score: 1,
  });
  await loginAs(context, "clinician", DEMO_SUBJECTS.clinician);
  await page.goto(`/clinician/renewals/${renewalId}`);
  await page.getByRole("button", { name: "Start review" }).click();
  const panel = page.getByTestId("review-panel");
  await expect(panel).toHaveAttribute("data-review-state", "started");
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(panel).toHaveAttribute("data-review-state", "decided");

  const item = await patientStatus(page, context);
  await expect(item).toHaveAttribute("data-status", "queued");
  await expect(item.getByTestId("renewal-status")).toHaveText("Approved: sending to pharmacy");
});

test("worker pass 1: retryable pharmacy error, patient sees the problem; backoff holds it back", async ({
  page,
  context,
  request,
}) => {
  const res = await request.get("/api/cron/outbox", { headers: cron });
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({ claimed: 1, retried: 1, done: 0, dead: 0 });
  // The retry is scheduled with backoff: pending, one attempt used, due strictly later.
  const sql = e2eSql();
  try {
    const [o] = await sql<{ status: string; attempts: number; later: boolean }[]>`
      SELECT status, attempts, next_attempt_at > updated_at AS later FROM outbox
      WHERE idempotency_key = ${"rx-renewal:" + renewalId}`;
    expect(o).toMatchObject({ status: "pending", attempts: 1, later: true });
  } finally {
    await sql.end();
  }

  const item = await patientStatus(page, context);
  await expect(item).toHaveAttribute("data-status", "pharmacy_error");
  await expect(item.getByTestId("renewal-status")).toContainText("Pharmacy problem");
});

test("worker retry: pharmacy answers OK + RxFill, the patient sees Filled", async ({
  page,
  context,
  request,
}) => {
  let done = 0;
  await expect
    .poll(
      async () => {
        const r = await (await request.get("/api/cron/outbox", { headers: cron })).json();
        done += r.done as number;
        return done;
      },
      { timeout: 30_000, intervals: [500, 1000, 1000] },
    )
    .toBe(1);
  const item = await patientStatus(page, context);
  await expect(item).toHaveAttribute("data-status", "filled");
  await expect(item.getByTestId("renewal-status")).toHaveText("Filled");

  const sql = e2eSql();
  try {
    const rows = await sql<{ type: string }[]>`
      SELECT type FROM events WHERE stream_id = ${"renewal-" + renewalId}
        AND type IN ('RxRenewalQueued','PharmacyErrorReceived','RxRenewalTransmitted',
                     'PharmacyStatusReceived','RxFillReceived')
      ORDER BY stream_version`;
    expect(rows.map((r) => r.type)).toEqual([
      "RxRenewalQueued",
      "PharmacyErrorReceived",
      "RxRenewalTransmitted",
      "PharmacyStatusReceived",
      "RxFillReceived",
    ]);
    const [o] = await sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM outbox WHERE idempotency_key = ${"rx-renewal:" + renewalId}`;
    expect(o).toMatchObject({ status: "done", attempts: 2 });
  } finally {
    await sql.end();
  }

  // Further worker passes do nothing: the same key is never sent again.
  const idle = await (await request.get("/api/cron/outbox", { headers: cron })).json();
  expect(idle).toMatchObject({ claimed: 0 });
});
