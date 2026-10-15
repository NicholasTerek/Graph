import { z } from "zod";
import { defineFunction, type FunctionContext } from "@graph/core";
import type { GraphObject } from "@graph/contracts";
import { scheduleTasks, type Task } from "./schedule.js";
const hardwareSchema = z.object({
  componentId: z.string(),
  componentName: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  expedited: z.boolean(),
  leadDays: z.number(),
  assemblyDays: z.number(),
  productionDays: z.number(),
  requiredUnits: z.number(),
  inventoryUnits: z.number(),
  shortageUnits: z.number(),
  dailyCapacity: z.number(),
  qualified: z.boolean(),
  readyDays: z.number(),
  costUSD: z.number(),
  riskPoints: z.number(),
});
const constraintSchema = z.object({
  code: z.string(),
  message: z.string(),
  passed: z.boolean(),
});
const taskSchema = z.object({
  id: z.string(),
  label: z.string(),
  duration: z.number(),
  dependencies: z.array(z.string()),
  evidence: z.array(z.string()),
  start: z.number(),
  end: z.number(),
  critical: z.boolean(),
});
const planSchema = z.object({
  id: z.string(),
  label: z.string(),
  hardware: z.array(hardwareSchema),
  releaseId: z.string(),
  releaseName: z.string(),
  softwareReadyDays: z.number(),
  hardwareReadyDays: z.number(),
  validationDays: z.number(),
  integrationDays: z.number(),
  readyDays: z.number(),
  delayDays: z.number(),
  costUSD: z.number(),
  riskPoints: z.number(),
  eligible: z.boolean(),
  constraints: z.array(constraintSchema),
  tasks: z.array(taskSchema),
  criticalPath: z.array(z.string()),
  feasible: z.boolean(),
  validation: z.enum(["validated", "repair-and-revalidate"]),
});
export const launchResultSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  demandUnits: z.number(),
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
const name = (object: GraphObject) =>
  String(object.properties.name ?? object.id);
