---
title: Agent SDK
description: Embed Lume's agent engine into your own app with @lume/agent-sdk.
lang: en
order: 4
---

Lume's agent engine ships as the standalone [`@lume/agent-sdk`](https://github.com/CavinHuang/lume/tree/main/packages/sdk) package: the full agent loop — tool calls, context management, streaming output — runs entirely in-process with no local CLI dependency.

```typescript
import { createAgent } from '@lume/agent-sdk'

const agent = createAgent({
  model: 'claude-sonnet-4-6',
  maxTurns: 10,
})

for await (const event of agent.query('Read package.json and summarize the project.')) {
  // streamed events: assistant text / tool calls / result stats
}
```

## Highlights

- **In-process**: no local CLI required — deploy to cloud, serverless, Docker or CI/CD.
- **Streamed events**: `query()` returns an async iterator yielding assistant text, tool calls and final result stats.
- **Bounded loops**: constrain execution via `maxTurns` and friends; providers are injected by the host while the SDK defines only the contract.

## When to Use It

- Embed coding / office agent capabilities into your own product
- Batch jobs and automation pipelines
- Build custom runtimes for IM channels, webhooks and other entry points

For API details see the type definitions in `packages/sdk` of the repository (`types.ts` is the load-bearing contract).
