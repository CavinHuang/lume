# Phase 2e：reconcile 算法优化（filter+find → Map 索引）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **所属**：性能优化路线图 Phase 2 收尾算法优化。2a/2b/2c/2d 已完成。2c 给 reconcile 加了 `ReconcileCache` 引用缓存层，未动匹配算法；本 plan 优化匹配算法。设计依据：`docs/superpowers/specs/2026-06-21-perf-fe-2e-reconcile-algorithm-design.md`。

**Goal:** 用 Map 索引替代 filter+find，把 reconcile 复杂度从 O(M×V) 降到 O(V + M×avg_content_group)。

**Architecture:** 预处理 visibleThreadMessages 构建 3 个 Map（visibleUsersById / visibleUsersByContent / visibleAssistantsByContent，O(V) 一次）；matchVisibleMessage 用 Map 查找替代线性 find。ReconcileCache（2c）+ applyReconciledMessage 不变。

**Tech Stack:** TypeScript + bun:test。无新依赖、无新 test。

**审查依据:** `agent-message-state.ts` 当前 `reconcileUserMessageVersions`（filter × 2 + 早返回 + cache + map）+ `matchVisibleMessage`（user messageId find / user fuzzy find×2 / assistant find）。现有 5 reconcile test + 3 引用稳定 test（AgentMessages.test.ts）是等价护栏。

**test 策略（无新 test）:** 纯算法优化不改语义，现有 5 reconcile test 守护等价；typecheck 守护 matchVisibleMessage 签名变更。

---

## File Structure

- Modify: `apps/web/src/components/agent/agent-message-state.ts` — `reconcileUserMessageVersions` 改 Map 预处理（替 filter）；`matchVisibleMessage` 签名改 3 个 Map 参数 + 用 Map 查找（替 find）；新增 `pushGroup` helper。
- 不改：`applyReconciledMessage`、`ReconcileCache`、`projectVisibleThreadMessages`、stabilize、其他函数、AgentMessages.tsx（cache 用法不变）。

---

## Task 1：reconcile Map 化实现

**Files:**
- Modify: `apps/web/src/components/agent/agent-message-state.ts`

- [ ] **Step 1: reconcileUserMessageVersions 改 Map 预处理**

把当前 `reconcileUserMessageVersions`（2c 版本，含 filter + 早返回 + cache + map 调 matchVisibleMessage）替换为 Map 预处理版本：

```ts
export function reconcileUserMessageVersions(
  messages: RuntimeMessageView[],
  visibleThreadMessages: AgentMessage[],
  cache?: ReconcileCache,
): RuntimeMessageView[] {
  if (visibleThreadMessages.length === 0) return messages

  const visibleUsersById = new Map<string, AgentMessage>()
  const visibleUsersByContent = new Map<string, AgentMessage[]>()
  const visibleAssistantsByContent = new Map<string, AgentMessage[]>()
  for (const visible of visibleThreadMessages) {
    if (visible.role === 'user') {
      visibleUsersById.set(visible.id, visible)
      pushGroup(visibleUsersByContent, visible.content, visible)
    } else if (visible.role === 'assistant') {
      pushGroup(visibleAssistantsByContent, visible.content, visible)
    }
  }
  if (visibleUsersById.size === 0 && visibleAssistantsByContent.size === 0) return messages

  const effectiveCache = cache ?? new Map()
  const liveIds = new Set(messages.map((message) => message.id))
  for (const id of effectiveCache.keys()) {
    if (!liveIds.has(id)) effectiveCache.delete(id)
  }

  const usedVisibleIds = new Set<string>()
  const usedVisibleAssistantIds = new Set<string>()
  return messages.map((message) => {
    const visible = matchVisibleMessage(
      message,
      visibleUsersById,
      visibleUsersByContent,
      visibleAssistantsByContent,
      usedVisibleIds,
      usedVisibleAssistantIds,
    )
    const cached = effectiveCache.get(message.id)
    if (cached && cached.projectedRef === message && cached.visibleRef === visible) {
      return cached.result
    }
    const result = applyReconciledMessage(message, visible)
    effectiveCache.set(message.id, { projectedRef: message, visibleRef: visible, result })
    return result
  })
}

function pushGroup(map: Map<string, AgentMessage[]>, key: string, message: AgentMessage): void {
  const list = map.get(key)
  if (list) list.push(message)
  else map.set(key, [message])
}
```

> 改动：2 次 filter → 1 次 for 循环构建 3 个 Map；早返回从 `visibleUsers.length === 0 && visibleAssistants.length === 0` → `visibleUsersById.size === 0 && visibleAssistantsByContent.size === 0`（语义等价）。cache 清理 + map + applyReconciledMessage 不变。

- [ ] **Step 2: matchVisibleMessage 改 Map 查找（签名变）**

