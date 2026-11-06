// F057: /admin/audit renders FHIR AuditEvent-shaped JSON with a chain-status badge. Admin only.
// Tampering is simulated through a privileged raw connection (append-only trigger disabled), the
// thing a database superuser could do; the badge must then report the first broken seq.
import { expect, test } from "@playwright/test";
import { DEMO_SUBJECTS } from "../src/infra/auth/session";
import { e2eSql, loginAs } from "./support/clinician";
import { resetAndSeedDb } from "./support/db";

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(async () => {
  await resetAndSeedDb();
});

test("admin sees AuditEvent-shaped JSON and an intact chain badge", async ({ page, context }) => {
  await loginAs(context, "admin", DEMO_SUBJECTS.admin);
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  const badge = page.getByTestId("chain-status");
  await expect(badge).toHaveAttribute("data-chain-valid", "true");
  await expect(badge).toContainText("Chain intact");

  const first = page.getByTestId("audit-list").locator("li[data-testid^='audit-']").first();
  const json = JSON.parse(await first.locator("pre").innerText()) as Record<string, unknown>;
  expect(json.resourceType).toBe("AuditEvent");
  expect(typeof json.recorded).toBe("string");
  expect(Number.isNaN(Date.parse(json.recorded as string))).toBe(false);
  expect(json.outcome).toBe("0");
  expect(Array.isArray(json.agent)).toBe(true);
  expect(Array.isArray(json.entity)).toBe(true);
  const agent = (
    json.agent as { who: { identifier: { value: string } }; role: { text: string }[] }[]
  )[0]!;
  expect(agent.who.identifier.value.length).toBeGreaterThan(0);
  expect(agent.role[0]!.text.length).toBeGreaterThan(0);
});

test("only admins can open the audit page", async ({ page, context }) => {
  for (const role of ["clinician", "patient", "pharmacist"] as const) {
    await loginAs(context, role, DEMO_SUBJECTS[role]);
    await page.goto("/admin/audit");
    await expect(page).toHaveURL(/\/forbidden/);
  }
  await context.clearCookies();
  await page.goto("/admin/audit");
  await expect(page).toHaveURL(/\/login/);
});

test("a tampered audit row flips the badge and names the broken seq", async ({ page, context }) => {
  const sql = e2eSql();
  try {
    const [row] = await sql<{ seq: string; actor: string }[]>`
      SELECT seq, actor FROM audit_log ORDER BY seq LIMIT 1 OFFSET 5`;
    await sql.unsafe(`ALTER TABLE audit_log DISABLE TRIGGER USER`);
    try {
      await sql`UPDATE audit_log SET actor = 'mallory' WHERE seq = ${row!.seq}`;
      await loginAs(context, "admin", DEMO_SUBJECTS.admin);
      await page.goto("/admin/audit");
      const badge = page.getByTestId("chain-status");
      await expect(badge).toHaveAttribute("data-chain-valid", "false");
      await expect(badge).toContainText("TAMPER DETECTED");
      await expect(badge).toContainText(`seq ${row!.seq}`);
    } finally {
      await sql`UPDATE audit_log SET actor = ${row!.actor} WHERE seq = ${row!.seq}`;
      await sql.unsafe(`ALTER TABLE audit_log ENABLE TRIGGER USER`);
    }
    await page.reload();
    await expect(page.getByTestId("chain-status")).toHaveAttribute("data-chain-valid", "true");
  } finally {
    await sql.end();
  }
});
