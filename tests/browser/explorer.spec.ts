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
  await expect(page.locator(".react-flow__node")).toHaveCount(13);
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

test("changes the GPU recovery decision through an isolated scenario", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Launch operations" }).click();
  await expect(
    page.getByRole("heading", { name: "Can Aquila X900 launch on time?" }),
  ).toBeVisible();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Meridian Packaging",
  );
  await page.getByLabel("Meridian lead days").fill("14");
  await page.getByRole("button", { name: "Evaluate scenario" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Expedite Northstar Packaging",
  );
  await expect(page.locator(".scenario-diff")).toContainText("leadDays");
  await expect(page.getByTestId("ready-days")).toHaveText("20 days");
  const live = await page.request.get(
    "/api/ontologies/semiconductor/objects/meridian",
  );
  expect((await live.json()).properties.leadDays).toBe(7);
  await page.screenshot({
    path: "/tmp/graph-launch-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Reset to live" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Meridian Packaging",
  );
});

test("makes driver recovery change the selected release and stays usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Launch operations" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Meridian Packaging",
  );
  await page.getByLabel("Driver repair days").fill("20");
  await page.getByRole("button", { name: "Evaluate scenario" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "use validated Driver 26.09",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/graph-launch-mobile.png",
    fullPage: true,
  });
});