把当前 `matchVisibleMessage`（2c 版本，参数为 visibleUsers/visibleAssistants 数组，内部 find）替换为 Map 参数版本：

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
    const withinWindow = group.find((item) => (
      !usedVisibleIds.has(item.id)
      && Math.abs(item.createdAt - Date.parse(message.createdAt)) < 10_000
    ))
    if (withinWindow) {
      usedVisibleIds.add(withinWindow.id)
      return withinWindow
    }
    const byContent = group.find((item) => !usedVisibleIds.has(item.id))
    if (byContent) {
      usedVisibleIds.add(byContent.id)
      return byContent
    }
    return undefined
  }
  if (message.type === 'assistant') {
    const group = visibleAssistantsByContent.get(message.text) ?? []
    const visible = group.find((item) => !usedVisibleAssistantIds.has(item.id))
    if (visible) {
      usedVisibleAssistantIds.add(visible.id)
      return visible
    }
    return undefined
  }
  return undefined
}
```

> 改动：参数 2 个数组 → 3 个 Map；user messageId `find(id===)` → `Map.get(id)`；user fuzzy `visibleUsers.find(...)` → `visibleUsersByContent.get(text).find(...)`（group 是同 content 子集，保 visibleThreadMessages 顺序）；assistant 同理。used 推进逻辑不变。
>
> **等价性**（spec 风险 1）：`pushGroup` 按_visibleThreadMessages 顺序 push 到 group 末尾 → group 顺序 = visibleUsers 中同 content 顺序 → `group.find` 等价原 `visibleUsers.find`（原 find 跳过 content !== text 的，Map 直接定位同 content）。

- [ ] **Step 3: typecheck 确认签名变更正确**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0（matchVisibleMessage 新签名 + reconcileUserMessageVersions 调用同步改 + pushGroup 类型）。

- [ ] **Step 4: 运行现有 reconcile test 确认等价**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts 2>&1 | tail -4`
Expected: **30 pass / 0 fail**（5 个 reconcile test + 3 个 2c 引用稳定 test 全绿，证明 Map 化语义等价）。

> 若有 reconcile test fail：对照 fail 的匹配分支（messageId / fuzzy / assistant），检查 Map 构建顺序（pushGroup 保序）或 used 推进逻辑。spec 等价性 4 点是排查依据。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/agent-message-state.ts
git commit -m "⚡️ perf(web): reconcile 算法优化 filter+find → Map 索引（O(M×V)→O(V+M×group)）"
```

---

## Task 2：回归验证

**Files:** 无改动（仅验证）

- [ ] **Step 1: 现有 test 回归**

Run: `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts 2>&1 | tail -3`
Expected: 26 pass / 1 fail（pre-existing compaction 不变）。

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts 2>&1 | tail -3`
Expected: 30 pass / 0 fail。

Run: `bun test apps/web/src/components/agent/ 2>&1 | tail -3`
Expected: 117 pass / 23 fail / 18 errors（= 2b/2c/2d 基线，全 pre-existing）。

- [ ] **Step 2: typecheck 全量**

Run: `bun run --filter @lume/web typecheck`
Expected: exit 0。

- [ ] **Step 3: 调用方契约检查**

确认 reconcile 改动未破坏消费方：
- `reconcileUserMessageVersions` 签名不变（messages, visibleThreadMessages, cache?）→ AgentMessages.tsx 调用兼容。✓
- `matchVisibleMessage` 是模块内私有函数（reconcileUserMessageVersions 唯一调用方），签名变不影响外部。✓
- `ReconcileCache`（2c）+ `applyReconciledMessage` 不变 → AgentMessages 的 reconcileCacheRef 用法兼容。✓

- [ ] **Step 4: 隔离对比（可选）**

```bash
git checkout HEAD~1 -- apps/web/src/components/agent/agent-message-state.ts
bun test apps/web/src/components/agent/AgentMessages.test.ts 2>&1 | tail -3  # 2d 基线
git checkout HEAD -- apps/web/src/components/agent/agent-message-state.ts  # 恢复
```
对比：2e 后 reconcile test 结果应与 2d 一致（语义等价）。

---

## 注意事项与边界

- **纯算法优化，零语义变更**：2e 只改 reconcile 的匹配实现（filter+find → Map），不改匹配规则、不改 ReconcileCache、不改 applyReconciledMessage。现有 5 reconcile test 是等价护栏。
- **pushGroup 保序是等价关键**：group 必须按 visibleThreadMessages 顺序 push（不排序），保证 `group.find` 等价原 `visibleUsers.find`。
- **visible.id 唯一假设**：messageId 匹配用 Map<id>，假设持久化消息 id 唯一（数据库主键保证）。异常重复 id 不实际发生。
- **O(M×V) → O(V + M×group)**：同 content 的 visible 通常 1-2 条，group 遍历近 O(1)。长会话（M、V 大）收益最大。
- **Surgical Changes**：只改 reconcileUserMessageVersions + matchVisibleMessage + 新增 pushGroup。不动其他。
