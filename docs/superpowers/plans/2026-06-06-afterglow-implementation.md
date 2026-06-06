# 余光 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Lume's "余光" text-side-channel: `⟡ ...` lines render subtly in assistant text, copy cleanly, and are stripped before memory/summary/context reuse.

**Architecture:** Use a shared parser/stripper in `@lume/shared` so web rendering and sidecar filtering share the same rules. Keep runtime message schema unchanged; prompt allows low-frequency `⟡` lines, web splits assistant text into Markdown and afterglow blocks, and sidecar filters afterglow before memory summaries and compaction.

**Tech Stack:** TypeScript, Bun test, React, `@ant-design/x-markdown`, existing Lume sidecar runtime and memory-v2 services.

---

## File Structure

- Create `packages/shared/src/afterglow.ts`
  - Owns the protocol regex, code-fence-aware parser, and `stripAfterglowLines`.
  - Exports small pure functions only; no React or sidecar dependencies.
- Create `packages/shared/src/afterglow.test.ts`
  - Covers parser and stripper behavior, including list-prefix drift and code fences.
- Modify `packages/shared/src/index.ts`
  - Re-export afterglow helpers.
- Modify `apps/sidecar/src/services/agent/prompt/sections/core-sections.ts`
  - Adds the prompt rules for low-frequency "余光".
- Create `apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts`
  - Verifies the prompt includes the protocol and key boundaries.
- Modify `apps/sidecar/src/services/memory-v2/conversation-summary.ts`
  - Strips afterglow from fallback summaries and generated summary inputs.
- Modify `apps/sidecar/src/services/agent-runtime/context/context-controller.ts`
  - Strips afterglow from assistant text blocks before compaction.
- Modify relevant sidecar tests:
  - `apps/sidecar/src/services/memory-v2/conversation-summary.test.ts`
  - `apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts`
- Modify `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
  - Splits assistant text into Markdown and afterglow blocks inside `SmoothText`.
  - Adds an afterglow component and copy sanitization.
- Modify `apps/web/src/components/agent/RuntimeEventContentBlock.test.ts`
  - Tests the copy sanitizer helper if exported from the component.
- Create `apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx`
  - Tests rendered afterglow markup using server rendering with existing mocks.

## Chunk 1: Shared Protocol

### Task 1: Add Shared Afterglow Parser And Stripper

**Files:**
- Create: `packages/shared/src/afterglow.ts`
- Create: `packages/shared/src/afterglow.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing shared tests**

Create `packages/shared/src/afterglow.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  AFTERGLOW_MARKER,
  isAfterglowLine,
  parseAfterglowBlocks,
  stripAfterglowLines
} from "./afterglow";

describe("afterglow protocol", () => {
  test("recognizes plain and list-prefixed afterglow lines", () => {
    expect(AFTERGLOW_MARKER).toBe("⟡");
    expect(isAfterglowLine("⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("- ⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("* ⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("+ ⟡ careful edge")).toEqual({ matched: true, text: "careful edge" });
    expect(isAfterglowLine("text ⟡ careful edge")).toEqual({ matched: false });
  });

  test("splits markdown and afterglow blocks outside code fences", () => {
    expect(parseAfterglowBlocks([
      "First paragraph",
      "",
      "⟡ quiet judgment",
      "",
      "```ts",
      "⟡ const marker = true",
      "```",
      "",
      "Final paragraph"
    ].join("\n"))).toEqual([
      { type: "markdown", text: "First paragraph\n" },
      { type: "afterglow", text: "quiet judgment" },
      { type: "markdown", text: "\n```ts\n⟡ const marker = true\n```\n\nFinal paragraph" }
    ]);
  });

  test("strips afterglow while preserving fenced code", () => {
    const text = [
      "Answer",
      "⟡ remove me",
      "```md",
      "⟡ keep me",
      "```",
      "- ⟡ remove me too",
      "Done"
    ].join("\n");

    expect(stripAfterglowLines(text)).toBe([
      "Answer",
      "```md",
      "⟡ keep me",
      "```",
      "Done"
    ].join("\n"));
  });
});
```

- [ ] **Step 2: Run the shared tests and verify they fail**

Run:

```bash
rtk bun test packages/shared/src/afterglow.test.ts
```

Expected: FAIL because `packages/shared/src/afterglow.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared helper**

Create `packages/shared/src/afterglow.ts`:

