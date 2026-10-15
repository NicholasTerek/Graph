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
  await expect(page.locator(".react-flow__node")).toHaveCount(14);
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

test("records an investigation and prepares a separately approved action", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Launch operations" }).click();
  await expect(page.getByTestId("recommendation")).toBeVisible();
  await page.getByRole("button", { name: "Investigate through tools" }).click();
  await expect(page.locator(".investigation-result")).toContainText(
    "completed · deterministic-tools",
  );
  await expect(page.locator(".tool-chips")).toContainText("run_function");
  await page
    .getByRole("button", { name: "Prepare GitHub recovery issue" })
    .click();
  await expect(page.locator(".proposal-preview")).toContainText(
    "Proposed only",
  );
  await page.getByRole("button", { name: "Open action approvals" }).click();
  await page
    .getByRole("button", { name: "Action approvals", exact: true })
    .click();
  await expect(page.locator(".action-review").first()).toContainText(
    "https://github.com/NicholasTerek/Graph/issues",
  );
  await page.getByRole("button", { name: "Approve proposal" }).first().click();
  await expect(
    page.getByRole("button", { name: "Execute approved action" }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Execute approved action" })
    .first()
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "GitHub execution is disabled",
  );
  await page.screenshot({ path: "/tmp/graph-actions.png", fullPage: true });
});

test("previews and applies a source upload through the generic console", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Operations console" }).click();
  const card = page.locator(".operation-card").filter({
    has: page.getByRole("heading", { name: "Packaging operations · CSV" }),
  });
  await expect(card).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await card.getByRole("button", { name: "Preview sync" }).click();
  await (
    await chooser
  ).setFiles({
    name: "suppliers.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "id,name,status,leadDays,dailyCapacity,qualified,riskPoints,costUSD\nnorthstar,Northstar Packaging,delayed,28,300,true,1,0\nmeridian,Meridian Packaging,available,8,300,true,2,65000\n",
    ),
  });
  await expect(page.locator(".sync-review")).toContainText("1 updates");
  await page.getByRole("button", { name: "Apply reviewed snapshot" }).click();
  await expect(page.getByRole("status")).toContainText("committed together");
  expect(
    (
      await (
        await page.request.get("/api/ontologies/semiconductor/objects/meridian")
      ).json()
    ).properties.leadDays,
  ).toBe(8);
  await page.request.patch("/api/ontologies/semiconductor/objects/meridian", {
    data: { properties: { leadDays: 7 } },
  });
});

test("reviews and selectively promotes a hypothetical change into live data", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Launch operations" }).click();
  await expect(page.getByTestId("recommendation")).toBeVisible();
  await page.getByLabel("Meridian lead days").fill("14");
  await page.getByRole("button", { name: "Evaluate scenario" }).click();
  await expect(page.getByTestId("recommendation")).toContainText("Northstar");
  await page.getByRole("button", { name: "Review scenario promotion" }).click();
  await page
    .locator(".promotion-review label")
    .filter({ hasText: "meridian · modified" })
    .getByRole("checkbox")
    .check();
  await page.getByLabel("Confirm live promotion").check();
  await page
    .getByRole("button", { name: "Apply selected changes live" })
    .click();
  await expect(page.locator(".launch-context")).toContainText("Live baseline");
  expect(
    (
      await (
        await page.request.get("/api/ontologies/semiconductor/objects/meridian")
      ).json()
    ).properties.leadDays,
  ).toBe(14);
  await page.request.patch("/api/ontologies/semiconductor/objects/meridian", {
    data: { properties: { leadDays: 7 } },
  });
});
