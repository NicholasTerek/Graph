import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformError } from "@graph/core";
export const credentialSchema = z
  .object({
    name: z.string().min(1),
    token: z.string().min(24),
    scopes: z.array(z.enum(["read", "write", "approve", "execute", "admin"])),
    ontologies: z.array(z.string()).optional(),
    kind: z.enum(["human", "agent"]).optional(),
  })
  .refine(
    (c) =>
      c.kind !== "agent" ||
      !c.scopes.some((s) => ["approve", "execute", "admin"].includes(s)),
    "Agent credentials cannot have approval, execution or admin scopes",
  );
export type Credential = z.infer<typeof credentialSchema>;
export type Principal = {
  name: string;
  scopes: string[];
  ontologies?: string[];
  kind?: "human" | "agent";
};
export type SecurityOptions = {
  tokens?: Credential[];
  allowedHosts?: string[];
  allowedOrigins?: string[];
};
function same(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
export class Security {
  private principals = new WeakMap<FastifyRequest, Principal>();
  private delegated = new Map<string, Credential>();
  constructor(private options: SecurityOptions = {}) {
    for (const credential of options.tokens ?? [])
      credentialSchema.parse(credential);
  }
  delegateAgent(name: string, ontology: string) {
    const credential: Credential = {
      name,
      token: randomBytes(32).toString("hex"),
      scopes: ["read", "write"],
      ontologies: [ontology],
      kind: "agent",
    };
    this.delegated.set(credential.token, credential);
    return {
      token: credential.token,
      release: () => {
        this.delegated.delete(credential.token);
      },
    };
  }
  check(request: FastifyRequest) {
    const path = request.url.split("?")[0];
    const host = request.headers.host ?? "localhost";
    let hostname: string;
    try {
      hostname = new URL("http://" + host).hostname;
    } catch {
      throw new PlatformError(403, "Invalid host");
    }
    if (
      ![
        "localhost",
        "127.0.0.1",
        "[::1]",
        ...(this.options.allowedHosts ?? []),
      ].includes(hostname)
    )
      throw new PlatformError(403, "Host is not allowed");
    const origin = request.headers.origin;
    if (
      origin &&
      origin !== `${request.protocol}://${host}` &&
      ![
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        ...(this.options.allowedOrigins ?? []),
      ].includes(origin)
    )
      throw new PlatformError(403, "Origin is not allowed");
    const authorization = request.headers.authorization;
    if (!path.startsWith("/api/") && request.method === "GET" && !authorization)
      return;
    let principal: Principal;
    if (authorization) {
      const value = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const credential = [
        ...(this.options.tokens ?? []),
        ...this.delegated.values(),
      ].find((t) => same(t.token, value));
      if (!credential) throw new PlatformError(401, "Invalid API credential");
      principal = {
        name: credential.name,
        scopes: credential.scopes,
        ontologies: credential.ontologies,
        kind: credential.kind,
      };
    } else if (this.options.tokens?.length) {
      if (
        request.method === "GET" &&
        /^\/api\/(health|docs(?:\/|$)|openapi\.json)/.test(path)
      )
        return;
      throw new PlatformError(401, "An API credential is required");
    } else
      principal = {
        name: "local-owner",
        scopes: ["read", "write", "approve", "execute", "admin"],
      };
    this.principals.set(request, principal);
    if (!path.startsWith("/api/")) return;
    const ontology = /^\/api\/ontologies\/([^/?]+)/.exec(path)?.[1];
    if (
      ontology &&
      principal.ontologies &&
      !principal.ontologies.includes(decodeURIComponent(ontology))
    )
      throw new PlatformError(403, "Credential cannot access this ontology");
    if (principal.kind === "agent" && request.method !== "GET") {
      const allowed =
        request.method === "POST"
          ? /\/scenarios$|\/investigations$|\/jobs$|\/jobs\/[^/]+\/(cancel|retry)$|\/actions$|\/functions\/[^/]+\/run$|\/objects\/query$|\/aggregate$|\/algorithms\/run$|\/explain$|\/state\/at(?:\/traverse)?$|\/snapshots$/.test(
              path,
            )
          : request.method === "PATCH"
            ? /\/scenarios\/[^/]+(?:\/objects\/[^/]+)?$/.test(path)
            : request.method === "DELETE" &&
              /\/(?:scenarios|snapshots)\/[^/]+$/.test(path);
      if (!allowed)
        throw new PlatformError(
          403,
          "Agent credentials can investigate and edit their own scenarios, but cannot mutate live data or authorize execution",
        );
    }
    const scopes =
      request.method === "GET"
        ? ["read"]
        : /\/actions\/[^/]+\/(approve|reject|revoke)$/.test(path)
          ? ["approve"]
          : /\/actions\/[^/]+\/(execute|reconcile)$/.test(path)
            ? ["execute"]
            : /\/scenarios\/[^/]+\/promote$/.test(path)
              ? ["write", "approve"]
              : /\/(restore|indexes|vacuum)$|\/native-graphs\/collect$/.test(
                    path,
                  )
                ? ["admin"]
                : /\/functions\/[^/]+\/run$|\/objects\/query$|\/aggregate$|\/algorithms\/run$|\/explain$|\/state\/at(?:\/traverse)?$|\/snapshots(?:\/[^/]+)?$/.test(
                      path,
                    )
                  ? ["read"]
                  : ["write"];
    for (const scope of scopes)
      if (
        !principal.scopes.includes(scope) &&
        !principal.scopes.includes("admin")
      )
        throw new PlatformError(403, `Credential requires ${scope} scope`);
  }
  principal(request: FastifyRequest): Principal {
    return this.principals.get(request) ?? { name: "anonymous", scopes: [] };
  }
}