```ts
export const AFTERGLOW_MARKER = "⟡";
export const AFTERGLOW_LINE_RE = /^(?:\s*[-*+]\s*)?⟡\s*(.+)$/;

export type AfterglowBlock =
  | { type: "markdown"; text: string }
  | { type: "afterglow"; text: string };

export type AfterglowLineMatch =
  | { matched: true; text: string }
  | { matched: false };

export function isAfterglowLine(line: string): AfterglowLineMatch {
  const match = line.match(AFTERGLOW_LINE_RE);
  if (!match) return { matched: false };
  const text = match[1]?.trim() ?? "";
  return text ? { matched: true, text } : { matched: false };
}

export function parseAfterglowBlocks(text: string): AfterglowBlock[] {
  const blocks: AfterglowBlock[] = [];
  const markdownLines: string[] = [];
  let inFence = false;
  let fenceMarker: "```" | "~~~" | null = null;

  const flushMarkdown = () => {
    if (markdownLines.length === 0) return;
    blocks.push({ type: "markdown", text: markdownLines.join("\n") });
    markdownLines.length = 0;
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.startsWith("```") ? "```" : "~~~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      markdownLines.push(line);
      continue;
    }

    const afterglow = inFence ? { matched: false } as const : isAfterglowLine(line);
    if (afterglow.matched) {
      flushMarkdown();
      blocks.push({ type: "afterglow", text: afterglow.text });
      continue;
    }

    markdownLines.push(line);
  }

  flushMarkdown();
  return blocks;
}

