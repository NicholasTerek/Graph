# SDK and API compatibility

The SDK and contracts share a version and are released together. While `0.x`, a minor release may change behavior or wire contracts; patches preserve documented contracts except necessary security/correctness fixes. Additive fields/endpoints normally fit a patch, but consumers must tolerate unknown response fields and pin the tested minor. There is no promise of compatibility with undocumented graph internals, private package paths or direct database writes. `@graph/core` remains trusted monorepo implementation, not a published compatibility boundary.

The API currently uses `/api` without a major-version segment. Its OpenAPI `info.version` tracks the SDK/contracts minor. A future stable `1.0` requires explicit major API routing and a migration/deprecation window. Breaking scalar schema changes remain rejected; archive format versions are independent of SDK versions. V1 operational archives remain readable; v2 adds optional retained history and requires a compatible server. Never feed a v2 archive to an older server as if it were v1.

## Reproducible installation artifacts

From a clean checkout, with the pinned Node/pnpm dependencies installed:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/verify-packages.mjs
pnpm release:sdk
```

`release:sdk` refuses dirty sources, builds declarations/ES modules, packs each package twice and verifies byte-for-byte equality. It writes both installable tarballs and a manifest containing source commit, tool versions, SHA-256 and size under `artifacts/releases/VERSION-COMMIT/`. An optional output directory is accepted. No registry upload or GitHub release occurs automatically. The artifacts are reproducible from the recorded commit, lockfile and tools; the double-pack check tests determinism within that environment, not across every OS/tool version.

Install both tarballs together in an independent application with `npm install /path/graph-contracts-VERSION.tgz /path/graph-sdk-VERSION.tgz`. The SDK archive resolves its workspace contract dependency to the release version. Keep the manifest with the artifacts and verify hashes before use. `verify-packages.mjs` installs and runs this exact pair outside the workspace and is required in milestone CI.

## 0.4 behavior changes

This minor adds persisted jobs/schedules, native relationship mappings and connection status, typed extension composition, approval deadlines/revocation and opt-in temporal backups. Approvals without deadlines fail closed and require a fresh proposal/review. Query strings no longer affect privileged-route scope classification. Existing synchronous SDK calls and v1 operational archives remain available. New features retain the one-writer deployment contract; the release is not a claim of Foundry parity or production readiness.
