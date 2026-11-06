import { expect, test, type Page } from "@playwright/test";

async function switchTo(page: Page, role: string) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /demo auth/i })).toBeVisible();
  await page.getByRole("button", { name: `Continue as ${role}` }).click();
  await page.waitForURL((u) => u.pathname !== "/login");
}

test("unauthenticated users are sent to the role switcher", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  const res = await page.request.get("/api/auth/whoami");
  expect(res.status()).toBe(401);
});

test("patient cannot open the clinician queue", async ({ page }) => {
  await switchTo(page, "patient");
  await expect(page).toHaveURL(/\/patient\/renew$/);
  await page.goto("/clinician/queue");
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByRole("heading", { name: /403/ })).toBeVisible();
  const res = await page.request.get("/api/auth/whoami");
  expect((await res.json()).role).toBe("patient");
});

test("admin can open /admin; other roles reach only their own pages", async ({ page }) => {
  await switchTo(page, "admin");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await switchTo(page, "clinician");
  await expect(page.getByRole("heading", { name: "Clinician queue" })).toBeVisible();
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/forbidden$/);
  await switchTo(page, "pharmacist");
  await expect(page.getByRole("heading", { name: "Pharmacist inbox" })).toBeVisible();
});

test("cookie is httpOnly + lax and a tampered cookie is rejected", async ({ page, context }) => {
  await switchTo(page, "patient");
  const c = (await context.cookies()).find((x) => x.name === "careloop_demo_session")!;
  expect(c.httpOnly).toBe(true);
  expect(c.sameSite).toBe("Lax");
  const [v, payload, sig] = c.value.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
      role: "admin",
    }),
  ).toString("base64url");
  await context.addCookies([{ ...c, value: `${v}.${forged}.${sig}` }]);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/whoami")).status()).toBe(401);
  await context.addCookies([{ ...c, value: "garbage" }]);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login$/);
});
