import { describe, it, expect } from "vitest";
import { FalkorDB } from "falkordb";
import { GraphStore } from "@graph/core";
import { GraphClient } from "@graph/sdk";
import { createApp } from "../apps/api/src/app.js";
import { runHistoryWorkload } from "../scripts/lib/history-checker.js";
const suite = process.env.GRAPH_INTEGRATION === "1" ? describe : describe.skip;
suite("seeded concurrent SDK history", () => {
  it("checks concurrent writes, reads, pinned snapshots, native branches and promotions", async () => {
    const db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "127.0.0.1",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
      },
    });
    const name = `history_${Date.now()}_${process.pid}`;
    const store = new GraphStore(db, name);
    const app = createApp(store);
    try {
      await store.initialize();
      await app.ready();
      const client = new GraphClient(
        "http://history.test",
        async (url, init) => {
          const u = new URL(String(url));
          const r = await app.inject({
            method: (init?.method ?? "GET") as "GET",
            url: u.pathname + u.search,
            headers: init?.headers as Record<string, string>,
            payload: init?.body as string | undefined,
          });
          return new Response(r.statusCode === 204 ? null : r.body, {
            status: r.statusCode,
          });
        },
      );
      for (const seed of [42, 2718]) {
        const result = await runHistoryWorkload(client, `records-${seed}`, {
          seed,
          rounds: 8,
          writers: 4,
        });
        expect(result.summary.violations).toEqual([]);
        expect(result.summary.successfulIncrements).toBeGreaterThan(1);
        expect(result.summary.expectedConflicts).toBeGreaterThan(0);
        expect(result.summary.pinnedReads).toBe(8);
        expect(
          result.entries.some((e) => e.kind === "promote" && e.status === "ok"),
        ).toBe(true);
      }
    } finally {
      await app.close();
      await store.nativeGraphs.collect(new Set());
      await db.selectGraph(name).delete();
      await db.close();
    }
  }, 60000);
});
