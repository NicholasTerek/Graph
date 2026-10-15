import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { Security } from "../apps/api/src/security.js";
describe("scope checks on request paths", () => {
  const token = "test-writer-credential-1234567890";
  const security = new Security({
    tokens: [
      {
        name: "writer",
        token,
        scopes: ["read", "write"],
        ontologies: ["demo"],
      },
    ],
  });
  const request = (url: string) =>
    ({
      headers: { host: "localhost", authorization: `Bearer ${token}` },
      protocol: "http",
      method: "POST",
      url,
    }) as FastifyRequest;
  for (const route of [
    "actions/example/approve",
    "actions/example/reject",
    "actions/example/revoke",
    "actions/example/execute",
    "actions/example/reconcile",
    "scenarios/example/promote",
    "restore",
    "vacuum",
    "indexes",
    "native-graphs/collect",
  ]) {
    it(`does not let query parameters bypass ${route} permissions`, () => {
      for (const query of ["", "?trace=1"])
        expect(() =>
          security.check(request(`/api/ontologies/demo/${route}${query}`)),
        ).toThrow(/requires .* scope/);
    });
  }
  it("retains ontology restrictions and permitted writes with query parameters", () => {
    expect(() =>
      security.check(request("/api/ontologies/foreign/objects?trace=1")),
    ).toThrow("cannot access");
    expect(() =>
      security.check(request("/api/ontologies/demo/objects?trace=1")),
    ).not.toThrow();
  });
  it("limits delegated agent credentials to one ontology and releases them after an investigation", () => {
    const delegated = security.delegateAgent("capacity-agent", "demo");
    const scoped = (path: string) =>
      ({
        ...request(path),
        headers: {
          host: "localhost",
          authorization: `Bearer ${delegated.token}`,
        },
      }) as FastifyRequest;
    expect(() =>
      security.check(scoped("/api/ontologies/demo/scenarios")),
    ).not.toThrow();
    expect(() =>
      security.check(scoped("/api/ontologies/demo/ingest?trace=1")),
    ).toThrow("cannot mutate live data");
    expect(() =>
      security.check(scoped("/api/ontologies/foreign/scenarios")),
    ).toThrow("cannot access");
    delegated.release();
    expect(() =>
      security.check(scoped("/api/ontologies/demo/scenarios")),
    ).toThrow("Invalid API credential");
    expect(
      () =>
        new Security({
          tokens: [{ name: "unsafe", token, scopes: ["admin"], kind: "agent" }],
        }),
    ).toThrow("cannot have approval");
  });
});
