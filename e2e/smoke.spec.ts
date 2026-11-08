import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("home page renders with the synthetic-data banner", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A clearer loop for prescription renewals." }),
  ).toBeVisible();
  await expect(page.getByTestId("synthetic-banner")).toContainText("Synthetic data only");
  await expect(page.getByRole("link", { name: "Explore the synthetic demo" })).toHaveAttribute(
    "href",
    "/login",
  );
});

test("demo entry point opens the patient workspace", async ({ page }) => {
  await page.goto("/");
  const captureScreenshot = process.env.CAPTURE_DEMO_SCREENSHOT === "true";
  if (captureScreenshot) {
    await mkdir("docs/assets", { recursive: true });
    await page.screenshot({ path: "docs/assets/careloop-home.png", fullPage: true });
  }
  await page.getByRole("link", { name: "Explore the synthetic demo" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Continue as patient" })).toBeVisible();
  if (captureScreenshot) {
    await page.screenshot({ path: "docs/assets/careloop-demo-roles.png", fullPage: true });
  }
  await page.getByRole("button", { name: "Continue as patient" }).click();
  await expect(page).toHaveURL(/\/patient\/renew$/);
  await expect(page.getByRole("heading", { name: "Patient renewal" })).toBeVisible();
  await expect(page.getByText("Choose a current medication to renew.")).toBeVisible();
  if (captureScreenshot) {
    await page.screenshot({ path: "docs/assets/careloop-patient-demo.png", fullPage: true });
  }
});

test("demo entry point works at mobile width and by keyboard", async ({ page }) => {
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Explore the synthetic demo" })).toBeFocused();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBe(false);
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
});