export function stripAfterglowLines(text: string): string {
  return parseAfterglowBlocks(text)
    .filter((block): block is Extract<AfterglowBlock, { type: "markdown" }> => block.type === "markdown")
    .map((block) => block.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
```

- [ ] **Step 4: Export the helper**

Modify `packages/shared/src/index.ts`:

```ts
export * from "./afterglow";
```

Place it with the other root exports.

- [ ] **Step 5: Run the shared tests and verify they pass**

Run:

```bash
rtk bun test packages/shared/src/afterglow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Chunk 1**

Run:

```bash
rtk git add packages/shared/src/afterglow.ts packages/shared/src/afterglow.test.ts packages/shared/src/index.ts
rtk git commit -m "✨ feat(shared): 添加余光文本协议工具" -m "新增共享 parser 和 stripper，让前端渲染与后端过滤复用同一套 ⟡ 规则。" -m "Constraint: 不新增依赖" -m "Tested: bun test packages/shared/src/afterglow.test.ts"
```

## Chunk 2: Prompt And Sidecar Filtering

### Task 2: Add Prompt Rules

**Files:**
- Modify: `apps/sidecar/src/services/agent/prompt/sections/core-sections.ts`
- Create: `apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts`

- [ ] **Step 1: Write the failing prompt test**

Create `apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildConversationStyleSection } from "./core-sections";

describe("core prompt sections", () => {
  test("includes afterglow protocol and boundaries", () => {
    const section = buildConversationStyleSection();

    expect(section).toContain("## Conversation Style");
    expect(section).toContain("余光");
    expect(section).toContain("⟡");
    expect(section).toContain("最多 1 条");
    expect(section).toContain("不能承载必要信息");
    expect(section).toContain("不要出现在工具结果、代码块、文件内容");
    expect(section).toContain("记忆、总结或上下文压缩");
  });
});
```

- [ ] **Step 2: Run the prompt test and verify it fails**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts
```

Expected: FAIL because the conversation style prompt does not mention 余光 yet.

- [ ] **Step 3: Add the prompt rules**

Modify `buildConversationStyleSection()` in `apps/sidecar/src/services/agent/prompt/sections/core-sections.ts`. Append a compact section after the existing bullet list:

```ts
## 余光

你可以偶尔在主聊天、深度分析、任务总结或计划说明中加入一条「余光」：独立成行，以 `⟡` 开头。
余光是侧向心声，用来表达真实判断、风险感、取舍感，或指出当前内容和以往上下文的有意义关联。
- 只有这些信号真的出现时才写；普通执行、流水账、纯状态同步不要写。
- 每个回复或分析片段最多 1 条。
- 余光不能承载必要信息；删掉余光后，正文仍必须完整。
- 余光不要出现在工具结果、代码块、文件内容、读书笔记或正式创作产物中。
- 余光只用于界面展示，不应进入记忆、总结或上下文压缩。
```

Keep the wording in Chinese to match the existing conversation style section.

- [ ] **Step 4: Run the prompt test and verify it passes**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts
```

Expected: PASS.

### Task 3: Strip Afterglow From Memory Summaries

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/conversation-summary.ts`
- Create or modify: `apps/sidecar/src/services/memory-v2/conversation-summary.test.ts`

- [ ] **Step 1: Write the failing summary tests**

If `conversation-summary.test.ts` does not exist, create it. Add tests:

```ts
import { describe, expect, test } from "bun:test";
import {
  compactMemorySummaryText,
  summarizeMemoryConversationFallback
} from "./conversation-summary";

describe("memory conversation summary afterglow filtering", () => {
  test("fallback summary strips assistant afterglow", () => {
    const summary = summarizeMemoryConversationFallback({
      userMessage: "帮我做一个计划",
      runState: {
        generatedItems: [{
          type: "assistant_message",
          id: "assistant-1",
          content: [{ type: "text", text: "计划完成\n⟡ 这个风险先别忽略" }],
          createdAt: "2026-06-06T00:00:00.000Z"
        }]
      }
    } as Parameters<typeof summarizeMemoryConversationFallback>[0]);

    expect(summary).toContain("Assistant outcome: 计划完成");
    expect(summary).not.toContain("这个风险先别忽略");
    expect(summary).not.toContain("⟡");
  });

  test("compact summary text strips afterglow before compaction", () => {
    expect(compactMemorySummaryText("正文\n- ⟡ 不要存我\n收尾")).toBe("正文 收尾");
  });
});
```

Adjust the fake `generatedItems` shape only if the current `LumeRunItem` type requires additional fields.

- [ ] **Step 2: Run the summary tests and verify they fail**

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/conversation-summary.test.ts
```

Expected: FAIL because summary compaction does not strip afterglow yet.

- [ ] **Step 3: Filter in conversation summary helpers**

Modify `apps/sidecar/src/services/memory-v2/conversation-summary.ts`:

```ts
import { stripAfterglowLines } from "@lume/shared";
```

Update `compactMemorySummaryText`:

```ts
export function compactMemorySummaryText(value: string, maxLength = 260): string {
  const compact = stripAfterglowLines(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}
```

Update `latestAssistantOutcome()` or `textFromContent()` so assistant text is stripped before returning. Keep filtering in `compactMemorySummaryText` too; this gives a second guard for generated summaries and fallback summaries.

- [ ] **Step 4: Run the summary tests and verify they pass**

Run:

```bash
rtk bun test apps/sidecar/src/services/memory-v2/conversation-summary.test.ts
```

Expected: PASS.

### Task 4: Strip Afterglow Before Context Compaction

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-controller.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts`

- [ ] **Step 1: Write the failing context-controller test**

Add a test to `apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts`:

```ts
import { sanitizeKernelContextMessages } from "./context-controller";

test("sanitizeKernelContextMessages strips afterglow from assistant text blocks", () => {
  const messages = sanitizeKernelContextMessages([{
    role: "assistant",
    content: [
      { type: "text", text: "正文\n⟡ 不要进入压缩\n结尾" },
      { type: "tool_use", id: "tool-1", name: "Read", input: {} }
    ]
  }]);

  expect(messages[0]?.content).toEqual([
    { type: "text", text: "正文\n结尾" },
    { type: "tool_use", id: "tool-1", name: "Read", input: {} }
  ]);
});
```

- [ ] **Step 2: Run the context-controller test and verify it fails**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts
```

Expected: FAIL because assistant text blocks are passed through unchanged.

- [ ] **Step 3: Implement assistant text sanitization**

Modify `apps/sidecar/src/services/agent-runtime/context/context-controller.ts`:

```ts
import { stripAfterglowLines } from "@lume/shared";
```

Inside `sanitizeKernelContextMessages`, when `message.role === "assistant"` and `message.content` is an array, map text-like blocks:

```ts
if (message.role === "assistant") {
  const filtered = message.content.map((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
    return { ...block, text: stripAfterglowLines(block.text) };
  });
  sanitized.push({ ...message, content: filtered });
  continue;
}
```

Keep existing tool-result filtering behavior for user messages unchanged.

- [ ] **Step 4: Run sidecar filtering tests**

Run:

```bash
rtk bun test apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts apps/sidecar/src/services/memory-v2/conversation-summary.test.ts apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Chunk 2**

Run:

```bash
rtk git add apps/sidecar/src/services/agent/prompt/sections/core-sections.ts apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts apps/sidecar/src/services/memory-v2/conversation-summary.ts apps/sidecar/src/services/memory-v2/conversation-summary.test.ts apps/sidecar/src/services/agent-runtime/context/context-controller.ts apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts
rtk git commit -m "✨ feat(sidecar): 接入余光提示与上下文过滤" -m "在系统提示中定义余光规则，并在记忆总结与上下文压缩前过滤 ⟡ 行，避免展示层心声进入后续推理材料。" -m "Constraint: 不修改 runtime message schema" -m "Tested: bun test sidecar afterglow-related tests"
```

## Chunk 3: Web Rendering And Copy Behavior

### Task 5: Render Afterglow In Assistant Text

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
- Create: `apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx`:

```tsx
import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeMessageView } from './runtime-message-view'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children }: { children: React.ReactNode }) => <div data-markdown="true">{children}</div>,
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
  openInSystem: async () => undefined,
  saveTextFileDialog: async () => undefined,
  sidecarCall: async () => undefined,
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const { RuntimeEventContentBlock } = await import('./RuntimeEventContentBlock')

