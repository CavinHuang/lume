# Chat 域二次分层执行计划

最后更新：2026-03-26

## 1. 目标

在不改变现有 chat 对外行为的前提下，完成 chat 域第二轮逻辑分层收口：

1. 继续缩小单文件热点
2. 让 send/tool/config/test 边界更清晰
3. 保持 `chat-service.ts` facade 与 RPC 调用稳定

## 2. 本轮范围

### 2.1 包含

1. `chat-tool-execution-service.ts`
   - 下沉 `web search` provider 调度与解析
   - 下沉 `nano banana` prompt/intent 推导
   - 下沉 `agent recommendation` helper
2. `chat-tool-manager.ts`
   - 下沉配置文件读写与 normalize
   - 下沉工具连通性测试逻辑
   - 保留 manager facade
3. 维持现有 `chat-send-service.ts` / `chat-service.ts` 对外接口不变

### 2.2 不包含

1. 不调整 `rpc/chat-handlers.ts` import 结构
2. 不触碰 `memory` 域
3. 不把 `conversation-manager.ts` 再拆目录
4. 不混入 UI 或 contract 变更

## 3. 执行顺序

### Step 1

从 `chat-tool-execution-service.ts` 中抽出：

1. `chat-web-search-service.ts`
2. `chat-nano-banana-prompt-service.ts`
3. `chat-agent-recommendation-service.ts`

### Step 2

从 `chat-tool-manager.ts` 中抽出：

1. `chat-tool-config-store.ts`
2. `chat-tool-test-service.ts`

### Step 3

让 `chat-tool-manager.ts` 退化为 facade：

1. 工具元数据聚合
2. enabled/available 筛选
3. 对外 API 转发

## 4. 验证要求

至少保持以下验证通过：

```bash
bun run --filter @lume/sidecar typecheck
```

```bash
bun run --filter @lume/sidecar build
```

```bash
bun test apps/sidecar/src/services/chat/chat-service.tool-activity.test.ts
```

```bash
bun test apps/sidecar/src/services/chat/chat-tool-manager.test.ts
```

```bash
bun run --filter @lume/sidecar smoke:chat-provider-switch
```

`smoke:chat-stream` 继续沿用已知说明：若当前环境仍受 `@larksuiteoapi/node-sdk + Bun` 影响，则记录为环境问题，不误判为本轮代码回归。
