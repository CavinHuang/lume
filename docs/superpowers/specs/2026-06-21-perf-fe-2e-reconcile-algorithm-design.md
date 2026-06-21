# Phase 2e 设计：reconcile 算法优化（filter+find → Map 索引）

> **所属**：性能优化路线图 Phase 2 的收尾算法优化。2a/2b/2c/2d（projection/stabilize/memo/订阅粒度）已完成。2c 给 reconcile 加了 `ReconcileCache` 引用缓存层，但未动匹配算法；2e 优化匹配算法本身。
>
> **前置**：2c（reconcile `ReconcileCache` + stabilize/memo 引用稳定）、2d（atomFamily 订阅粒度）已完成。

## 背景与动机

`reconcileUserMessageVersions`（agent-message-state.ts）将 projection 的 runtime 消息与持久化 visible 消息对齐（恢复 messageId/attachments/tokenUsage/versionGroupId 等）。当前实现（2c 抽出 `matchVisibleMessage` 后）：

- 2 次 `filter`：`visibleUsers = visibleThreadMessages.filter(role==='user')`、`visibleAssistants = filter(role==='assistant')`，各 O(V)。
- `matchVisibleMessage` 内每条 message 多次 `find`：
  - user messageId：`visibleUsers.find(id === messageId)`（O(V)）
  - user fuzzy：`find(!used && content === text && |createdAt diff| < 10000) ?? find(!used && content === text)`（2× O(V)）
  - assistant：`find(!used && content === text)`（O(V)）

**复杂度 O(M×V)**（M=messages，V=visible）。长会话（M、V 都大）每帧 reconcile 开销显著。

## Goal

用 Map 索引替代 filter+find，把 reconcile 复杂度从 O(M×V) 降到 O(V + M×avg_content_group)（同 content 的 visible 消息通常 1-2 个）。

## Architecture

预处理 visibleThreadMessages 构建 3 个 Map（O(V) 一次），matchVisibleMessage 用 Map 查找替代线性 find：

```
visibleThreadMessages
  → visibleUsersById: Map<id, AgentMessage>           (user messageId 匹配，O(1))
  → visibleUsersByContent: Map<content, AgentMessage[]> (user fuzzy 匹配，遍历同 content 子集)
  → visibleAssistantsByContent: Map<content, AgentMessage[]> (assistant 匹配)
```

`matchVisibleMessage(message, ...)`：
- user messageId：`visibleUsersById.get(messageId)`
- user fuzzy：`visibleUsersByContent.get(text)` 遍历找第一个 `!used && |createdAt diff| < 10000`，fallback 遍历找第一个 `!used`
- assistant：`visibleAssistantsByContent.get(text)` 遍历找第一个 `!used`

## 改动详情

### 改动 1：reconcileUserMessageVersions 预处理 Map（替代 filter）

```ts
export function reconcileUserMessageVersions(messages, visibleThreadMessages, cache?) {
  if (visibleThreadMessages.length === 0) return messages  // 早返回优化（原为 filter 后判空）

  const visibleUsersById = new Map<string, AgentMessage>()
  const visibleUsersByContent = new Map<string, AgentMessage[]>()
  const visibleAssistantsByContent = new Map<string, AgentMessage[]>()
  for (const message of visibleThreadMessages) {
    if (message.role === 'user') {
      visibleUsersById.set(message.id, message)
      pushGroup(visibleUsersByContent, message.content, message)
    } else if (message.role === 'assistant') {
      pushGroup(visibleAssistantsByContent, message.content, message)
    }
  }
  if (visibleUsersById.size === 0 && visibleAssistantsByContent.size === 0) return messages

  // cache 清理（不变）...
  const usedVisibleIds = new Set<string>()
  const usedVisibleAssistantIds = new Set<string>()
  return messages.map(message => {
    const visible = matchVisibleMessage(message, visibleUsersById, visibleUsersByContent, visibleAssistantsByContent, usedVisibleIds, usedVisibleAssistantIds)
    // cache + applyReconciledMessage（不变）
  })
}

function pushGroup(map: Map<string, AgentMessage[]>, key: string, message: AgentMessage): void {
  const list = map.get(key)
  if (list) list.push(message)
  else map.set(key, [message])
}
```

### 改动 2：matchVisibleMessage 用 Map 查找（替代 find）

