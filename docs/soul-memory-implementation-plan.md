# Lume Soul & Memory 系统实施计划

> 基于 OpenClaw 设计模式，实现代码级别的对齐

## 背景

OpenClaw 的 Soul 和 Memory 系统是一套成熟的智能体记忆架构，包括：
- **Soul**: 智能体人格定义
- **Memory**: 短期/长期记忆存储
- **Heartbeat**: 定时任务机制
- **Memory Flush**: 记忆提炼机制

Lume 已经实现了部分记忆系统（SQLite + sqlite-vec，MEMORY.md + memory/*.md），需要补充完整的 Soul 系统和相关机制。

## 实施原则

1. **模板复用**: 直接复制 OpenClaw 的模板文件，不重新编写
2. **代码复用**: 能直接复用的代码就复用，不能复用的才自己实现
3. **逻辑对齐**: 保持与 OpenClaw 的设计逻辑一致

---

## 阶段一：模板文件迁移

**状态**: ✅ 已完成

**目标**: 将 OpenClaw 的 workspace 模板文件复制到 Lume

### 已迁移的模板

| 源文件 | 目标位置 | 用途 | 状态 |
|--------|----------|------|------|
| `docs/reference/templates/SOUL.md` | `templates/workspace/SOUL.md` | 智能体人格定义 | ✅ |
| `docs/reference/templates/SOUL.dev.md` | `templates/workspace/SOUL.dev.md` | 开发模式人格 | ✅ |
| `docs/reference/templates/USER.md` | `templates/workspace/USER.md` | 用户信息模板 | ✅ |
| `docs/reference/templates/USER.dev.md` | `templates/workspace/USER.dev.md` | 开发模式用户信息 | ✅ |
| `docs/reference/templates/IDENTITY.md` | `templates/workspace/IDENTITY.md` | 身份标识模板 | ✅ |
| `docs/reference/templates/IDENTITY.dev.md` | `templates/workspace/IDENTITY.dev.md` | 开发模式身份 | ✅ |
| `docs/reference/templates/AGENTS.md` | `templates/workspace/AGENTS.md` | 操作指令模板 | ✅ |
| `docs/reference/templates/AGENTS.dev.md` | `templates/workspace/AGENTS.dev.md` | 开发模式指令 | ✅ |
| `docs/reference/templates/TOOLS.md` | `templates/workspace/TOOLS.md` | 工具说明模板 | ✅ |
| `docs/reference/templates/TOOLS.dev.md` | `templates/workspace/TOOLS.dev.md` | 开发模式工具 | ✅ |
| `docs/reference/templates/HEARTBEAT.md` | `templates/workspace/HEARTBEAT.md` | 心跳任务模板 | ✅ |
| `docs/reference/templates/BOOTSTRAP.md` | `templates/workspace/BOOTSTRAP.md` | 初始化指南模板 | ✅ |
| `docs/reference/templates/BOOT.md` | `templates/workspace/BOOT.md` | 启动引导模板 | ✅ |

---

## 阶段二：类型定义

**状态**: ✅ 已完成

**目标**: 创建 Soul/Memory 系统的 TypeScript 类型定义

### 已创建的类型文件

| 文件 | 内容 |
|------|------|
| `packages/shared/src/types/workspace-bootstrap.ts` | Bootstrap 文件类型、会话类型、系统提示词构建类型 |
| `packages/shared/src/types/memory-flush.ts` | Memory Flush 配置、判断参数、执行结果 |
| `packages/shared/src/types/heartbeat.ts` | Heartbeat 配置、剥离类型、检查类型 |

### 类型概览

```typescript
// workspace-bootstrap.ts
- BootstrapFileType: SOUL | USER | IDENTITY | AGENTS | TOOLS | HEARTBEAT | MEMORY | BOOTSTRAP
- SessionType: main | subagent | group | channel
- WorkspaceBootstrapConfig: 文件列表、会话类型、开发模式
- SystemPromptComponents: 系统提示词各组件

// memory-flush.ts
- MemoryFlushConfig: enabled, softThresholdTokens, prompt, systemPrompt
- MemoryFlushCheckParams: entry, contextWindowTokens, reserveTokensFloor
- DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000

// heartbeat.ts
- HeartbeatConfig: enabled, interval, prompt, maxAckChars
- StripHeartbeatMode: heartbeat | message
- HEARTBEAT_TOKEN = "HEARTBEAT_OK"
- DEFAULT_HEARTBEAT_EVERY = "30m"
```

---

## 阶段三：Workspace Bootstrap 服务

**状态**: ✅ 已完成

**目标**: 实现工作区初始化服务，复用 OpenClaw 的 `workspace.ts` 逻辑

### 已实现的功能

| 功能 | 描述 |
|------|------|
| `ensureBootstrapFiles()` | 在工作区创建 Bootstrap 文件 |
| `readBootstrapFile()` | 读取工作区 Bootstrap 文件内容 |
| `writeBootstrapFile()` | 写入 Bootstrap 文件 |
| `deleteBootstrapFile()` | 删除 Bootstrap 文件 |
| `readSystemPromptComponents()` | 读取系统提示词各组件 |
| `buildSystemPrompt()` | 构建最终系统提示词 |
| `readDailyMemoryFiles()` | 读取每日记忆文件 |

### 文件结构

```
apps/sidecar/src/services/
├── agent-workspace-manager.ts  # 已修改：集成 Bootstrap 服务
└── workspace-bootstrap-service.ts  # 新建：Bootstrap 服务
```

### 集成点

- `createAgentWorkspace()`: 创建工作区时自动创建 Bootstrap 文件
- `ensureDefaultWorkspace()`: 确保默认工作区有 Bootstrap 文件

---

## 阶段四：Memory Flush 服务

**状态**: ✅ 已完成

**目标**: 实现预压缩记忆刷新机制

### 已实现的功能

| 功能 | 描述 |
|------|------|
| `shouldRunMemoryFlush()` | 判断是否需要执行 Memory Flush |
| `resolveMemoryFlushConfig()` | 解析 Memory Flush 配置 |
| `resolveContextWindowTokens()` | 解析上下文窗口 token 数 |
| `MemoryFlushService` | Memory Flush 服务类 |

### 核心逻辑

```typescript
// 触发条件：
// 1. Token 使用量接近上下文窗口限制
// 2. 当前压缩周期内尚未执行过 Memory Flush

function shouldRunMemoryFlush(params) {
  const threshold = contextWindow - reserveTokens - softThreshold;
  if (totalTokens < threshold) return false;
  if (lastFlushCompactionCount === compactionCount) return false;
  return true;
}
```

### 文件结构

```
apps/sidecar/src/services/
└── memory-flush-service.ts  # 新建：Memory Flush 服务
```

### 默认配置

- `softThresholdTokens`: 4000
- `reserveTokensFloor`: 8000
- 提示词：引导 Agent 将记忆存储到 memory/YYYY-MM-DD.md

---

## 阶段五：Heartbeat 服务

**状态**: ✅ 已完成

**目标**: 实现定时心跳任务机制

### 已实现的功能

| 功能 | 描述 |
|------|------|
| `isHeartbeatContentEffectivelyEmpty()` | 检查 HEARTBEAT.md 是否有效为空 |
| `stripHeartbeatToken()` | 剥离 HEARTBEAT_OK 令牌 |
| `parseHeartbeatInterval()` | 解析心跳间隔字符串 |
| `HeartbeatService` | 心跳服务类（含定时器管理） |

### 核心逻辑

```typescript
// 心跳提示词
const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). " +
  "Follow it strictly. If nothing needs attention, reply HEARTBEAT_OK.";

// 有效为空检查
function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  // 只包含注释、空行、空列表项的文件视为空
  // 允许跳过心跳 API 调用
}

// 令牌剥离
function stripHeartbeatToken(raw: string, opts): { shouldSkip: boolean; text: string } {
  // 处理 HEARTBEAT_OK 响应
  // 支持被 HTML/Markdown 包装的令牌
}
```

### 文件结构

```
apps/sidecar/src/services/
└── heartbeat-service.ts  # 新建：Heartbeat 服务
```

### 默认配置

- `interval`: "30m"（30 分钟）
- `maxAckChars`: 300
- 心跳令牌: "HEARTBEAT_OK"

---

## 阶段六：System Prompt 集成

**状态**: ✅ 已完成

**目标**: 将 Soul/Memory 文件内容注入系统提示词

### 已实现的功能

| 功能 | 描述 |
|------|------|
| 修改 `agent-prompt-builder.ts` | 在系统提示词末尾添加 Soul/Memory 组件 |
| 集成 `readSystemPromptComponents()` | 读取工作区的 Bootstrap 文件内容 |
| 集成 `buildSystemPrompt()` | 构建 Soul/Memory 系统提示词 |

### 修改的文件

```
apps/sidecar/src/services/
└── agent-prompt-builder.ts  # 已修改：集成 Soul/Memory 系统
```

### 系统提示词结构

```
## Lume Agent
## 用户信息
## 工作区
## 交互规范
## Memory Recall
## 工作区上下文     ← 新增
  ### Soul
  ### Identity
  ### User
  ### Workspace Instructions
  ### Tools
  ### Long-Term Memory
  ### Recent Activity
```

---

## 阶段七：测试与验证

**状态**: ✅ 已完成

**目标**: 确保系统正常工作

### 已完成验证项（2026-02-16）

- `memory_search / memory_get / memory_save` 工具行为对齐 OpenClaw（失败降级返回 disabled payload，不抛 tool error）。
- Prompt 注入顺序对齐（Session Bootstrap + Project Context + Memory Recall）。
- subagent 文件注入白名单对齐（仅 AGENTS/TOOLS）。
- `MEMORY.md` / `memory.md` 双文件兼容与真实文件名回显（含大小写不敏感文件系统修正）。
- `sessionType -> chatType` 回退映射对齐（citations auto 判定一致）。
- 关键测试全部通过（包括此前受 `~/.lume` 写权限影响的用例，已通过 `LUME_CONFIG_DIR` 隔离修复）。

### 测试项

- [ ] 工作区初始化测试
- [ ] Memory Flush 触发测试
- [ ] Heartbeat 定时测试
- [ ] 系统提示词注入测试
- [ ] 端到端集成测试

---

## 变更日志

| 日期 | 阶段 | 变更内容 |
|------|------|----------|
| 2026-02-13 | 计划 | 创建实施计划文档 |
| 2026-02-13 | 一 | 完成 13 个模板文件迁移 |
| 2026-02-13 | 二 | 完成类型定义（workspace-bootstrap.ts, memory-flush.ts, heartbeat.ts） |
| 2026-02-13 | 三 | 完成 Workspace Bootstrap 服务 |
| 2026-02-13 | 四 | 完成 Memory Flush 服务 |
| 2026-02-13 | 五 | 完成 Heartbeat 服务 |
| 2026-02-13 | 六 | 完成 System Prompt 集成 |
| 2026-02-13 | 集成 | 完成 Memory Flush 和 Heartbeat 集成到会话管理 |

---

## 文件清单

### 新建文件

| 文件路径 | 用途 |
|----------|------|
| `templates/workspace/SOUL.md` | 智能体人格模板 |
| `templates/workspace/SOUL.dev.md` | 开发模式人格模板 |
| `templates/workspace/USER.md` | 用户信息模板 |
| `templates/workspace/USER.dev.md` | 开发模式用户信息模板 |
| `templates/workspace/IDENTITY.md` | 身份标识模板 |
| `templates/workspace/IDENTITY.dev.md` | 开发模式身份模板 |
| `templates/workspace/AGENTS.md` | 操作指令模板 |
| `templates/workspace/AGENTS.dev.md` | 开发模式指令模板 |
| `templates/workspace/TOOLS.md` | 工具说明模板 |
| `templates/workspace/TOOLS.dev.md` | 开发模式工具模板 |
| `templates/workspace/HEARTBEAT.md` | 心跳任务模板 |
| `templates/workspace/BOOTSTRAP.md` | 初始化指南模板 |
| `templates/workspace/BOOT.md` | 启动引导模板 |
| `packages/shared/src/types/workspace-bootstrap.ts` | Bootstrap 类型定义 |
| `packages/shared/src/types/memory-flush.ts` | Memory Flush 类型定义 |
| `packages/shared/src/types/heartbeat.ts` | Heartbeat 类型定义 |
| `apps/sidecar/src/services/workspace-bootstrap-service.ts` | Bootstrap 服务 |
| `apps/sidecar/src/services/memory-flush-service.ts` | Memory Flush 服务 |
| `apps/sidecar/src/services/heartbeat-service.ts` | Heartbeat 服务 |
| `apps/sidecar/src/services/session-state-manager.ts` | 会话状态管理器 |

### 修改文件

| 文件路径 | 变更内容 |
|----------|----------|
| `packages/shared/src/types/index.ts` | 导出新类型 |
| `apps/sidecar/src/services/agent-workspace-manager.ts` | 集成 Bootstrap 服务 |
| `apps/sidecar/src/services/agent-prompt-builder.ts` | 集成 Soul/Memory 系统 |
| `apps/sidecar/src/services/agent-service.ts` | 集成 Memory Flush 和 Heartbeat |

---

## 后续工作

1. ~~**集成 Memory Flush 到会话管理**: 在 token 使用量接近阈值时触发 Memory Flush~~ ✅ 已完成
2. ~~**集成 Heartbeat 到会话管理**: 启动心跳定时器，定期检查 HEARTBEAT.md~~ ✅ 已完成
3. **添加 UI 支持**: 在前端显示 Soul/Memory 文件内容
4. **编写测试用例**: 确保各服务正常工作

---

## 集成详情

### Memory Flush 集成

**文件**: `apps/sidecar/src/services/session-state-manager.ts`（新建）

**功能**:
- `SessionStateManager`: 管理会话状态（token 使用量、压缩计数）
- `updateTokens()`: 在 `usage_update` 事件时更新 token 使用量
- `incrementCompaction()`: 在 `compacting` 事件时增加压缩计数
- `checkMemoryFlush()`: 检查是否需要触发 Memory Flush

**集成点** (`agent-service.ts`):
- 在 `usage_update` 事件处理中调用 `sessionStateManager.updateTokens()`
- 在 `usage_update` 事件处理后检查 `sessionStateManager.checkMemoryFlush()`
- 在 `compacting` 事件处理中调用 `sessionStateManager.incrementCompaction()`

### Heartbeat 集成

**功能**:
- `startSessionHeartbeat()`: 启动会话的心跳定时器
- `stopSessionHeartbeat()`: 停止会话的心跳定时器
- 自动检查 `HEARTBEAT.md` 是否有效为空

**集成点** (`agent-service.ts`):
- 在 `sendAgentMessage()` 开始时调用 `startSessionHeartbeat()`
- 在 `stopAllAgents()` 中调用 `heartbeatService.stopAllTimers()`

**触发条件**:
- Heartbeat 启用
- `HEARTBEAT.md` 文件存在且非空
