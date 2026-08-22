---
title: Agent SDK
description: 用 @lume/agent-sdk 把 Lume 的 Agent 引擎嵌入你自己的应用。
lang: zh
order: 4
---

Lume 的 Agent 引擎以独立包 [`@lume/agent-sdk`](https://github.com/CavinHuang/lume/tree/main/packages/sdk) 提供：完整的 Agent 循环——工具调用、上下文管理、流式输出——全在进程内完成，无本地 CLI 依赖。

```typescript
import { createAgent } from '@lume/agent-sdk'

const agent = createAgent({
  model: 'claude-sonnet-4-6',
  maxTurns: 10,
})

for await (const event of agent.query('Read package.json and summarize the project.')) {
  // 流式事件：assistant 文本 / 工具调用 / result 统计
}
```

## 特性

- **进程内运行**：不依赖任何本地 CLI，可部署到云端、Serverless、Docker、CI/CD。
- **流式事件**：`query()` 返回异步迭代器，逐条产出 assistant 文本、工具调用与最终 result 统计。
- **可控的循环**：通过 `maxTurns` 等参数约束执行轮次；模型由宿主注入，SDK 只定义契约。

## 适用场景

- 在自己的产品里嵌入编码 / 办公 Agent 能力
- 批处理任务、自动化流水线
- 为 IM 渠道、Webhook 等入口构建自定义运行时

API 细节参见仓库内 `packages/sdk` 的类型定义（`types.ts` 是承重契约）。
