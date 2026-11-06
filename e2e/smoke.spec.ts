import { expect, test } from "@playwright/test";

test("home page renders with the synthetic-data banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CareLoop" })).toBeVisible();
  await expect(page.getByTestId("synthetic-banner")).toContainText("Synthetic data only");
});
