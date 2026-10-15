import { z } from "zod";
import { defineFunction, type FunctionContext } from "@graph/core";
import type { GraphObject } from "@graph/contracts";
const hardwareSchema = z.object({
  componentId: z.string(),
  componentName: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  expedited: z.boolean(),
  leadDays: z.number(),
  assemblyDays: z.number(),
  readyDays: z.number(),
  costUSD: z.number(),
  riskPoints: z.number(),
});
const planSchema = z.object({
  id: z.string(),
  label: z.string(),
  hardware: z.array(hardwareSchema),
  releaseId: z.string(),
  releaseName: z.string(),
  softwareReadyDays: z.number(),
  hardwareReadyDays: z.number(),
  integrationDays: z.number(),
  readyDays: z.number(),
  delayDays: z.number(),
  costUSD: z.number(),
  riskPoints: z.number(),
  feasible: z.boolean(),
  validation: z.enum(["validated", "repair-and-revalidate"]),
});
export const launchResultSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  deadlineDays: z.number(),
  baseline: planSchema,
  recommendation: planSchema,
  plans: z.array(planSchema),
  blockers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      status: z.string(),
    }),
  ),
  customers: z.array(z.object({ id: z.string(), name: z.string() })),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  evidence: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      properties: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean()]),
      ),
      source: z.string(),
      observedAt: z.string(),
    }),
  ),
  assumptions: z.array(z.string()),
});
export type LaunchResult = z.infer<typeof launchResultSchema>;
export type RecoveryPlan = LaunchResult["recommendation"];
function number(object: GraphObject, key: string) {
  const value = object.properties[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(
      `${object.id}.${key} must be a nonnegative number; reload the updated example dataset`,
    );
  return value;
}
function name(object: GraphObject) {
  return String(object.properties.name ?? object.id);
}
export function calculateLaunch(
  context: FunctionContext,
  input: { productId: string },
): LaunchResult {
  const graph = context.graph;
  const evidence = new Map<string, GraphObject>();
  const remember = (object: GraphObject) => {
    evidence.set(object.id, object);
    return object;
  };
  const related = (id: string, type: string) =>
    graph.related(id, type).map(remember);
  const product = remember(graph.object(input.productId));
  if (product.type !== "Product")
    throw new Error("The selected object must be a Product");
  const launches = related(product.id, "SCHEDULED_FOR");
  if (launches.length !== 1)
    throw new Error("A product must have exactly one launch milestone");
  const deadlineDays = number(launches[0], "daysRemaining");
  const components = related(product.id, "REQUIRES");
  if (!components.length)
    throw new Error("No required hardware components are modeled");
  const primaryReleases = related(product.id, "NEEDS_RELEASE");
  if (primaryReleases.length !== 1)
    throw new Error(
      "A product must have exactly one required software release",
    );
  const releases = [
    primaryReleases[0],
    ...related(primaryReleases[0].id, "FALLBACK"),
  ];
  const integrationDays = number(product, "integrationDays");
  let combinations: RecoveryPlan["hardware"][] = [[]];
  const baselineSupplierIds: string[] = [];
  for (const component of components) {
    const primary = related(component.id, "SUPPLIED_BY");
    if (primary.length !== 1)
      throw new Error(`${component.id} requires exactly one current supplier`);
    baselineSupplierIds.push(primary[0].id);
    const suppliers = [primary[0], ...related(primary[0].id, "ALTERNATIVE")];
    const options: RecoveryPlan["hardware"] = [];
    for (const supplier of suppliers) {
      const assemblyDays = number(component, "assemblyDays");
      const base = {
        componentId: component.id,
        componentName: name(component),
        supplierId: supplier.id,
        supplierName: name(supplier),
        assemblyDays,
      };
      const leadDays = number(supplier, "leadDays");
      options.push({
        ...base,
        expedited: false,
        leadDays,
        readyDays: leadDays + assemblyDays,
        costUSD: number(supplier, "costUSD"),
        riskPoints: number(supplier, "riskPoints"),
      });
      if (supplier.properties.expeditedLeadDays !== undefined) {
        const leadDays = number(supplier, "expeditedLeadDays");
        options.push({
          ...base,
          expedited: true,
          leadDays,
          readyDays: leadDays + assemblyDays,
          costUSD: number(supplier, "expeditedCostUSD"),
          riskPoints: number(supplier, "expeditedRiskPoints"),
        });
      }
    }
    if (combinations.length * options.length * releases.length > 256)
      throw new Error(
        "The example planner supports at most 256 recovery alternatives",
      );
    combinations = combinations.flatMap((combo) =>
      options.map((option) => [...combo, option]),
    );
  }
  const blockers: LaunchResult["blockers"] = [];
  const teams = new Map<string, GraphObject>();
  for (const object of evidence.values())
    if (object.properties.status === "delayed")
      blockers.push({
        id: object.id,
        name: name(object),
        kind: object.type,
        status: String(object.properties.status),
      });
  const plans: RecoveryPlan[] = [];
  for (const release of releases) {
    if (release.properties.architecture !== product.properties.architecture)
      continue;
    const issues = related(release.id, "BLOCKED_BY").filter(
      (i) => i.properties.status !== "resolved",
    );
    const tests = related(release.id, "VALIDATED_BY");
    for (const issue of issues) {
      for (const team of related(issue.id, "OWNED_BY"))
        teams.set(team.id, team);
      if (!blockers.some((b) => b.id === issue.id))
        blockers.push({
          id: issue.id,
          name: name(issue),
          kind: issue.type,
          status: String(issue.properties.status),
        });
    }
    for (const test of tests.filter((t) => t.properties.status === "failed"))
      if (!blockers.some((b) => b.id === test.id))
        blockers.push({
          id: test.id,
          name: name(test),
          kind: test.type,
          status: String(test.properties.status),
        });
    const validated =
      release.properties.status === "validated" &&
      issues.length === 0 &&
      !tests.some((t) => t.properties.status === "failed");
    if (
      !validated &&
      tests.some((t) => t.properties.status === "failed") &&
      issues.length === 0
    )
      throw new Error(
        `Failed tests for ${release.id} have no modeled repair work`,
      );
    const softwareReadyDays = validated
      ? 0
      : Math.max(0, ...issues.map((i) => number(i, "fixDays"))) +
        number(release, "validationDays");
    for (const hardware of combinations) {
      const hardwareReadyDays = Math.max(...hardware.map((h) => h.readyDays));
      const readyDays =
        Math.max(hardwareReadyDays, softwareReadyDays) + integrationDays;
      plans.push({
        id: `${hardware.map((h) => h.supplierId + (h.expedited ? "-expedited" : "")).join("_")}_${release.id}`,
        label: `${hardware.map((h) => (h.expedited ? "Expedite " : "") + h.supplierName).join(" + ")} · ${validated ? "use validated" : "repair"} ${name(release)}`,
        hardware,
        releaseId: release.id,
        releaseName: name(release),
        softwareReadyDays,
        hardwareReadyDays,
        integrationDays,
        readyDays,
        delayDays: Math.max(0, readyDays - deadlineDays),
        costUSD:
          hardware.reduce((sum, h) => sum + h.costUSD, 0) +
          number(release, "repairCostUSD"),
        riskPoints:
          hardware.reduce((sum, h) => sum + h.riskPoints, 0) +
          number(release, "riskPoints"),
        feasible: readyDays <= deadlineDays,
        validation: validated ? "validated" : "repair-and-revalidate",
      });
    }
  }
  const baseline = plans.find(
    (p) =>
      p.releaseId === primaryReleases[0].id &&
      p.hardware.every(
        (h, i) => h.supplierId === baselineSupplierIds[i] && !h.expedited,
      ),
  );
  if (!baseline)
    throw new Error(
      "The required release is incompatible with the product architecture",
    );
  plans.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      (!a.feasible ? a.delayDays - b.delayDays : 0) ||
      a.riskPoints - b.riskPoints ||
      a.costUSD - b.costUSD ||
      a.readyDays - b.readyDays ||
      a.id.localeCompare(b.id),
  );
  const customers = related(launches[0].id, "COMMITS_TO");
  return {
    productId: product.id,
    productName: name(product),
    deadlineDays,
    baseline,
    recommendation: plans[0],
    plans,
    blockers,
    customers: customers.map((o) => ({ id: o.id, name: name(o) })),
    teams: [...teams.values()].map((o) => ({ id: o.id, name: name(o) })),
    evidence: [...evidence.values()].map((o) => ({
      id: o.id,
      type: o.type,
      properties: o.properties,
      source: o.provenance.source,
      observedAt: o.provenance.observedAt,
    })),
    assumptions: [
      "All business data and costs are synthetic. Durations are elapsed days relative to the planning horizon, not calendar-date forecasts.",
      "Hardware delivery and software repair proceed in parallel. Final integration starts after both are ready.",
      "Hardware readiness = supplier lead time + component assembly time. Software readiness = longest linked issue repair + release validation.",
      "A repaired driver must re-run its modeled failed validation gate; predicted completion is not an actual passing test result.",
      "Supplier alternatives are modeled as qualified substitutes. Capacity and qualification constraints are not modeled yet.",
      "Plans rank on-time feasibility first, then lowest modeled risk points, incremental cost, and readiness time. Late plans rank by delay first.",
      "Risk points are explicit synthetic ordinal penalties, not probabilities or measured failure rates.",
    ],
  };
}
export const launchReadiness = defineFunction({
  id: "launch-readiness",
  name: "GPU launch readiness",
  description:
    "Evaluate connected hardware and driver dependencies, enumerate supplier/release alternatives, and rank feasible recovery plans with evidence.",
  ontology: "semiconductor",
  input: z.object({ productId: z.string().min(1) }).strict(),
  output: launchResultSchema,
  execute: calculateLaunch,
});
