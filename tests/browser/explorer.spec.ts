import { test, expect } from "@playwright/test";

test("runs a separately registered library workspace without GPU assumptions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "City Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Library circulation", exact: true })
    .click();
  await page.getByRole("button", { name: "Calculate availability" }).click();
  await expect(page.getByRole("status")).toContainText("1 available books");
  await expect(page.getByRole("status")).toContainText("Alex Rivers");
});

test("queues a durable investigation and explicitly cancels it in operations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Launch operations" }).click();
  await expect(page.getByTestId("recommendation")).toBeVisible();
  await page
    .getByRole("button", { name: "Queue investigation", exact: true })
    .click();
  await page.getByRole("button", { name: "Operations console" }).click();
  await page
    .getByRole("button", { name: "Jobs & refresh", exact: true })
    .click();
  await expect(page.locator(".jobs-panel")).toContainText("Worker paused");
  const job = page
    .locator(".job-record")
    .filter({ hasText: "investigation · queued" })
    .first();
  const id = await job.locator("code").textContent();
  await job.getByRole("button", { name: "Cancel job" }).click();
  await expect(
    page.locator(".job-record").filter({ hasText: id! }),
  ).toContainText("investigation · cancelled");
});

test("explains a recovery with captured source records and native dependency paths", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Launch operations" }).click();
  const evidence = page.locator(".decision-evidence");
  await evidence
    .getByRole("button", { name: "Explain this recommendation" })
    .click();
  await expect(
    evidence.getByText("Captured calculation inputs", { exact: true }),
  ).toBeVisible();
  await expect(
    evidence.getByText("Rule launch.rank.v1", { exact: true }),
  ).toBeVisible();
  await evidence
    .locator(".decision-targets button")
    .filter({ hasText: "Meridian Packaging" })
    .click();
  await expect(
    evidence.getByRole("list", { name: "Evidence dependency path" }),
  ).toContainText("REQUIRES");
  await expect(evidence.locator(".decision-record")).toContainText("meridian");
  await expect(
    evidence
      .locator(".decision-record dl>div")
      .filter({ has: page.locator("dt", { hasText: "leadDays" }) }),
  ).toContainText("7");
  await page.getByLabel("Meridian lead days").fill("14");
  await page.getByRole("button", { name: "Evaluate scenario" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Expedite Northstar Packaging",
  );
  await evidence
    .getByRole("button", { name: "Explain this recommendation" })
    .click();
  await evidence
    .locator(".decision-targets button")
    .filter({ hasText: "Meridian Packaging" })
    .click();
  await expect(
    evidence
      .locator(".decision-record dl>div")
      .filter({ has: page.locator("dt", { hasText: "leadDays" }) }),
  ).toContainText("14");
  await expect(
    evidence.getByText("Scenario v1", { exact: true }),
  ).toBeVisible();
  await evidence.screenshot({ path: "/tmp/graph-decision-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    evidence.getByRole("heading", { name: "Why this recovery?" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await evidence.screenshot({ path: "/tmp/graph-decision-mobile.png" });
});

test("recalculates an older graph revision without changing the live recovery", async ({
  page,
}) => {
  const baseline = await (
    await page.request.get("/api/ontologies/semiconductor/graph")
  ).json();
  await page.request.patch("/api/ontologies/semiconductor/objects/meridian", {
    data: { properties: { leadDays: 14 }, expectedRevision: baseline.revision },
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Launch operations" }).click();
    await expect(page.getByTestId("recommendation")).toContainText(
      "Expedite Northstar Packaging",
    );
    const commits = await (
      await page.request.get("/api/ontologies/semiconductor/commits")
    ).json();
    const index = commits.items.findIndex(
      (c: { revision: number }) => c.revision === baseline.revision,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const slider = page.getByLabel("Historical revision");
    await slider.focus();
    await slider.press("Home");
    for (let i = 0; i < index; i++) await slider.press("ArrowRight");
    await page
      .getByRole("button", {
        name: `Inspect revision ${baseline.revision}`,
        exact: true,
      })
      .click();
    await expect(
      page.getByText(`Read-only · revision ${baseline.revision}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("recommendation")).toContainText(
      "Meridian Packaging",
    );
    await expect(page.getByLabel("Meridian lead days")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Evaluate scenario" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Prepare GitHub recovery issue" }),
    ).toHaveCount(0);
    expect(
      (
        await (
          await page.request.get(
            "/api/ontologies/semiconductor/objects/meridian",
          )
        ).json()
      ).properties.leadDays,
    ).toBe(14);
    await page
      .getByRole("button", { name: "Return to live", exact: true })
      .click();
    await expect(page.getByTestId("recommendation")).toContainText(
      "Expedite Northstar Packaging",
    );
    await expect(page.getByLabel("Meridian lead days")).toBeEnabled();
    await page
      .locator(".history-timeline")
      .screenshot({ path: "/tmp/graph-history.png" });
  } finally {
    await page.request.patch("/api/ontologies/semiconductor/objects/meridian", {
      data: { properties: { leadDays: 7 } },
    });
  }
});

test("previews history retention and requires explicit confirmation while protecting a read pin", async ({
  page,
}) => {
  const status = await (
    await page.request.get("/api/ontologies/semiconductor/history")
  ).json();
  const pin = await (
    await page.request.post("/api/ontologies/semiconductor/snapshots", {
      data: { revision: status.retainedFrom, ttlSeconds: 300 },
    })
  ).json();
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Operations console" }).click();
    await page
      .getByRole("button", { name: "History & retention", exact: true })
      .click();
    await page
      .getByLabel("Retain revisions from")
      .fill(String(status.revision));
    await page
      .getByRole("button", { name: "Preview history pruning", exact: true })
      .click();
    const panel = page.locator(".retention-panel");
    await expect(
      panel.getByRole("heading", { name: "Review retention plan" }),
    ).toBeVisible();
    await expect(panel).toContainText(
      `Snapshot at revision ${status.retainedFrom}`,
    );
    const prune = panel.getByRole("button", { name: "Prune reviewed batch" });
    await expect(prune).toBeDisabled();
    await panel.getByLabel("Confirm history pruning").check();
    await expect(prune).toBeEnabled();
    await panel.getByLabel("Confirm history pruning").uncheck();
    await page.getByRole("button", { name: "Preview orphan graphs" }).click();
    await expect(
      page
        .locator(".operation-card")
        .filter({
          has: page.getByRole("heading", {
            name: "Native branch graph retention",
          }),
        }),
    ).toContainText("unreferenced");
    await panel.screenshot({ path: "/tmp/graph-retention.png" });
    expect(
      (
        await (
          await page.request.get("/api/ontologies/semiconductor/history")
        ).json()
      ).revision,
    ).toBe(status.revision);
  } finally {
    await page.request.delete(
      `/api/ontologies/semiconductor/snapshots/${pin.id}`,
    );
  }
});

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

test("reopens an SDK-created revision overlay and recalculates its recovery independently", async ({
  page,
}) => {
  const id = "browser-overlay";
  const created = await page.request.post(
    "/api/ontologies/semiconductor/scenarios",
    { data: { id, name: "Pinned overlay test", strategy: "overlay" } },
  );
  expect(created.ok()).toBe(true);
  try {
    const patched = await page.request.patch(
      `/api/ontologies/semiconductor/scenarios/${id}/objects/meridian`,
      { data: { expectedVersion: 0, properties: { leadDays: 14 } } },
    );
    expect(patched.ok()).toBe(true);
    await page.goto("/");
    await page.getByRole("button", { name: "Launch operations" }).click();
    await page.getByLabel("Saved scenario").selectOption(id);
    await expect(page.getByTestId("recommendation")).toContainText(
      "Expedite Northstar Packaging",
    );
    await page
      .locator(".decision-evidence")
      .getByRole("button", { name: "Explain this recommendation" })
      .click();
    await expect(
      page
        .locator(".decision-evidence")
        .getByText("Captured calculation inputs", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Saved scenario").selectOption("");
    await expect(page.getByTestId("recommendation")).toContainText(
      "Meridian Packaging",
    );
  } finally {
    await page.request.delete(`/api/ontologies/semiconductor/scenarios/${id}`);
  }
});

test("reviews imported native relationship counts before applying a library source", async ({
  page,
}) => {
  const sourceId = "browser-linked-books";
  const registered = await page.request.post(
    "/api/ontologies/library/sources",
    {
      data: {
        id: sourceId,
        name: "Books with author references",
        connector: "json",
        mapping: {
          type: "Book",
          idField: "id",
          objectIdField: "id",
          properties: {
            name: { field: "name" },
            status: { value: "available" },
          },
          relationships: [
            {
              id: "author",
              type: "WRITTEN_BY",
              target: { objectId: { value: "author-1" } },
            },
          ],
        },
      },
    },
  );
  expect(registered.ok()).toBe(true);
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "City Library" }).click();
    await page.getByRole("button", { name: "Operations console" }).click();
    const card = page.locator(".operation-card").filter({
      has: page.getByRole("heading", {
        name: "Books with author references",
      }),
    });
    await expect(card).toContainText("Upload source");
    const chooser = page.waitForEvent("filechooser");
    await card.getByRole("button", { name: "Preview sync" }).click();
    await (
      await chooser
    ).setFiles({
      name: "books.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify([{ id: "book-imported", name: "Mapped author" }]),
      ),
    });
    await expect(page.getByLabel("Relationship changes")).toContainText(
      "Links: 1 additions",
    );
    await page.getByRole("button", { name: "Apply reviewed snapshot" }).click();
    await expect(page.getByRole("status")).toContainText("committed together");
    const state = await (
      await page.request.get("/api/ontologies/library/graph")
    ).json();
    expect(
      state.relationships.some(
        (r: { from: string; to: string }) =>
          r.from === "book-imported" && r.to === "author-1",
      ),
    ).toBe(true);
  } finally {
    await page.request.post(
      `/api/ontologies/library/sources/${sourceId}/sync`,
      { data: { content: "[]" } },
    );
  }
});

test("shows connection setup guidance and refreshes the recorded failure without staging stale data", async ({
  page,
}) => {
  await page.request.post("/api/ontologies/library/sources", {
    data: {
      id: "browser-missing-notion",
      name: "Notion connection setup",
      connector: "notion",
      connection: "unconfigured",
      mapping: {
        type: "Book",
        idField: "id",
        properties: { name: { field: "name" }, status: { value: "available" } },
      },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "City Library" }).click();
  await page.getByRole("button", { name: "Operations console" }).click();
  const card = page.locator(".operation-card").filter({
    has: page.getByRole("heading", { name: "Notion connection setup" }),
  });
  await expect(card).toContainText("Connection needs setup");
  await card.getByText("Connection and sync guidance").click();
  await expect(card).toContainText(
    "Share the data source with the integration",
  );
  await card.getByRole("button", { name: "Preview sync" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Source connection is not configured",
  );
  await expect(card).toContainText("Last recorded attempt: failed");
  await expect(
    page.getByRole("button", { name: "Apply reviewed snapshot" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/graph-source-status.png",
    fullPage: true,
  });
});
