# Source connection and sync status

`client.sourceStatuses(ontology)` (`GET /api/ontologies/:ontology/sources/status`) returns one redacted status per registered source. Read scope and the normal ontology allowlist apply. It does not contact any provider, retry a failed operation, disclose tokens/resource IDs or mutate source data.

| Connection state | Meaning                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `upload`         | CSV/JSON content must be uploaded explicitly.                                                                                             |
| `public`         | Public GitHub repository/issues reader; access has not been probed by this call.                                                          |
| `configured`     | A named Notion/Discord server connection matches the connector and ontology allowlist. This does not prove its token or permissions work. |
| `unavailable`    | The named connection is absent, has the wrong connector or does not allow this ontology.                                                  |

Every response says `connectivity: "not_probed"`. `lastSuccessfulSync` is the last applied sync timestamp; it does not advance after a preview. `lastAttempt` summarizes the latest retained applied/failure audit record. Successful previews are not persisted as applied syncs. A later failure leaves the previous success timestamp intact, so the operator can see both facts.

Operations → Sources displays the connection state, last applied sync, last recorded attempt/error and expandable guidance. Provider 401/403 failures suggest checking the server credential and resource permissions; 429 suggests waiting before a new preview. Missing configuration explains the named connection and ontology requirement. Provider response bodies/tokens are not copied into these messages. The status route performs no automatic health check.

A failed preview clears any previously staged upload before showing its error, preventing an old successful preview from leaving an unrelated Apply button active. Relationship counts are shown separately from object counts in the reviewed sync panel.

The current implementation summarizes retained sync audit documents under the single-writer coordination queue. It is not a background monitor, scheduler, liveness guarantee or indexed status service for unbounded histories. Authenticated provider checks still require configured demonstration accounts and explicit preview/sync calls. Tests use controlled provider responses and real FalkorDB; they do not establish live account access.
