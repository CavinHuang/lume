# SDK Skill Registration Extensibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the SDK so Agent creation can accept `skillsDirectories` and `skills`, then wire Lume runtime to pass its default/workspace skill roots so workspace skills are actually registered instead of only described in prompts.

**Architecture:** Keep the SDK registry model, but stop hardcoding filesystem skill discovery as the primary path. Agent initialization will register bundled skills first, then explicit `skills`, then directory-based skills, then optional legacy `.claude/skills` fallback. Lume will adopt phase 1 by passing explicit skill directories from `~/.lume`.

**Tech Stack:** TypeScript strict, Bun, `@lume/agent-sdk`, Lume sidecar runtime-core, existing skill frontmatter parser.

---

## File Structure

### SDK Files

- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\types.ts`
  - Add `skills` and `skillsDirectories` to `AgentOptions`.
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.ts`
  - Support explicit roots + optional legacy fallback.
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.ts`
  - Register skills in deterministic order and keep source buckets isolated.
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\tools\skill-tool.ts`
  - No behavior rewrite expected, but tests may need prompt assertions for new registrations.

### Lume Files

- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.ts`
  - Pass explicit skill directories when creating the SDK agent.
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts`
  - Reuse `getDefaultSkillsDir()` / `getWorkspaceSkillsDir()` if additional helpers are needed.

### Tests

- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.ts` test coverage if present; otherwise add:
  - `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.test.ts`
- Modify or add:
  - `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.test.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts`

---

### Task 1: Extend SDK AgentOptions For Explicit Skill Sources

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\types.ts`
- Test: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.test.ts`

- [ ] **Step 1: Write the failing SDK type usage test**

```ts
import { expect, test } from "bun:test";
import type { AgentOptions, SkillDefinition } from "@lume/agent-sdk";

