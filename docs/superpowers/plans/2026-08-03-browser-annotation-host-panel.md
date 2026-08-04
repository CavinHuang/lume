# 浏览器注释宿主面板对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`).
> **依据**：调查报告（Codex app-initial PR diff 评审模型实证）+ spec §4.4。
> **重要前提**：Codex 浏览器批注本身无 resolved/thread/unread（调查确认）——这些是 Codex **PR/diff 评审面板**模型。Plan 7 是跨特性移植（PR 模型→浏览器批注），非同类对齐。

**Goal:** 把 Codex PR diff 评审的 resolved/thread/unread/author 模型移植到 Lume 浏览器批注：扩展 AgentBrowserAnnotationAttachment（reviewThreadId/inReplyToId/isResolved/resolvedAt/resolvedBy/author/readAt）+ store 方法（resolveComment/addReply/markRead）+ 新建右栏 CommentList 组件（按线程分组 + resolved 折叠/徽章 + 未读计数 + author 区分）+ BrowserShell 集成。

**Architecture:** resolved/thread/unread 落在 `annotationSession.comments`（落盘层），不落 `reviewSession.items`（暂存队列，promote 后清空，生命周期短）。线程用 `reviewThreadId` 分组扁平 comments（Codex 同策略）。未读用 `readAt`（自创，Codex 浏览器批注无先例），resolved 不计入未读。保留 Lume valid/stale（页漂，不混 resolved）。UI 在 BrowserShell 右栏 surface 新建 CommentList。

**Tech Stack:** React 18.3.1、TypeScript、bun:test + happy-dom。

## Global Constraints

1. **跨特性移植 Codex PR 模型**（调查确认 Codex 浏览器批注无 resolved/thread/unread）：reviewThreadId/inReplyToId 线程分组；isResolved/resolvedAt/resolvedBy 状态；readAt 未读；author {kind:'user'|'agent',name?}。
2. **保留 Lume valid/stale**（页漂检测，不混 resolved）。resolved 只落 annotationSession.comments（落盘层）。
3. **线程**：reviewThreadId 分组扁平 comments（Codex 同策略，不嵌套 replies 数组）；inReplyToId 指向父评论。
4. **未读**：readAt 自创（Codex 无先例）；计数 = `comments.filter(c => !c.readAt && !c.isResolved).length`。
5. **向后兼容**：新字段全可选；现有 comments/attachment 不破；version 2 不变。
6. 仓库用 **bun**；测试 **bun:test + happy-dom**；**React 18.3.1**。
7. **无 commit 工作流**；**中文注释**；**LF**。
8. **web UI 生产改动**（BrowserShell 右栏列表 = 用户可见 UI 改动）。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `packages/shared/src/types/agent.ts` | AgentBrowserAnnotationAttachment 加 reviewThreadId?/inReplyToId?/isResolved?/resolvedAt?/resolvedBy?/author?/readAt? | **改** |
| `apps/sidecar/src/rpc/schemas.ts` | 新字段 schema 校验 | **改** |
| `apps/desktop/src/browser-annotation-session.ts` | resolveComment/addReply/markRead 方法 | **改** |
| `apps/web/src/components/browser/CommentList.tsx` | 右栏评论列表面板（分组/resolved/未读/线程/author） | **新建** |
| `apps/web/src/components/browser/BrowserShell.tsx` | 右栏 surface 渲染 CommentList + 未读计数徽标 | **改** |

---

## Task 91: shared types + schema 新字段

**目标**：AgentBrowserAnnotationAttachment 加 7 个可选字段（reviewThreadId/inReplyToId/isResolved/resolvedAt/resolvedBy/author/readAt）+ sidecar schema 校验。全向后兼容。

**Files:** packages/shared/src/types/agent.ts + apps/sidecar/src/rpc/schemas.ts + test

- [ ] **Step 1: 类型扩展**（AgentBrowserAnnotationAttachment 加字段，全可选）
- [ ] **Step 2: schema 校验**（reviewThreadId/inReplyToId string(<=256)；isResolved boolean；resolvedAt/resolvedBy/readAt string(<=64)；author object {kind enum, name?}）
- [ ] **Step 3: 测试**（新字段通过/拒绝非法；向后兼容旧 payload 无新字段仍通过）
- [ ] **Step 4: verify** typecheck + schema test

