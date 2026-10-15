# Graph SDK

A fetch-based TypeScript client for Graph. Supports ontology registration, source synchronization, object queries/history, scenarios, promotion, deterministic functions, agent investigations, reviewed actions, and backups.

```ts
import { GraphClient } from '@graph/sdk';
const client = new GraphClient('http://127.0.0.1:3001', fetch, { token: process.env.GRAPH_API_TOKEN });
const graph = await client.snapshot('semiconductor');
```

Requires Node.js 22+ or a browser with fetch. Build from the repository root using `pnpm build:sdk`. This package is distributable as a local tarball; it has not been published to npm.
