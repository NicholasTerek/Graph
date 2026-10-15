# Concurrent SDK history checker

`pnpm check:history` runs concurrent SDK callers against one API process and writes a JSONL journal plus a JSON summary. Use a disposable database: the command leaves a uniquely named ontology and its history for inspection, but releases its snapshot lease and discards its scenario graphs. It does not contact external connectors or run a model.

```sh
HISTORY_SEED=42 HISTORY_ROUNDS=12 HISTORY_WRITERS=4 \
  HISTORY_OUTPUT=artifacts/history/seed-42 pnpm check:history
```

`API_URL` and `GRAPH_API_TOKEN` select the server and its credential. Rounds are bounded to 500 and writers to 32. A seed controls delay choices and inputs; operating-system scheduling and database timing still determine the interleaving. Replaying a seed does not promise the exact same schedule. An unexpected error or failed invariant produces a nonzero exit code. Transport failures are reported as failures, not assumed successful or retried into apparent success.

The callers share one SDK transport and principal; distinct role/token authorization is tested separately. The workload mixes optimistic counter increments, unguarded **atomic batch** writes to a pair of objects, current revision reads, reads through a lease acquired before the concurrent work, isolated scenario edits and guarded promotions. A final uncontended promotion ensures the successful promotion path is exercised even when every racing promotion conflicts. The pair writer changes only the two pair objects; it never overwrites the counter. Scenario cleanup runs after the final observation.

Each journal entry records a client, operation ID, invocation/completion offsets from one monotonic clock, inputs, observed output/revision and success or error status. Expected 409 conflicts are counted separately. There are no bearer tokens in the journal. The test data is synthetic.

The checker tests these workload-specific invariants:

- Each successful guarded increment advances its expected revision exactly once; two successes cannot claim the same revision.
- The final counter equals the number of successful counter patches and promotions. Rejected increments contribute nothing.
- Current reads cannot predate a write or current read that completed before they began. Reads overlapping a write may see either revision.
- Two current reads reporting one generation/revision have identical records and edges.
- Both members of the atomic pair have equal values; every visible edge has visible endpoints.
- Repeated reads through one pin have the same revision, records and edges.
- An edited scenario returns its own counter value even while live writers continue.

Eight unit tests deliberately inject lost updates, pair skew, dangling edges, moving pins, stale reads, inconsistent revisions, incorrectly accepted preconditions and unexpected errors. The real FalkorDB integration test runs two seeds through the public SDK and normal Fastify routes. It is part of milestone CI. Other integration suites cover failed candidate publication, lost acknowledgments, restore generations, retention and process/database restart.

This is a small concurrent-history checker inspired by Jepsen's approach, **not a Jepsen test or a general linearizability checker**. It covers one API writer, a specific increment/pair workload and observed completions. It does not explore all schedules, check arbitrary business invariants, inject partitions, check multi-replica operation or prove serializable transactions. Two application writes without expected revisions still have last-write behavior. A saved read lease protects repeatable reads; it does not create a multi-request write transaction. Cross-record decisions made on separate reads can still suffer write skew unless the application revalidates the relevant dependencies at commit.

Database durability settings, process restarts, external synchronization and function evaluation are separate tests, not silently included in this workload's pass count. Longer fault schedules and reduced counterexamples remain in [the TODO](TODO.md).