```ts
function matchVisibleMessage(
  message: RuntimeMessageView,
  visibleUsersById: Map<string, AgentMessage>,
  visibleUsersByContent: Map<string, AgentMessage[]>,
  visibleAssistantsByContent: Map<string, AgentMessage[]>,
  usedVisibleIds: Set<string>,
  usedVisibleAssistantIds: Set<string>,
): AgentMessage | undefined {
  if (message.type === 'user') {
    if (message.messageId) {
      return visibleUsersById.get(message.messageId)
    }
    const group = visibleUsersByContent.get(message.text) ?? []
    const withinWindow = group.find(item => (
      !usedVisibleIds.has(item.id)
      && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
    ))
    if (withinWindow) {
      usedVisibleIds.add(withinWindow.id)
      return withinWindow
    }
    const byContent = group.find(item => !usedVisibleIds.has(item.id))
    if (byContent) {
      usedVisibleIds.add(byContent.id)
      return byContent
    }
    return undefined
  }
  if (message.type === 'assistant') {
    const group = visibleAssistantsByContent.get(message.text) ?? []
    const visible = group.find(item => !usedVisibleAssistantIds.has(item.id))
    if (visible) {
      usedVisibleAssistantIds.add(visible.id)
      return visible
    }
    return undefined
  }
  return undefined
}
```

> matchVisibleMessage 签名变（3 个 Map 替 2 个数组），但 reconcileUserMessageVersions 是唯一调用方，同步改即可。

### 不变

- `applyReconciledMessage`（spread 逻辑）不变。
- `ReconcileCache`（2c 引用缓存）不变 —— 仍在 matchVisibleMessage 外层做引用缓存。
- 早返回逻辑：原 `if (visibleUsers.length === 0 && visibleAssistants.length === 0) return messages` 改为 Map 构建后判空（语义等价：无 user/assistant visible 则早返回）。

## 等价性（关键）

Map 化必须保持匹配语义等价，否则破坏现有 5 个 reconcile test：

1. **user messageId**：原 `visibleUsers.find(id === messageId)`（第一个匹配，不考虑 used）→ `visibleUsersById.get(messageId)`。visible.id 唯一（持久化消息 id）→ Map 存唯一 → 等价。
2. **user fuzzy**：原 `find(!used && content === text && 时间窗) ?? find(!used && content === text)` 遍历 visibleUsers（数组顺序）→ Map: `visibleUsersByContent.get(text)` 的 group（按 visibleThreadMessages 中 user 出现顺序 push）遍历。原 find 跳过 content !== text 的（不匹配）→ Map 直接定位同 content → **group 顺序 = visibleUsers 中同 content 顺序** → 等价。
3. **assistant**：原 `find(!used && content === text)` → `visibleAssistantsByContent.get(text)` group 遍历 → 等价（同 2）。
4. **used 状态推进**：原 find 后 `usedVisibleIds.add(visible.id)` → Map 版同样 add。等价。

**现有 5 个 reconcile test**（AgentMessages.test.ts：keeps unmatched stable / restores attachments / uses visible content / restores token usage / restores messageId+completedAt）覆盖各匹配分支，是等价护栏。

## test 策略

- **现有 5 reconcile test**：守护语义等价（算法优化不改匹配结果）。这是核心护栏。
- **现有 3 个 2c 引用稳定 test**：守护 ReconcileCache 不受影响（2e 不动 cache 层）。
- **typecheck**：matchVisibleMessage 签名变（Map 参数），reconcileUserMessageVersions 调用同步改，类型正确。
- **回归**：projection 26/1、AgentMessages 30/0、agent 目录 117/23/18（= 2b/2c/2d 基线）。
- 不加 benchmark test（复杂度优化难自动测，等价性由现有 test 守护足够）。

## 范围边界（YAGNI）

**包含**：reconcileUserMessageVersions 的 Map 预处理 + matchVisibleMessage 用 Map 查找。

**不包含**：
- ReconcileCache（2c）改动。
- applyReconciledMessage（spread 逻辑）改动。
- 其他 agent-message-state.ts 函数（projectVisibleThreadMessages / stabilize / 等）。
- 复杂度 benchmark test。

## 风险

1. **匹配顺序等价**：fuzzy/assistant 的 find 顺序依赖 visibleThreadMessages 顺序。Map<content, group> 的 group 按 push 顺序（= visibleThreadMessages 顺序）。**必须确认 pushGroup 保持顺序**（push 到数组末尾，不排序）→ 等价。
2. **visible.id 唯一性假设**：messageId 匹配用 Map<id>，假设 visible.id 唯一。若异常重复 id，原 find 返回第一个，Map.set 覆盖为最后一个 → 不等价。但持久化消息 id 唯一（数据库主键），边界情况不实际发生。现有 test 不覆盖重复 id（合理）。
3. **早返回条件变化**：原 filter 后判 `visibleUsers.length === 0 && visibleAssistants.length === 0` → Map 构建后判 `visibleUsersById.size === 0 && visibleAssistantsByContent.size === 0`。语义等价（无 user/assistant visible）。但 visibleThreadMessages 可能有 system/其他 role → 不进任何 Map → 早返回。原 filter 也只取 user/assistant → 等价。
4. **性能边界**：同 content 的 visible 消息多时（异常），group 遍历退化。但正常情况每 content 1-2 条。YAGNI。
