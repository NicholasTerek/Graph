import { timingSafeEqual, createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformError } from "@graph/core";
export const credentialSchema = z.object({
  name: z.string().min(1),
  token: z.string().min(24),
  scopes: z.array(z.enum(["read", "write", "approve", "execute", "admin"])),
  ontologies: z.array(z.string()).optional(),
});
export type Credential = z.infer<typeof credentialSchema>;
export type Principal = {
  name: string;
  scopes: string[];
  ontologies?: string[];
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
  constructor(
    private options: SecurityOptions = {},
    private internal?: Credential,
  ) {}
  check(request: FastifyRequest) {
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
    if (
      !request.url.startsWith("/api/") &&
      request.method === "GET" &&
      !authorization
    )
      return;
    let principal: Principal;
    if (authorization) {
      const value = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const credential = [
        ...(this.options.tokens ?? []),
        ...(this.internal ? [this.internal] : []),
      ].find((t) => same(t.token, value));
      if (!credential) throw new PlatformError(401, "Invalid API credential");
      principal = {
        name: credential.name,
        scopes: credential.scopes,
        ontologies: credential.ontologies,
      };
    } else if (this.options.tokens?.length) {
      if (
        request.method === "GET" &&
        /^\/api\/(health|docs(?:\/|$)|openapi\.json)/.test(request.url)
      )
        return;
      throw new PlatformError(401, "An API credential is required");
    } else
      principal = {
        name: "local-owner",
        scopes: ["read", "write", "approve", "execute", "admin"],
      };
    this.principals.set(request, principal);
    if (!request.url.startsWith("/api/")) return;
    const ontology = /^\/api\/ontologies\/([^/?]+)/.exec(request.url)?.[1];
    if (
      ontology &&
      principal.ontologies &&
      !principal.ontologies.includes(decodeURIComponent(ontology))
    )
      throw new PlatformError(403, "Credential cannot access this ontology");
    const scopes =
      request.method === "GET"
        ? ["read"]
        : /\/actions\/[^/]+\/(approve|reject)$/.test(request.url)
          ? ["approve"]
          : /\/actions\/[^/]+\/(execute|reconcile)$/.test(request.url)
            ? ["execute"]
            : /\/scenarios\/[^/]+\/promote$/.test(request.url)
              ? ["write", "approve"]
              : /\/(restore|indexes)$/.test(request.url)
                ? ["admin"]
                : /\/functions\/[^/]+\/run$|\/objects\/query$|\/aggregate$|\/algorithms\/run$|\/explain$|\/state\/at$|\/snapshots(?:\/[^/]+)?$/.test(
                      request.url,
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
