import { it, expect } from "vitest";
import {
  CompatibleModelProvider,
  GraphAgent,
} from "../packages/agent/src/index.js";
import { GraphClient } from "@graph/sdk";
it("normalizes a compatible model tool response without exposing credentials to tools", async () => {
  let body: Record<string, unknown> = {};
  let authorization = "";
  const provider = new CompatibleModelProvider({
    baseUrl: "http://localhost:11434/v1",
    model: "test-model",
    apiKey: "test-secret",
    request: async (url, init) => {
      expect(String(url)).toBe("http://localhost:11434/v1/chat/completions");
      body = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c1", function: { name: "read_graph", arguments: {} } },
              ],
            },
          },
        ],
      });
    },
  });
  const result = await provider.complete(
    [{ role: "user", content: "Investigate" }],
    [],
    new AbortController().signal,
  );
  expect(result.tool_calls?.[0].function.arguments).toBe("{}");
  expect(body.model).toBe("test-model");
  expect(authorization).toBe("Bearer test-secret");
  expect(JSON.stringify(result)).not.toContain("test-secret");
});
it("fails model investigations that skip deterministic calculations", async () => {
  let requests = 0;
  const client = new GraphClient("http://localhost", async () => {
    requests++;
    return Response.json([]);
  });
  const records: unknown[] = [];
  const agent = new GraphAgent(client, {
    complete: async () => ({
      role: "assistant",
      content: "The numbers look fine",
    }),
  });
  const result = await agent.investigate(
    "library",
    { question: "What is the answer?", maxSteps: 3 },
    async (record) => {
      records.push(structuredClone(record));
    },
  );
  expect(result.status).toBe("failed");
  expect(result.error).toContain(
    "without a successful deterministic calculation",
  );
  expect(requests).toBe(0);
  expect(records.length).toBeGreaterThan(1);
});
it("stops repeated unauthorized tool requests at the call budget", async () => {
  const client = new GraphClient("http://localhost", async () => {
    throw new Error("No requests allowed");
  });
  const agent = new GraphAgent(client, {
    complete: async () => ({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "x",
          type: "function",
          function: { name: "approve_action", arguments: "{}" },
        },
      ],
    }),
  });
  const result = await agent.investigate(
    "library",
    { question: "Approve everything", maxSteps: 1 },
    async () => {},
  );
  expect(result.status).toBe("failed");
  expect(result.error).toContain("budget");
  expect(result.actionIds).toHaveLength(0);
});
it("rejects unencrypted remote model endpoints", () =>
  expect(
    () =>
      new CompatibleModelProvider({
        baseUrl: "http://remote.example/v1",
        model: "test",
      }),
  ).toThrow("HTTPS"));
