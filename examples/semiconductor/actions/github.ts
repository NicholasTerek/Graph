import { z } from "zod";
import {
  ExternalActionError,
  PlatformError,
  type ActionDefinition,
} from "@graph/core";
import { launchResultSchema } from "../functions/launch-readiness.js";
export function githubRecoveryAction(options: {
  repository?: string;
  token?: string;
  request?: typeof fetch;
}): ActionDefinition {
  const request = options.request ?? fetch;
  const repository = options.repository ?? "NicholasTerek/Graph";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid configured action repository");
  const headers = () => ({
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "Graph-Ontology",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  });
  async function find(id: string) {
    for (let page = 1; page <= 10; page++) {
      const response = await request(
        `https://api.github.com/repos/${repository}/issues?state=all&per_page=100&page=${page}`,
        {
          headers: headers(),
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
      if (!response.ok)
        throw new ExternalActionError(
          `Could not reconcile GitHub issue (${response.status})`,
          true,
        );
      const items = await response.json();
      if (!Array.isArray(items))
        throw new ExternalActionError(
          "Invalid GitHub reconciliation response",
          true,
        );
      const match = items.find(
        (item: Record<string, unknown>) =>
          typeof item.body === "string" &&
          item.body.includes(`<!-- graph-action:${id} -->`),
      );
      if (match)
        return { url: match.html_url, number: match.number, repository };
      if (items.length < 100) return null;
    }
    throw new ExternalActionError(
      "Reconciliation scan limit exceeded; check the repository manually",
      true,
    );
  }
  return {
    id: "github-recovery-issue",
    name: "Create GPU recovery issue",
    description:
      "Prepare a GitHub issue with the exact recovery plan and graph evidence. Approval and execution are separate.",
    ontology: "semiconductor",
    input: z.object({ runId: z.string().min(1) }).strict(),
    prepare: async (context, raw) => {
      const { runId } = raw as { runId: string };
      const run = await context.run(runId);
      if (run.functionId !== "launch-readiness")
        throw new PlatformError(
          422,
          "Recovery actions require a launch-readiness result",
        );
      const analysis = launchResultSchema.parse(run.output);
      const plan = analysis.recommendation;
      if (!plan.eligible)
        throw new PlatformError(
          422,
          "No eligible recovery plan can be actioned; resolve the failed constraints first",
        );
      const title = `${analysis.productName}: ${plan.feasible ? "execute launch recovery" : "resolve launch delay"}`;
      const body = [
        `## Proposed recovery`,
        ``,
        plan.label,
        ``,
        `- Modeled readiness: ${plan.readyDays} days (launch in ${analysis.deadlineDays}).`,
        `- Incremental cost: USD ${plan.costUSD}.`,
        `- Risk: ${plan.riskPoints} synthetic ordinal points.`,
        `- Validation: ${plan.validation}; predicted completion is not a passing test result.`,
        ``,
        `## Evidence`,
        ``,
        ...analysis.evidence.map(
          (e) =>
            `- ${e.id} (${e.type}), source ${e.source}, observed ${e.observedAt}.`,
        ),
        ``,
        `Function run: ${run.id}; ontology revision: ${run.revision}; scenario: ${run.scenarioId ?? "live"}.`,
        ``,
        `This issue records a proposed operational plan using synthetic data. It does not place supplier orders or alter a real driver release.`,
      ].join("\n");
      return {
        title,
        description: body,
        target: `https://github.com/${repository}/issues`,
        payload: { repository, title, body },
      };
    },
    execute: async (prepared, id) => {
      if (!options.token)
        throw new ExternalActionError(
          "GitHub execution is disabled: configure a repository-scoped GITHUB_TOKEN on the server",
          false,
        );
      const payload = prepared.payload as {
        repository: string;
        title: string;
        body: string;
      };
      if (payload.repository !== repository)
        throw new ExternalActionError("Repository is not allowlisted", false);
      const existing = await find(id);
      if (existing) return existing;
      let response: Response;
      try {
        response = await request(
          `https://api.github.com/repos/${repository}/issues`,
          {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              title: payload.title,
              body: `${payload.body}\n\n<!-- graph-action:${id} -->`,
            }),
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          },
        );
      } catch {
        throw new ExternalActionError(
          "GitHub outcome is unknown; reconcile before taking further action",
          true,
        );
      }
      if (!response.ok)
        throw new ExternalActionError(
          `GitHub rejected issue creation (${response.status})`,
          response.status >= 500,
        );
      const issue = await response.json();
      if (
        typeof issue.html_url !== "string" ||
        typeof issue.number !== "number"
      )
        throw new ExternalActionError(
          "GitHub returned an incomplete result; reconcile the action",
          true,
        );
      return { url: issue.html_url, number: issue.number, repository };
    },
    reconcile: (_prepared, id) => find(id),
  };
}
