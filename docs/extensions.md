# Adding a domain

`PlatformExtension` is the trusted server composition interface: an ID, validated ontology schemas, deterministic functions, action adapters and optional source mappings. `composeExtensions` rejects duplicate extension/schema/function/action/source identities and definitions targeting an undeclared ontology. `createApp(store, {extensions})` installs the composed functions/actions. Registration and data ingestion remain explicit SDK operations; starting the server never overwrites user schemas or source checkpoints.

The example catalog is `examples/server.ts`. `GRAPH_EXTENSIONS=library` selects just that catalog entry; the default includes both domains, and unknown IDs fail startup. The generic server imports the catalog, not a GPU function or GitHub action. Adding a new application edits its own files and the catalog, with no core/API route changes. Executable extensions are reviewed local TypeScript modules, not uploaded code or a sandboxed plugin system.

1. Add a schema and fixtures under `examples/YOUR_DOMAIN`, plus immutable source mappings when needed.
2. Define typed functions with `defineFunction`, using `GraphView` and the captured revision; adapters use the proposal/review/execute contract.
3. Register the manifest in the example catalog. Use `client.register(schema)`, `registerSource` and preview/apply to populate it. Schema installation requires normal write permissions.
4. Export a React component accepting `{client, onOpenOperations?}` and register it with `defineWorkspaces` in `examples/workspaces.ts`. UI selection is by ontology; the shell and graph explorer remain generic. Server `GRAPH_EXTENSIONS` controls executable functions, not the compiled UI catalog or authorization.

The library example supplies its own schema, availability function and circulation UI, querying `Book → WRITTEN_BY → Author`. Its browser test selects the library, executes the calculation and verifies the saved answer's author. This is a separate application added entirely through the composition interfaces. Function registration does not implicitly grant access to another ontology.

## Future schema work

The current scalar contract intentionally supports string, finite number and boolean fields, required flags and typed relationship endpoints. Rich values, enums, nullable fields, cardinality/uniqueness, destructive renames, backfills and multi-step migrations require a versioned schema proposal with preview, compatibility checks and rollback evidence. They are tracked separately from this demo; extending a TypeScript type alone does not implement their storage/validation semantics.
