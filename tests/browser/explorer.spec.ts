import { test, expect } from "@playwright/test";

test("explores persisted graph evidence and bounded dependencies", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "See how everything connects." }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(14);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Aquila X900" })
    .click();
  await expect(page.locator(".inspector")).toContainText("aquila-x900");
  await expect(page.locator(".inspector")).toContainText("synthetic-demo");
  await page.getByRole("button", { name: "Trace dependencies" }).click();
  await expect(
    page.getByRole("button", { name: "Clear traversal" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(11);
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.screenshot({
    path: "/tmp/graph-explorer-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("switches to a completely different ontology and inspects its schema", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "City Library" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.getByRole("button", { name: "Ontology registry" }).click();
  await expect(
    page.getByRole("heading", { name: "Your domain, defined." }),
  ).toBeVisible();
  await expect(page.locator(".schema-panel")).toContainText("WRITTEN_BY");
  await expect(page.locator(".schema-panel")).toContainText("Book");
});

test("surfaces invalid import errors without changing the graph", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(14);
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"objects":[],"relationships":[{"id":"bad"}]}'),
    });
  await expect(page.getByRole("alert")).toContainText("Invalid request");
  await expect(page.locator(".react-flow__node")).toHaveCount(14);
});

test("keeps the workspace usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Import data" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(14);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/graph-explorer-mobile.png",
    fullPage: true,
  });
});
