# Calculation evidence and native explanation paths

Functions receive a read-only GraphView. Calls to `object`, `objects` and `related` now record the actual objects and relationships used. The function runtime captures data and source mappings/checkpoints under the same single-writer lock, computes against that immutable view, and saves the bounded read set with its result. Up to 2,000 records and 5,000 relationships are retained; truncation is explicit.

An extension may supply `explain(output)` to return typed calculated claims, constraints, rule IDs, evidence record IDs and assumptions. Those claims are saved with the calculation, so later extension changes do not silently rewrite its explanation. The GPU extension describes its selected plan, baseline, task dependencies/critical path, each alternative's eligibility constraints and simplifying assumptions. A rule ID identifies application code semantics, not a proof of a business forecast.

```ts
const explanation = await client.explain("semiconductor", {
  root: "aquila-x900",
  targets: ["northstar", "meridian"],
  runId: run.id,
  maxDepth: 4,
});
```

`POST /api/ontologies/:ontology/explain` requires read scope and validates the requested ontology, root, scenario/run context and bounds. The agent uses the same SDK operation through `explain_evidence`. No arbitrary query or graph key is accepted.

For a saved calculation, its captured read set is projected into a temporary native FalkorDB graph, queried with directed `shortestPath` Cypher and removed. Paths carry ordered object/relationship IDs. Source contributor records include their captured checkpoint, external ID, mapped fields/values and whether those values match the calculation's record. A scenario override therefore does not masquerade as the CSV's source value.

Without a run, live explanation paths query the scoped operational graph directly; scenario explanations query the selected native branch graph. Return size is bounded by at most 16 targets and five hops. Paths are directed outwards, consistent with the pinned engine's shortest-path support. Absence within this bound is not evidence that no dependency exists by another direction or longer route.

The response distinguishes calculation revision/scenario version from current context, and marks staleness. Original records and paths remain available after live edits, later scenario edits or branch deletion because the calculation retains its read set. These paths cover only relationships the function actually read, not the entire historical ontology. Legacy calculations without read sets can use a still-matching current context; once stale, they return retained output and an explicit unavailable-path warning rather than inventing historical evidence.

This is immutable calculation evidence, not general temporal MVCC. Full arbitrary as-of reads remain separate backlog work. Native projection, JSON archival payload and full-state function capture costs remain real and must be included in end-to-end performance measurements.

Integration tests exercise native paths, saved source checkpoints, rule claims, current/source-value mismatches, stale live/branch contexts, deleted branches, missing paths, legacy runs, invalid inputs and read-only/cross-ontology access.

The GPU workspace includes a reusable evidence panel. It shows the selected/baseline claims, selectable native paths with edge IDs, captured record properties and source mappings, eligibility checks, assumptions and evidence limitations. Desktop and mobile browser verification covers the recommendation-to-supplier path and recorded input values. The panel is reusable UI; domain claims still come from the registered function extension.
