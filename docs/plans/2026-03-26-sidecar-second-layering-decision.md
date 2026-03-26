# Sidecar 二次分层决策

最后更新：2026-03-26

## 1. 结论

当前不建议立刻把 `apps/sidecar/src/services/memory/` 再按目录拆成 `memory/indexing` 与 `memory/runtime`。

更合理的下一步是：

1. 先冻结当前一级目录结构
2. 以“单文件热点 + 对外边界清晰度”为标准，做第二轮分层
3. 第一优先级处理 `chat` 域
4. 第二优先级处理 `memory` 域内部 facade/manager 分层
5. 暂不改 `pi-agent / openclaw / channel-gateway / browser` 路径

## 2. 依据

### 2.1 当前热点不只在 `memory`

按当前体量看：

1. `apps/sidecar/src/services/chat/chat-service.ts`: `52853`
2. `apps/sidecar/src/services/memory/memory-index-manager.ts`: `27803`
3. `apps/sidecar/src/services/chat/chat-tool-manager.ts`: `19471`
4. `apps/sidecar/src/services/agent/agent-session-manager.ts`: `19189`
5. `apps/sidecar/src/services/agent/agent-files-service.ts`: `18191`

这说明“继续只盯 `memory`”会遗漏更明显的单文件热点。

### 2.2 `memory` 已经做过一轮内部分解

当前 `memory/` 下已经存在：

1. `embedding-ops.ts`
2. `search-ops.ts`
3. `sync-ops.ts`
4. `status-ops.ts`
5. `path-ops.ts`
6. `session-files.ts`

也就是说，`memory` 当前更像“一个大 manager + 一组纯 helper/ops”，问题主要在 `memory-index-manager.ts` 的 orchestration 仍偏重，而不是目录名本身不够细。

### 2.3 `chat` 域更像还没进入第二轮分层

当前依赖显示：

1. `rpc/chat-handlers.ts` 直接汇聚 `chat-service / conversation-manager / chat-tool-manager / attachment-service`
2. `chat-service.ts` 同时承担消息发送、流处理、memory 检索接入、工具活动、标题更新等多类职责
3. `chat-tool-manager.ts` 也承担较重的工具定义与状态管理

因此 `chat` 比 `memory` 更像下一轮该优先处理的二次分层对象。

## 3. 建议的第二轮分层顺序

### Step 1: 先拆 `chat-service.ts`

目标不是改行为，而是把职责边界拉直。

建议优先拆出：

1. `chat-stream-service.ts`
   - stream 事件消费
   - chunk/reasoning/tool activity 编排
2. `chat-turn-service.ts`
   - 单次发送入口
   - 上下文装配
   - provider 调用前准备
3. `chat-history-service.ts`
   - assistant/user message 落盘
   - 标题更新
   - stream finalizer

保留 `chat-service.ts` 作为兼容 facade，避免 RPC 层大面积改 import。

### Step 2: 再拆 `memory-index-manager.ts`

建议不是先改目录，而是先把 manager 内部再拆成：

1. `memory-index-read-service.ts`
   - 搜索
   - 读取状态
   - 查询投影
2. `memory-index-write-service.ts`
   - reconcile
   - flush
   - save/sync
3. `memory-index-store.ts`
   - 持久化文件读写
   - recoverable/atomic 写入边界

保留 `memory-service.ts` 作为 runtime facade，继续给 RPC、chat、pi-agent tools 提供稳定入口。

### Step 3: 最后再判断是否需要目录下沉

只有在第二轮逻辑分层完成后，仍然出现以下情况时，才继续目录拆分：

1. 同域文件数量继续快速增长
2. import 前缀难以识别边界
3. 新人无法从目录层级快速判断职责

否则没有必要为了目录名继续迁移路径。

## 4. 当前不建议优先做的事

1. 不建议现在就移动 `services/pi-agent/**`
2. 不建议现在就改 `services/channel-gateway/**`
3. 不建议只为了“memory 目录更漂亮”而先做大规模路径迁移
4. 不建议在目录整理任务里混入行为重构

## 5. 下一步执行建议

建议按下面顺序推进：

1. 先补一份 `chat-service` 二次拆分计划
2. 执行 `chat-service.ts` 的 facade + 内部分层收口
3. 跑 `typecheck / build / chat 相关测试 / smoke:chat-stream / smoke:chat-provider-switch`
4. 收口后再开始 `memory-index-manager.ts` 的第二轮拆分

### 2026-03-26 当前进展

已完成第一刀：

1. `chat-service.ts` 已缩减为 facade 出口
2. 标题生成已下沉到 `chat-title-service.ts`
3. 发送主链已下沉到 `chat-send-service.ts`
4. 消息落盘与中止收尾已下沉到 `chat-history-service.ts`
5. 现有 `rpc/chat-handlers.ts` 与调用方 import 无需改动

当前验证状态：

1. `bun run --filter @lume/sidecar typecheck` 通过
2. `chat-title-service.test.ts + chat-service.tool-activity.test.ts` 通过
3. `smoke:chat-provider-switch` 可通过
4. `smoke:chat-stream` 在当前 Windows + Bun 1.3.9 环境下会因 `@larksuiteoapi/node-sdk` 触发 Bun crash，属于运行环境问题，暂未作为本轮代码回归处理

已继续完成一处低风险二次分层：

1. 工具 schema 构造已下沉到 `chat-tool-definition-service.ts`
2. `chat-send-service.ts` 改为消费独立的 tool definition service
3. 已补 `chat-tool-definition-service.test.ts`，确保内置工具与自定义工具 schema 保持稳定

## 6. 验证基线

执行第二轮分层前后，至少保持以下命令通过：

```bash
bun run --filter @lume/sidecar typecheck
```

```bash
bun run --filter @lume/sidecar build
```

```bash
bun run --filter @lume/sidecar smoke:chat-stream
```

```bash
bun run --filter @lume/sidecar smoke:chat-provider-switch
```
