import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

test("records the clean synthetic GPU evidence, branch and review story", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.GRAPH_RECORD_DEMO,
    "Opt-in recording with a freshly seeded disposable namespace",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const caption = async (text: string) => {
    await page.evaluate((text) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText =
          "position:fixed;bottom:10px;left:10px;right:10px;padding:12px;background:#08231ff2;color:white;border:1px solid #86d8bd;z-index:10000;font:14px system-ui;pointer-events:none";
        document.body.append(el);
      }
      el.textContent = `Synthetic fixture · deterministic agent · ${text}`;
    }, text);
    // Deliberate reading time in the opt-in recording, not application synchronization.
    await page.waitForTimeout(1000);
  };
  await page.getByRole("button", { name: "Launch operations" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Meridian Packaging",
  );
  const before = await (
    await page.request.get("/api/ontologies/semiconductor/graph")
  ).json();
  expect(before.objects).toHaveLength(14);
  expect(before.relationships).toHaveLength(17);
  await caption(
    "1. The live recommendation uses the current recorded supply and driver inputs.",
  );
  const evidence = page.locator(".decision-evidence");
  await evidence
    .getByRole("button", { name: "Explain this recommendation" })
    .click();
  await evidence
    .locator(".decision-targets button")
    .filter({ hasText: "Meridian Packaging" })
    .click();
  await expect(evidence.locator(".decision-record")).toContainText("meridian");
  await caption(
    "2. Inspect captured supplier records, rules and the native dependency path.",
  );
  await page.getByLabel("Meridian lead days").fill("14");
  await page.getByRole("button", { name: "Evaluate scenario" }).click();
  await expect(page.getByTestId("recommendation")).toContainText("Northstar");
  await expect(page.locator(".scenario-diff")).toContainText("leadDays");
  expect(
    (
      await (
        await page.request.get("/api/ontologies/semiconductor/objects/meridian")
      ).json()
    ).properties.leadDays,
  ).toBe(7);
  await caption(
    "3. A native scenario changes the decision while live supplier lead time remains 7 days.",
  );
  await page.getByRole("button", { name: "Investigate through tools" }).click();
  await expect(page.locator(".investigation-result")).toContainText(
    "completed · deterministic-tools",
  );
  await expect(page.locator(".tool-chips")).toContainText("run_function");
  await caption(
    "4. The deterministic agent records its tool trace and scenario-bound calculation.",
  );
  await page
    .getByRole("button", { name: "Prepare GitHub recovery issue" })
    .click();
  await expect(page.locator(".proposal-preview")).toContainText(
    "Proposed only",
  );
  await caption(
    "5. Prepare an evidence-bound issue proposal. No external issue is sent.",
  );
  await page.getByRole("button", { name: "Review scenario promotion" }).click();
  const review = page.locator(".promotion-review");
  await expect(review).toContainText("meridian · modified");
  await expect(
    page.getByRole("button", { name: "Apply selected changes live" }),
  ).toBeDisabled();
  await caption(
    "6. Selected promotion requires a separate explicit review and confirmation.",
  );
  await page.getByRole("button", { name: "Reset to live" }).click();
  await expect(page.getByTestId("recommendation")).toContainText(
    "Meridian Packaging",
  );
  const after = await (
    await page.request.get("/api/ontologies/semiconductor/graph")
  ).json();
  expect(after).toEqual(before);
  await caption(
    "7. Return to the unchanged live graph. Scenario and audit evidence remain available.",
  );
  const path = testInfo.outputPath("demo-verification.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        fixture: "Synthetic 14-object/17-edge GPU graph, fresh namespace",
        agent: "deterministic-tools",
        liveUnchanged: true,
        capturedEvidenceInspected: true,
        scenarioChangesDecision: true,
        proposalOnly: true,
        externalWrites: 0,
        promotionRequiresReview: true,
      },
      null,
      2,
    ),
  );
});
