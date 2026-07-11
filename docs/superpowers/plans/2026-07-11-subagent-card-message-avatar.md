# Subagent Card Message Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the assistant-message avatar and its layout slot only inside the expanded Subagent card conversation.

**Architecture:** Add an optional `showAssistantAvatar` presentation prop to the canonical `RuntimeEventContentBlock`, defaulting to `true`. The Subagent card passes `false`; every other caller keeps the existing default behavior. Include the prop in the memo comparator because changing it changes rendered layout.

**Tech Stack:** React, TypeScript, Bun test, Tailwind CSS

---

### Task 1: Add the scoped avatar visibility contract

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx:29-58,94-160`
- Modify: `apps/web/src/components/agent/AgentMessages.test.ts:629-680`

- [ ] **Step 1: Write the failing memo-comparator test**

Add this case to `describe('areRuntimeEventContentBlockPropsEqual')`:

```ts
test('detects assistant avatar visibility changes', () => {
  const prev = { message: baseAssistantMessage, threadId: 't1', showAssistantAvatar: true }
  const next = { message: baseAssistantMessage, threadId: 't1', showAssistantAvatar: false }
  expect(areRuntimeEventContentBlockPropsEqual(prev, next)).toBe(false)
})
```

- [ ] **Step 2: Run the comparator test and verify it fails**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`

Expected: the new case fails because the comparator does not inspect `showAssistantAvatar`.

- [ ] **Step 3: Implement the default-on visibility prop**

Extend `RuntimeEventContentBlockProps` and the comparator:

```ts
showAssistantAvatar?: boolean

if (prev.showAssistantAvatar !== next.showAssistantAvatar) return false
```

Default the prop in the component and conditionally render the existing avatar node:

```tsx
showAssistantAvatar = true,

{showAssistantAvatar && (
  <div data-agent-message-avatar="true" className="mt-1 flex size-10 shrink-0 ...">
    <Sparkles size={21} strokeWidth={1.8} fill="currentColor" fillOpacity={0.1} />
  </div>
)}
```

The outer flex container needs no replacement spacer; removing the avatar node removes the `size-10` width and the gap has no visible effect with one child.

- [ ] **Step 4: Run the comparator test and verify it passes**

Run: `bun test apps/web/src/components/agent/AgentMessages.test.ts`

Expected: all `AgentMessages.test.ts` cases pass.

### Task 2: Disable the avatar only in the Subagent card

**Files:**
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.test.tsx:11-72`
- Modify: `apps/web/src/components/agent/SubagentInlinePanel.tsx:308-317`

- [ ] **Step 1: Write the failing Subagent call-site test**

Extend the existing source-boundary test:

```ts
expect(source).toContain('showAssistantAvatar={false}')
```

- [ ] **Step 2: Run the Subagent panel test and verify it fails**

Run: `bun test apps/web/src/components/agent/SubagentInlinePanel.test.tsx`

Expected: failure because `SubagentInlinePanel` does not yet disable the avatar.

- [ ] **Step 3: Pass the scoped option from the Subagent conversation**

Update the existing message render call:

```tsx
<RuntimeEventContentBlock
  key={message.id}
  message={message}
  threadId={childThreadId}
  streaming={isRunning && index === messages.length - 1}
  showAssistantAvatar={false}
  onUserResizeStart={onUserResizeStart}
/>
```

Do not change `AgentMessages.tsx`; omitting the prop there preserves the default avatar in standalone conversations.

- [ ] **Step 4: Run the focused Web tests**

Run: `bun test apps/web/src/components/agent/SubagentInlinePanel.test.tsx apps/web/src/components/agent/AgentMessages.test.ts`

Expected: both suites pass.

- [ ] **Step 5: Verify the public prop and diff**

Run:

```powershell
bun run --filter @lume/web typecheck
git diff --check -- apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/agent/SubagentInlinePanel.tsx apps/web/src/components/agent/SubagentInlinePanel.test.tsx apps/web/src/components/agent/AgentMessages.test.ts
```

Expected: both commands exit with code 0. Do not commit implementation unless explicitly requested; the workspace contains other in-progress changes.