---

## Task 92: store resolveComment/addReply/markRead

**目标**：session store 加 3 方法（resolveComment 翻 isResolved/resolvedAt/resolvedBy；addReply 复用 saveComment + 补 reviewThreadId/inReplyToId；markRead 写 readAt）。

**Files:** apps/desktop/src/browser-annotation-session.ts + test

- [ ] **Step 1: 写失败测试**（resolveComment 翻 isResolved + resolvedAt/By；addReply 补线程字段；markRead 写 readAt）
- [ ] **Step 2: 实现 3 方法**（参照 saveComment/deleteComment 模式；resolveComment 翻 boolean + 时间戳；addReply 复用 saveComment + 补 reviewThreadId = parent.reviewThreadId ?? parent.id, inReplyToId = parent.id；markRead 写 readAt = new Date().toISOString()）
- [ ] **Step 3: 测试通过 + verify**

---

## Task 93: CommentList 组件

**目标**：新建右栏评论列表面板组件——按 reviewThreadId 分组扁平 comments + resolved 折叠/徽章 + 未读计数 + 线程形态（root + replies）+ author 区分。

**Files:** apps/web/src/components/browser/CommentList.tsx + test

- [ ] **Step 1: 写失败测试**（分组渲染；resolved 折叠 + 徽章；未读计数；线程 root+replies；author 标签）
- [ ] **Step 2: 实现 CommentList**（props: {comments, onResolve, onMarkRead}；deriveThreads(comments) 按 reviewThreadId 分组；resolved thread 默认折叠 + "已解决" 徽章；未读 = !readAt && !isResolved；author kind 标签 user/agent）
- [ ] **Step 3: 测试通过 + verify**

---

## Task 94: BrowserShell 集成

**目标**：BrowserShell 右栏 surface 渲染 CommentList + 未读计数徽标 + resolved/thread 渲染。annotationSession.comments → CommentList。未读计数派生。

**Files:** apps/web/src/components/browser/BrowserShell.tsx + test

- [ ] **Step 1: 集成 CommentList**（右栏 surface 渲染；comments = annotationSession?.comments ?? []；未读计数 = comments.filter(!readAt && !isResolved)）
- [ ] **Step 2: 未读计数徽标**（现有计数旁加 unreadAnnotationCount）
- [ ] **Step 3: onResolve/onMarkRead 回调**（调 annotation:resolve / annotation:mark-read IPC → manager store）
- [ ] **Step 4: manager onGuestMessage 加 annotation:resolve / annotation:mark-read**（→ store.resolveComment/markRead）
- [ ] **Step 5: 测试 + verify**

---

## Task 95: 整合验证

- [ ] 全量 typecheck + build + test + 生产影响确认（右栏列表 UI 改动）
- [ ] 向后兼容（旧 comments 无新字段仍渲染）

---

## 完成判据

1. 7 新字段（reviewThreadId/inReplyToId/isResolved/resolvedAt/resolvedBy/author/readAt）+ schema 校验。
2. store resolveComment/addReply/markRead。
3. CommentList 组件（分组/resolved/未读/线程/author）。
4. BrowserShell 右栏集成 + 未读徽标 + resolve/markRead IPC。
5. 向后兼容 + typecheck/build/test 绿。
6. 无 commit。

## Self-Review

**1. 覆盖**：resolved（91 isResolved + 92 resolveComment + 93 折叠/徽章）✓；thread（91 reviewThreadId/inReplyToId + 93 分组/replies）✓；unread（91 readAt + 92 markRead + 93 计数 + 94 徽标）✓；author（91 author + 93 标签）✓；列表 UI（93 CommentList + 94 集成）✓。
**2. 向后兼容**：全可选字段；旧 comments 无新字段 → 无线程分组（每个 comment 独立 root）、无 resolved、无未读（readAt undefined → 全未读？需确认：旧 comments readAt undefined = 未读？或默认已读？）。**实施决策**：readAt undefined = 未读（新批注默认未读）；旧 comments（已存在的）可默认已读（migration 或渲染逻辑）。实施时确认。
**3. 跨特性移植**：Codex 浏览器批注无此（PR 模型移植）。保留 valid/stale。