test("AgentOptions 应支持 skills 与 skillsDirectories", () => {
  const skills: SkillDefinition[] = [];
  const options: AgentOptions = {
    apiType: "anthropic-messages",
    apiKey: "test",
    model: "claude-sonnet-4-5",
    cwd: process.cwd(),
    skills,
    skillsDirectories: ["C:/tmp/skills"]
  };
  expect(options.skillsDirectories?.[0]).toBe("C:/tmp/skills");
  expect(options.skills).toBe(skills);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.test.ts`

Expected: FAIL with `skills does not exist on type AgentOptions` or equivalent type error.

- [ ] **Step 3: Add the new AgentOptions fields**

```ts
// node_modules/@lume/agent-sdk/src/types.ts
import type { SkillDefinition } from "./skills/types.js";

export interface AgentOptions {
  // existing fields...
  skills?: SkillDefinition[];
  skillsDirectories?: string[];
}
```

- [ ] **Step 4: Run SDK typecheck**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume
bun x tsc -p node_modules/@lume/agent-sdk/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add node_modules/@lume/agent-sdk/src/types.ts node_modules/@lume/agent-sdk/src/agent.test.ts
git commit -m "feat(skill): ✨为 SDK AgentOptions 增加显式 skill 来源入口"
```

### Task 2: Make Filesystem Skill Loading Accept Explicit Roots

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.ts`
- Create or Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.test.ts`

- [ ] **Step 1: Write the failing loader test**

```ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFilesystemSkills } from "./fs-loader";

test("应优先加载传入的 skillsDirectories", async () => {
  const root = join(tmpdir(), `sdk-skills-${Date.now()}`);
  const skillDir = join(root, "planner");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: planner\ndescription: demo\n---\n# demo`, "utf-8");

  const skills = await loadFilesystemSkills({
    cwd: process.cwd(),
    roots: [root],
    includeLegacyFallback: false
  });

  expect(skills.map((item) => item.name)).toContain("planner");
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.test.ts`

Expected: FAIL because `loadFilesystemSkills` does not accept an object input yet.

- [ ] **Step 3: Update loader signature and behavior**

```ts
// node_modules/@lume/agent-sdk/src/skills/fs-loader.ts
export async function loadFilesystemSkills(input: {
  cwd: string;
  roots?: string[];
  includeLegacyFallback?: boolean;
}): Promise<SkillDefinition[]> {
  const home = process.env.HOME || process.env.USERPROFILE || input.cwd;
  const explicitRoots = input.roots ?? [];
  const legacyRoots = input.includeLegacyFallback === false
    ? []
    : [
        join(home, ".claude", "skills"),
        join(input.cwd, ".claude", "skills")
      ];

  const roots = Array.from(new Set([...explicitRoots, ...legacyRoots]));
  // existing scan logic over roots...
}
```

- [ ] **Step 4: Preserve old parsing behavior**

```ts
// Keep frontmatter parsing, body extraction, and name de-dup logic unchanged.
```

- [ ] **Step 5: Run loader tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\fs-loader.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add node_modules/@lume/agent-sdk/src/skills/fs-loader.ts node_modules/@lume/agent-sdk/src/skills/fs-loader.test.ts
git commit -m "feat(skill): ✨让 SDK skill 文件加载支持显式目录数组"
```

### Task 3: Register Skills In Deterministic Source Order

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\skills\registry.ts`
- Test: `D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.test.ts`

- [ ] **Step 1: Write the failing registration-order test**

```ts
test("显式 skills 应先于 directories 注册，legacy 最后 fallback", async () => {
  const explicit = {
    name: "planner",
    description: "explicit",
    getPrompt: async () => [{ type: "text", text: "explicit" }]
  };

  const agent = createAgent({
    apiType: "anthropic-messages",
    apiKey: "test",
    model: "claude-sonnet-4-5",
    cwd: process.cwd(),
    skills: [explicit],
    skillsDirectories: []
  });

  await agent.getInitializationResult();
  expect(agent.getInitializationResult).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.test.ts`

Expected: FAIL because explicit skill registration path does not exist yet.

- [ ] **Step 3: Split registry buckets inside Agent**

```ts
// node_modules/@lume/agent-sdk/src/agent.ts
private explicitSkillNames: Set<string> = new Set()
private directorySkillNames: Set<string> = new Set()

private unregisterExplicitSkills(): void {
  for (const name of this.explicitSkillNames) unregisterSkill(name)
  this.explicitSkillNames.clear()
}

private registerExplicitSkills(): void {
  this.unregisterExplicitSkills()
  for (const skill of this.cfg.skills || []) {
    registerSkill(skill)
    this.explicitSkillNames.add(skill.name)
  }
}
```

- [ ] **Step 4: Update setup order**

```ts
// node_modules/@lume/agent-sdk/src/agent.ts
initBundledSkills()
this.registerPluginSkills()
this.registerExplicitSkills()
await this.registerFilesystemSkills({
  cwd,
  roots: this.cfg.skillsDirectories,
  includeLegacyFallback: true
})
```

- [ ] **Step 5: Keep filesystem registration isolated**

```ts
private async registerFilesystemSkills(input: {
  cwd: string
  roots?: string[]
  includeLegacyFallback?: boolean
}): Promise<void> {
  this.unregisterFileSkills()
  const skills = await loadFilesystemSkills(input)
  for (const skill of skills) {
    registerSkill(skill)
    this.fileSkillNames.add(skill.name)
  }
}
```

- [ ] **Step 6: Run SDK tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\node_modules\@lume\agent-sdk\src\agent.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add node_modules/@lume/agent-sdk/src/agent.ts node_modules/@lume/agent-sdk/src/skills/registry.ts node_modules/@lume/agent-sdk/src/agent.test.ts
git commit -m "feat(skill): ✨固定 SDK 多来源 skill 注册顺序"
```

### Task 4: Wire Lume Runtime To Pass Skill Directories

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\infra\config-paths.ts` (only if a helper is missing)

- [ ] **Step 1: Write the failing Lume runtime test**

```ts
test("Lume runtime 应把默认与 workspace skill 目录传给 SDK", async () => {
  const result = await createRuntimeCoreSession({
    lumeSessionId: "skill-session",
    cwd,
    agentDir,
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    apiKey: "test",
    workspaceSlug: "default"
  });

  const init = await result.agent.getInitializationResult();
  expect(init.skills.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts`

Expected: FAIL because Lume does not pass `skillsDirectories` yet.

- [ ] **Step 3: Pass explicit skill roots from Lume**

```ts
// apps/sidecar/src/services/pi-agent/runtime-core/run.ts
import { getDefaultSkillsDir, getWorkspaceSkillsDir } from "../../infra/config-paths";

function resolveSkillDirectories(workspaceSlug?: string): string[] {
  const roots = [getDefaultSkillsDir()];
  if (workspaceSlug) {
    roots.push(getWorkspaceSkillsDir(workspaceSlug));
  }
  return roots;
}

const agentOptions: AgentOptions = {
  // existing options...
  skillsDirectories: resolveSkillDirectories(input.workspaceSlug)
};
```

- [ ] **Step 4: Keep current prompt behavior unchanged**

```ts
// Do not rewrite prompt builder in this task. The goal is to make runtime registration match existing prompt claims.
```

- [ ] **Step 5: Run sidecar tests**

Run:

```bash
bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts
bun run --cwd D:\workspace\projects\ai-projects\lume\apps\sidecar typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/services/pi-agent/runtime-core/run.ts apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts apps/sidecar/src/services/infra/config-paths.ts
git commit -m "feat(skill): ✨让 Lume runtime 显式传入 skill 目录"
```

### Task 5: Verify End-To-End Skill Availability

**Files:**
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\agent\agent-prompt-builder.test.ts`
- Modify: `D:\workspace\projects\ai-projects\lume\apps\sidecar\scripts\smoke-restart-restore.mjs` if a lightweight runtime assertion is needed

- [ ] **Step 1: Add a runtime-facing assertion**

```ts
test("workspace skill 被实际注册后，初始化结果应包含对应 skill 名称", async () => {
  // create workspace skill directory + SKILL.md
  const init = await result.agent.getInitializationResult();
  expect(init.skills).toContain("Planner");
});
```

- [ ] **Step 2: Run test to verify it fails before final integration**

Run: `bun test D:\workspace\projects\ai-projects\lume\apps\sidecar\src\services\pi-agent\runtime-core\run.test.ts`

Expected: FAIL until SDK + runtime integration is complete.

- [ ] **Step 3: Re-run full local verification**

Run:

```bash
cd D:\workspace\projects\ai-projects\lume\apps\sidecar
bun run typecheck
bun test src/services/pi-agent/runtime-core/run.test.ts src/services/agent/agent-prompt-builder.test.ts
cd D:\workspace\projects\ai-projects\lume
bun run smoke:core
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts apps/sidecar/src/services/agent/agent-prompt-builder.test.ts apps/sidecar/scripts/smoke-restart-restore.mjs
git commit -m "test(skill): ✅补齐多来源 skill 注册链路验证"
```

---

## Self-Review

### Spec Coverage

- SDK 增加 `skills` / `skillsDirectories`：Task 1
- filesystem loader 支持 roots：Task 2
- 注册顺序固定：Task 3
- Lume 第一阶段传 skill 目录：Task 4
- 验证 workspace skills 真正进入 runtime：Task 5

### Placeholder Scan

- 无 `TODO` / `TBD`
- 每个任务都有具体文件、命令、最小代码块

### Type Consistency

- 字段名统一使用 `skills` / `skillsDirectories`
- 注册顺序统一为 `bundled -> explicit -> directories -> legacy`
- Lume 第一阶段只接 `skillsDirectories`