function renderAssistantText(text: string): string {
  const message: RuntimeMessageView = {
    id: 'assistant-1',
    type: 'assistant',
    text,
    thinking: '',
    blocks: [{ type: 'text', id: 'text-1', text }],
    status: 'completed',
    toolCalls: [],
  }

  return renderToStaticMarkup(
    <RuntimeEventContentBlock
      message={message}
      threadId="thread-1"
    />,
  )
}

describe('RuntimeEventContentBlock afterglow', () => {
  test('renders afterglow as a separate non-copy text layer', () => {
    const markup = renderAssistantText('正文\n\n⟡ 这个风险先别忽略\n\n结尾')

    expect(markup).toContain('data-afterglow="true"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('data-afterglow-text="⟡ 这个风险先别忽略"')
    expect(markup).toContain('正文')
    expect(markup).toContain('结尾')
  })

  test('keeps markers inside fenced code as markdown', () => {
    const markup = renderAssistantText('```md\n⟡ keep this code\n```')

    expect(markup).not.toContain('data-afterglow="true"')
    expect(markup).toContain('⟡ keep this code')
  })
})
```

- [ ] **Step 2: Run the render test and verify it fails**

Run:

```bash
rtk bun test apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx
```

Expected: FAIL because `SmoothText` renders all text through `XMarkdown`.

- [ ] **Step 3: Add the afterglow renderer**

Modify imports in `RuntimeEventContentBlock.tsx`:

```ts
import { parseAfterglowBlocks } from '@lume/shared'
import type { ClipboardEvent } from 'react'
```

Add a local component near `SmoothText`:

```tsx
const AfterglowLine = memo(function AfterglowLine({ text }: { text: string }) {
  return (
    <p
      className="my-1.5 select-none text-[13px] italic leading-6 text-[#6b7280]/70"
      aria-hidden="true"
      data-afterglow="true"
      data-afterglow-text={`⟡ ${text}`}
    >
      <span className="opacity-70">⟡</span>
      <span className="ml-1.5">{text}</span>
    </p>
  )
})
```

Inside `SmoothText`, after `displayedContent` is computed:

```tsx
const afterglowBlocks = useMemo(
  () => displayedContent.includes('⟡') ? parseAfterglowBlocks(displayedContent) : null,
  [displayedContent],
)
```

Render the fast path when `afterglowBlocks === null`; otherwise map blocks:

```tsx
{afterglowBlocks.map((block, index) => (
  block.type === 'afterglow'
    ? <AfterglowLine key={`afterglow:${index}`} text={block.text} />
    : block.text.trim()
      ? <XMarkdown ...>{block.text}</XMarkdown>
      : null
))}
```

Keep the existing `markdownStreaming`, `markdownComponents`, `rootClassName`, and `onOpenThreadFile` behavior for Markdown blocks.

- [ ] **Step 4: Run the render test and verify it passes**

Run:

```bash
rtk bun test apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx
```

Expected: PASS.

### Task 6: Remove Afterglow From Copy Selection

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.test.ts`

- [ ] **Step 1: Write the failing copy helper test**

Export a pure helper from `RuntimeEventContentBlock.tsx` so copy behavior can be tested without browser selection APIs:

```ts
export function getCopyTextWithoutAfterglow(container: ParentNode): string {
  const clone = container.cloneNode(true) as ParentNode;
  clone.querySelectorAll('[data-afterglow]').forEach((node) => node.remove());
  return (clone.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
```

Before implementing it, add this test to `RuntimeEventContentBlock.test.ts`:

```ts
import { getCopyTextWithoutAfterglow } from './RuntimeEventContentBlock'

describe('getCopyTextWithoutAfterglow', () => {
  test('removes afterglow nodes from copied text', () => {
    const root = document.createElement('div')
    root.append('正文')
    const afterglow = document.createElement('p')
    afterglow.dataset.afterglow = 'true'
    afterglow.textContent = '⟡ 不要复制'
    root.append(afterglow)
    root.append('结尾')

    expect(getCopyTextWithoutAfterglow(root)).toBe('正文结尾')
  })
})
```

If `document` is not available in this test environment, move this test to a `.test.tsx` file that already runs with DOM support, or test the copy sanitizer through `renderToStaticMarkup` plus a minimal parser helper. Do not add a new dependency.

- [ ] **Step 2: Run the copy helper test and verify it fails**

Run:

```bash
rtk bun test apps/web/src/components/agent/RuntimeEventContentBlock.test.ts
```

Expected: FAIL because `getCopyTextWithoutAfterglow` is not exported yet.

- [ ] **Step 3: Implement copy sanitization**

Add `getCopyTextWithoutAfterglow` as above.

In `SmoothText`, add `onCopy` to the wrapper `<div>`:

```tsx
const handleCopy = useMemo(() => (event: ClipboardEvent<HTMLDivElement>) => {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return
  const fragment = selection.getRangeAt(0).cloneContents()
  const text = getCopyTextWithoutAfterglow(fragment)
  if (!text) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
}, [])
```

Attach it only to the wrapper around assistant text:

```tsx
<div className="min-w-0 w-full" onCopy={handleCopy}>
```

- [ ] **Step 4: Run web afterglow tests**

Run:

```bash
rtk bun test apps/web/src/components/agent/RuntimeEventContentBlock.test.ts apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Chunk 3**

Run:

```bash
rtk git add apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/agent/RuntimeEventContentBlock.test.ts apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx
rtk git commit -m "✨ feat(web): 渲染并复制过滤余光" -m "Assistant 文本识别 ⟡ 行并以低对比侧注展示；复制选区时剔除余光，保持剪贴板正文干净。" -m "Constraint: 复用 @lume/shared 解析规则" -m "Tested: bun test RuntimeEventContentBlock afterglow tests"
```

## Chunk 4: Integration Verification

### Task 7: Run Focused Verification

**Files:**
- No code files unless earlier chunks uncovered a narrow bug.

- [ ] **Step 1: Run all affected focused tests**

Run:

```bash
rtk bun test \
  packages/shared/src/afterglow.test.ts \
  apps/sidecar/src/services/agent/prompt/sections/core-sections.test.ts \
  apps/sidecar/src/services/memory-v2/conversation-summary.test.ts \
  apps/sidecar/src/services/agent-runtime/context/context-controller.test.ts \
  apps/web/src/components/agent/RuntimeEventContentBlock.test.ts \
  apps/web/src/components/agent/RuntimeEventContentBlock.afterglow.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
rtk git diff --stat
rtk git diff -- packages/shared/src/afterglow.ts apps/sidecar/src/services/agent/prompt/sections/core-sections.ts apps/sidecar/src/services/memory-v2/conversation-summary.ts apps/sidecar/src/services/agent-runtime/context/context-controller.ts apps/web/src/components/agent/RuntimeEventContentBlock.tsx
```

Expected:

- No runtime schema changes.
- No dependency changes.
- No unrelated formatting churn.
- `stripAfterglowLines` is reused instead of duplicated regexes.

- [ ] **Step 3: Commit final verification note only if there were fixes**

If Task 7 required code fixes, commit them with a scoped Lore message:

```bash
rtk git add <fixed-files>
rtk git commit -m "🐛 fix(web,sidecar): 收紧余光边界处理" -m "修复实现验证中发现的余光解析或过滤边界问题。" -m "Tested: focused afterglow test set"
```

If no fixes were needed, do not create an empty commit.

## Execution Notes

- Do not revert existing unrelated dirty worktree changes.
- Do not add dependencies.
- Keep commits small and aligned to chunks.
- If the DOM copy helper test cannot run because the current Bun test environment lacks `document`, adapt the test to an existing React/SSR pattern instead of introducing a DOM library.
- If `conversation-summary.test.ts` does not exist, create it with only the afterglow-focused tests; do not broaden memory test coverage for unrelated behavior.
- If TypeScript complains about fake test object shapes, prefer `as unknown as LumeRunItem` in tests over changing production types.
