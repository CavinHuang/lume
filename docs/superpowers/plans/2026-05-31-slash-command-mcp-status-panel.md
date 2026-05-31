# 斜杠命令 MCP 状态面板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在输入框输入 `/` 选中 `/mcp` 后，命令面板切换为 MCP 服务状态列表（只读、两阶段交互）。

**Architecture:** 扩展现有 `MentionList` 组件，增加 `mcp-status` 面板模式。选中 `/mcp` 时拦截默认的 `command()` 调用，改为切换到 MCP 状态视图，复用已有的 `buildMcpServerRows` 和 `getMcpStatus` 数据层。

**Tech Stack:** React、TipTap Suggestion、Jotai、Tailwind CSS、`@/lib/desktop-api/mcp`

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `apps/web/src/components/agent/MentionList.tsx` | 添加 MCP 状态面板模式（核心） |
| 修改 | `apps/web/src/components/agent/editor-mention-suggestions.ts` | 传递 `getWorkspaceSlug` 到 MentionList |

---

### Task 1: 扩展 MentionList 组件支持 MCP 状态面板

**Files:**
- 修改: `apps/web/src/components/agent/MentionList.tsx`

- [ ] **Step 1: 添加 MCP 相关 imports**

在 `MentionList.tsx` 文件顶部的 import 区域添加：

```typescript
import { getMcpConfig, getMcpStatus } from '@/lib/desktop-api'
import { buildMcpServerRows, type McpServerRow, type McpUiStatus } from '@/components/settings/mcp-settings-state'
import { ArrowLeft, Loader2 } from 'lucide-react'
```

- [ ] **Step 2: 扩展 MentionListProps 接口**

将现有的 `MentionListProps` 接口添加 `getWorkspaceSlug` 可选属性：

```typescript
interface MentionListProps {
  items: MentionItem[]
  command: (item: { id: string; label: string }) => void
  trigger?: '@' | '/' | '#' | '$'
  getWorkspaceSlug?: () => string | null
}
```

解构 props 时也加上：

```typescript
function MentionList({ items, command, trigger = '/', getWorkspaceSlug }: MentionListProps, ref) {
```

- [ ] **Step 3: 添加面板模式状态和 MCP 数据状态**

在组件内部，`const [selectedIndex, setSelectedIndex] = useState(0)` 之后添加：

```typescript
const [panelMode, setPanelMode] = useState<'commands' | 'mcp-status'>('commands')
const [mcpRows, setMcpRows] = useState<McpServerRow[]>([])
const [mcpLoading, setMcpLoading] = useState(false)
const [mcpSelectedIndex, setMcpSelectedIndex] = useState(0)
```

- [ ] **Step 4: 添加 fetchMcpData 回调**

在 `selectItem` 之前添加：

```typescript
const fetchMcpData = useCallback(async () => {
  const slug = getWorkspaceSlug?.()
  if (!slug) return
  setMcpLoading(true)
  try {
    const [statusResult, configResult] = await Promise.all([
      getMcpStatus(slug, { waitForConnections: false }),
      getMcpConfig(slug),
    ])
    const rows = buildMcpServerRows(configResult?.servers, statusResult?.servers)
    setMcpRows(rows)
  } catch {
    setMcpRows([])
  } finally {
    setMcpLoading(false)
  }
}, [getWorkspaceSlug])
```

- [ ] **Step 5: 修改 selectItem 拦截 /mcp**

将现有的 `selectItem` 修改为拦截 `/mcp` 命令：

```typescript
const selectItem = useCallback((index: number) => {
  const item = displayItems[index]
  if (!item) return
  if (item.id === 'mcp' && item.type === 'command') {
    setPanelMode('mcp-status')
    setMcpSelectedIndex(0)
    fetchMcpData()
    return
  }
  command({ id: item.id, label: item.label })
}, [displayItems, command, fetchMcpData])
```

- [ ] **Step 6: 修改 useImperativeHandle 的 onKeyDown 处理 MCP 模式**

将现有的 `useImperativeHandle` 替换为支持两种模式的版本：

```typescript
useImperativeHandle(ref, () => ({
  onKeyDown: ({ event }: { event: KeyboardEvent }) => {
    // MCP 状态模式键盘处理
    if (panelMode === 'mcp-status') {
      if (event.key === 'Escape') {
        return false // 让父级关闭弹窗
      }
      if (event.key === 'Backspace') {
        setPanelMode('commands')
        return true
      }
      if (mcpRows.length > 0) {
        if (event.key === 'ArrowUp') {
          setMcpSelectedIndex((i) => (i + mcpRows.length - 1) % mcpRows.length)
          return true
        }
        if (event.key === 'ArrowDown') {
          setMcpSelectedIndex((i) => (i + 1) % mcpRows.length)
          return true
        }
      }
      return false
    }

    // 命令列表模式（原有逻辑）
    if (displayItems.length === 0) return false
    if (event.key === 'ArrowUp') {
      setSelectedIndex((i) => (i + displayItems.length - 1) % displayItems.length)
      return true
    }
    if (event.key === 'ArrowDown') {
      setSelectedIndex((i) => (i + 1) % displayItems.length)
      return true
    }
    if (event.key === 'Enter') {
      selectItem(selectedIndex)
      return true
    }
    return false
  },
}))
```