export function calculateLaunch(
  context: FunctionContext,
  input: { productId: string },
): LaunchResult {
  const graph = context.graph;
  const evidence = new Map<string, GraphObject>();
  const remember = (o: GraphObject) => {
    evidence.set(o.id, o);
    return o;
  };
  const related = (id: string, type: string) =>
    graph.related(id, type).map(remember);
  const product = remember(graph.object(input.productId));
  if (product.type !== "Product")
    throw new Error("The selected object must be a Product");
  const launches = related(product.id, "SCHEDULED_FOR");
  if (launches.length !== 1)
    throw new Error("A product must have exactly one launch milestone");
  const deadlineDays = number(launches[0], "daysRemaining"),
    demandUnits = number(product, "demandUnits"),
    featureLevel = number(product, "requiredFeatureLevel"),
    integrationDays = number(product, "integrationDays");
  const components = related(product.id, "REQUIRES");
  if (!components.length)
    throw new Error("No required hardware components are modeled");
  const primary = related(product.id, "NEEDS_RELEASE");
  if (primary.length !== 1)
    throw new Error(
      "A product must have exactly one required software release",
    );
  const releases = [primary[0], ...related(primary[0].id, "FALLBACK")];
  const baselineIds: string[] = [];
  let combinations: RecoveryPlan["hardware"][] = [[]];
  for (const component of components) {
    const suppliers = related(component.id, "SUPPLIED_BY");
    if (suppliers.length !== 1)
      throw new Error(`${component.id} requires exactly one current supplier`);
    baselineIds.push(suppliers[0].id);
    suppliers.push(...related(suppliers[0].id, "ALTERNATIVE"));
    const requiredUnits = demandUnits * number(component, "unitsPerProduct"),
      inventoryUnits = number(component, "inventoryUnits"),
      shortageUnits = Math.max(0, requiredUnits - inventoryUnits),
      assemblyDays = number(component, "assemblyDays");
    const options: RecoveryPlan["hardware"] = [];
    for (const supplier of suppliers) {
      if (shortageUnits === 0 && supplier.id !== suppliers[0].id) continue;
      const dailyCapacity = number(supplier, "dailyCapacity"),
        productionDays =
          shortageUnits > 0 && dailyCapacity > 0
            ? Math.ceil(shortageUnits / dailyCapacity)
            : 0,
        qualified =
          supplier.properties.qualified === true &&
          related(supplier.id, "QUALIFIED_FOR").some(
            (componentType) => componentType.id === component.id,
          );
      for (const expedited of [false, true]) {
        if (shortageUnits === 0 && expedited) continue;
        if (expedited && supplier.properties.expeditedLeadDays === undefined)
          continue;
        const leadDays =
          shortageUnits === 0
            ? 0
            : number(supplier, expedited ? "expeditedLeadDays" : "leadDays");
        options.push({
          componentId: component.id,
          componentName: name(component),
          supplierId: supplier.id,
          supplierName: name(supplier),
          expedited,
          leadDays,
          assemblyDays,
          productionDays,
          requiredUnits,
          inventoryUnits,
          shortageUnits,
          dailyCapacity,
          qualified,
          readyDays: leadDays + productionDays + assemblyDays,
          costUSD:
            shortageUnits === 0
              ? 0
              : number(supplier, expedited ? "expeditedCostUSD" : "costUSD"),
          riskPoints:
            shortageUnits === 0
              ? 0
              : number(
                  supplier,
                  expedited ? "expeditedRiskPoints" : "riskPoints",
                ),
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
  const plans: RecoveryPlan[] = [];
  for (const release of releases) {
    const issues = related(release.id, "BLOCKED_BY").filter(
        (i) => i.properties.status !== "resolved",
      ),
      tests = related(release.id, "VALIDATED_BY");
    for (const issue of issues)
      for (const team of related(issue.id, "OWNED_BY"))
        teams.set(team.id, team);
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
    for (const hardware of combinations) {
      const constraints: RecoveryPlan["constraints"] = [
        {
          code: "architecture",
          message: `${release.id} supports ${String(product.properties.architecture)}`,
          passed:
            release.properties.architecture === product.properties.architecture,
        },
        {
          code: "features",
          message: `Driver feature level ${number(release, "featureLevel")} meets required ${featureLevel}`,
          passed: number(release, "featureLevel") >= featureLevel,
        },
      ];
      const tasks: Task[] = [];
      const hardwareEnds: string[] = [];
      for (const h of hardware) {
        constraints.push(
          {
            code: `qualification:${h.supplierId}`,
            message: `${h.supplierName} is qualified for ${h.componentName}`,
            passed: h.qualified || h.shortageUnits === 0,
          },
          {
            code: `capacity:${h.supplierId}`,
            message: `${h.shortageUnits} missing units at ${h.dailyCapacity} units/day`,
            passed: h.shortageUnits === 0 || h.dailyCapacity > 0,
          },
        );
        const prefix = h.componentId;
        tasks.push(
          {
            id: prefix + "-lead",
            label: h.supplierName + " delivery/setup",
            duration: h.leadDays,
            dependencies: [],
            evidence: [h.supplierId],
          },
          {
            id: prefix + "-production",
            label: `Produce ${h.shortageUnits} units`,
            duration: h.productionDays,
            dependencies: [prefix + "-lead"],
            evidence: [h.supplierId, h.componentId],
          },
          {
            id: prefix + "-assembly",
            label: h.componentName + " assembly",
            duration: h.assemblyDays,
            dependencies: [prefix + "-production"],
            evidence: [h.componentId],
          },
        );
        hardwareEnds.push(prefix + "-assembly");
      }
      const repairIds: string[] = [];
      if (!validated)
        for (const issue of issues) {
          const id = "repair-" + issue.id;
          tasks.push({
            id,
            label: name(issue),
            duration: number(issue, "fixDays"),
            dependencies: [],
            evidence: [issue.id],
          });
          repairIds.push(id);
        }
      tasks.push({
        id: "software-precheck",
        label: validated
          ? "Previously validated driver"
          : "Driver pre-validation",
        duration: validated ? 0 : number(release, "validationDays"),
        dependencies: repairIds,
        evidence: [release.id],
      });
      const gateIds: string[] = [];
      if (!validated)
        for (const test of tests) {
          const id = "gate-" + test.id;
          const dependencies = related(test.id, "DEPENDS_ON").map(
            (t) => "gate-" + t.id,
          );
          tasks.push({
            id,
            label: name(test),
            duration: number(test, "durationDays"),
            dependencies: [
              ...dependencies,
              "software-precheck",
              ...(test.properties.requiresHardware === true
                ? hardwareEnds
                : []),
            ],
            evidence: [test.id, release.id],
          });
          gateIds.push(id);
        }
      tasks.push({
        id: "final-integration",
        label: "Final product integration",
        duration: integrationDays,
        dependencies: [...hardwareEnds, "software-precheck", ...gateIds],
        evidence: [product.id],
      });
      const schedule = scheduleTasks(tasks);
      const hardwareReadyDays = Math.max(...hardware.map((h) => h.readyDays));
      const softwareReadyDays = schedule.tasks.find(
        (t) => t.id === "software-precheck",
      )!.end;
      const validationDays = Math.max(
        0,
        ...tests.map((t) => (validated ? 0 : number(t, "durationDays"))),
      );
      const readyDays = schedule.duration,
        eligible = constraints.every((c) => c.passed);
      plans.push({
        id: `${hardware.map((h) => h.supplierId + (h.expedited ? "-expedited" : "")).join("_")}_${release.id}`,
        label: `${hardware.map((h) => (h.expedited ? "Expedite " : "") + h.supplierName).join(" + ")} · ${validated ? "use validated" : "repair"} ${name(release)}`,
        hardware,
        releaseId: release.id,
        releaseName: name(release),
        softwareReadyDays,
        hardwareReadyDays,
        validationDays,
        integrationDays,
        readyDays,
        delayDays: Math.max(0, readyDays - deadlineDays),
        costUSD:
          hardware.reduce((s, h) => s + h.costUSD, 0) +
          number(release, "repairCostUSD"),
        riskPoints:
          hardware.reduce((s, h) => s + h.riskPoints, 0) +
          number(release, "riskPoints"),
        eligible,
        constraints,
        tasks: schedule.tasks,
        criticalPath: schedule.criticalPath,
        feasible: eligible && readyDays <= deadlineDays,
        validation: validated ? "validated" : "repair-and-revalidate",
      });
    }
  }
  const baseline = plans.find(
    (p) =>
      p.releaseId === primary[0].id &&
      p.hardware.every(
        (h, i) => h.supplierId === baselineIds[i] && !h.expedited,
      ),
  );
  if (!baseline) throw new Error("No baseline plan was generated");
  plans.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      Number(b.feasible) - Number(a.feasible) ||
      (!a.feasible ? a.delayDays - b.delayDays : 0) ||
      a.riskPoints - b.riskPoints ||
      a.costUSD - b.costUSD ||
      a.readyDays - b.readyDays ||
      a.id.localeCompare(b.id),
  );
  const customers = related(launches[0].id, "COMMITS_TO");
  for (const object of evidence.values())
    if (
      ["delayed", "open", "failed"].includes(String(object.properties.status))
    )
      blockers.push({
        id: object.id,
        name: name(object),
        kind: object.type,
        status: String(object.properties.status),
      });
  return {
    productId: product.id,
    productName: name(product),
    demandUnits,
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
      "All data, incremental USD costs and ordinal risk penalties are synthetic. Risk points are not failure probabilities.",
      "Required units = launch demand × units per product. Available inventory is consumed first; missing units require ceil(shortage / supplier daily capacity) production days.",
      "Supplier lead/setup, production, and assembly are sequential. Driver repairs run in parallel with hardware, followed by software pre-validation.",
      "Hardware-dependent validation gates wait for assembly and software pre-validation. Final integration waits for every required gate. Previously validated compatible fallback releases skip repeat validation in this simplified model.",
      "Supplier qualification, positive capacity, architecture compatibility and minimum driver features are hard eligibility constraints. Ineligible rows are diagnostic alternatives, not executable plans.",
      "Eligible on-time alternatives rank by modeled risk, incremental cost and readiness; late alternatives prioritize delay. Critical paths use deterministic longest-path scheduling and reject cycles.",
      "Supplier capacity is reserved for this product; competing orders, yield, shipping variability and stochastic risk are not modeled. Durations are elapsed days, not calendar forecasts.",
      "A predicted validation finish is not an observed passing test result.",
    ],
  };
}
export const launchReadiness = defineFunction({
  id: "launch-readiness",
  name: "GPU launch readiness",
  description:
    "Evaluate inventory, supplier qualification/capacity, driver compatibility and validation task dependencies; rank graph-derived recovery plans with critical-path evidence.",
  ontology: "semiconductor",
  input: z.object({ productId: z.string().min(1) }).strict(),
  output: launchResultSchema,
  explain: (output) => {
    const plan = output.recommendation;
    return [
      {
        id: "recommendation",
        kind: "calculated" as const,
        ruleId: "launch.rank.v1",
        text: `${plan.label}: ready in ${plan.readyDays} days against a ${output.deadlineDays}-day deadline; incremental cost USD ${plan.costUSD}; ${plan.riskPoints} ordinal risk points. Eligible on-time plans rank by risk, cost, then readiness.`,
        recordIds: [
          output.productId,
          plan.releaseId,
          ...plan.hardware.flatMap((h) => [h.supplierId, h.componentId]),
        ],
      },
      {
        id: "baseline",
        kind: "calculated" as const,
        ruleId: "launch.baseline.v1",
        text: `The current supplier/release path is ready in ${output.baseline.readyDays} days, ${output.baseline.delayDays} days late.`,
        recordIds: [
          output.productId,
          output.baseline.releaseId,
          ...output.baseline.hardware.flatMap((h) => [
            h.supplierId,
            h.componentId,
          ]),
        ],
      },
      ...plan.tasks.map((task) => ({
        id: `task:${task.id}`,
        kind: "calculated" as const,
        ruleId: "launch.dag.v1",
        text: `${task.label}: day ${task.start}–${task.end}; dependencies: ${task.dependencies.join(", ") || "none"}${task.critical ? "; critical path" : ""}.`,
        recordIds: task.evidence,
      })),
      ...output.plans.flatMap((alternative) =>
        alternative.constraints.map((constraint) => ({
          id: `${alternative.id}:${constraint.code}`,
          kind: "constraint" as const,
          ruleId: `launch.constraint.${constraint.code.split(":")[0]}.v1`,
          passed: constraint.passed,
          text: `${alternative.label}: ${constraint.message}`,
          recordIds: constraint.code.includes(":")
            ? [
                constraint.code.split(":")[1],
                ...alternative.hardware.map((h) => h.componentId),
              ]
            : [output.productId, alternative.releaseId],
        })),
      ),
      ...output.assumptions.map((text, index) => ({
        id: `assumption:${index}`,
        kind: "assumption" as const,
        text,
        recordIds: [],
      })),
    ];
  },
  execute: calculateLaunch,
});