- [ ] **Step 7: 在组件 return 之前添加 MCP 状态面板渲染**

在 `if (displayItems.length === 0) { ... }` 之后、`const iconMap = { ... }` 之前，插入 MCP 面板的早期返回：

```typescript
if (panelMode === 'mcp-status') {
  return (
    <div className="w-full overflow-hidden rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_98%,transparent)] shadow-[0_18px_46px_-34px_hsl(var(--shadow-panel)/0.42)]">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3 py-2.5">
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_52%,transparent)] hover:text-[var(--text-2)]"
          onClick={() => setPanelMode('commands')}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-[12px] font-medium text-[var(--text-1)]">MCP 服务状态</span>
      </div>

      {/* 内容区 */}
      {mcpLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-[var(--text-3)]" />
        </div>
      ) : mcpRows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-[var(--text-3)]">
          暂无 MCP 服务配置
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto p-2">
          {mcpRows.map((row, index) => (
            <div
              key={row.name}
              className={cn(
                'flex items-center gap-2.5 rounded-[0.75rem] px-2.5 py-2 transition-colors',
                index === mcpSelectedIndex
                  ? 'bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)]'
                  : 'hover:bg-[color:color-mix(in_oklab,var(--surface-3)_42%,transparent)]'
              )}
              onMouseEnter={() => setMcpSelectedIndex(index)}
            >
              <span className={cn('size-2 shrink-0 rounded-full', getMcpStatusDotClass(row.status))} />
              <span className="truncate text-[12px] font-medium text-[var(--text-1)]">
                {row.displayName}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-[var(--text-3)]">
                {row.toolCount > 0 ? `${row.toolCount} 个工具` : '无工具'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 底栏提示 */}
      <div className="flex items-center justify-between border-t border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] px-3 py-1.5 text-[10px] text-[var(--text-3)]">
        <span>← 返回命令列表</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: 在文件末尾添加状态圆点辅助函数**

在 `getMentionSectionLabel` 函数之后添加：

```typescript
function getMcpStatusDotClass(status: McpUiStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-[#20c872]'
    case 'connecting':
      return 'bg-[#4f7df3] animate-pulse'
    case 'warning':
      return 'bg-[#ff9d2e]'
    case 'disconnected':
      return 'bg-[#a3aabc]'
    default:
      return 'bg-[#a3aabc]'
  }
}
```

注意：颜色值复用自 `McpSettings.tsx` 中 `StatusPill` 组件的配色。

- [ ] **Step 9: 验证构建通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && pnpm --filter web exec tsc --noEmit 2>&1 | head -30`

Expected: 无类型错误（或仅与本次改动无关的既有错误）

---

### Task 2: 传递 getWorkspaceSlug 到 MentionList

**Files:**
- 修改: `apps/web/src/components/agent/editor-mention-suggestions.ts`

- [ ] **Step 1: 在 createSuggestionRenderer 的 onStart 中传递 getWorkspaceSlug**

在 `createSuggestionRenderer` 函数中，`onStart` 回调里的 `new ReactRenderer(MentionList, { ... })` 调用处，将 props 中添加 `getWorkspaceSlug`：

找到（约第 89-92 行）：
```typescript
component = new ReactRenderer(MentionList, {
  props: { ...props, trigger: char as '@' | '/' | '#' | '$' },
  editor: props.editor,
})
```

替换为：
```typescript
component = new ReactRenderer(MentionList, {
  props: { ...props, trigger: char as '@' | '/' | '#' | '$', getWorkspaceSlug },
  editor: props.editor,
})
```

- [ ] **Step 2: 验证构建通过**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && pnpm --filter web exec tsc --noEmit 2>&1 | head -30`

Expected: 无类型错误

---

### Task 3: 手动验证与提交

- [ ] **Step 1: 启动开发服务器**

Run: `cd /Users/cavinhuang/workspace/projects/ai-projects/Lume && pnpm --filter web dev`

- [ ] **Step 2: 手动测试交互流程**

验证以下场景：
1. 输入框输入 `/` → 命令列表弹出，包含 `/mcp` 选项
2. 键盘上下键导航到 `/mcp`，按 Enter → 面板切换为 MCP 状态列表
3. MCP 状态列表显示：状态圆点（颜色正确）、服务名称、工具数量
4. 点击左上角返回按钮 → 回到命令列表
5. 再选 `/mcp` → 按 Backspace → 回到命令列表
6. 选 `/mcp` → 按 Escape → 面板关闭
7. 选 `/mcp` → 点击面板外部 → 面板关闭
8. 无 MCP 配置时 → 显示 "暂无 MCP 服务配置"
9. 其他命令（`/clear`, `/compact` 等）不受影响

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/agent/MentionList.tsx apps/web/src/components/agent/editor-mention-suggestions.ts
git commit -m "✨ feat: 输入框 /mcp 命令面板显示 MCP 服务状态"
```

---

## 自检

- **规格覆盖**：设计文档中的交互流程、状态机、UI 视觉规范、键盘交互均有对应实现步骤
- **占位符**：无 TBD/TODO，所有代码步骤包含完整实现
- **类型一致性**：`McpServerRow`、`McpUiStatus` 类型来自 `mcp-settings-state.ts`，与 McpSettings 使用同一数据源；`getWorkspaceSlug` 类型在 props 和 renderer 参数中一致
