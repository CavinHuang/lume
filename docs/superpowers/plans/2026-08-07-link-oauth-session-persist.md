# OAuth Pending Session 落盘(#3)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `link-handlers.ts` 的 module-level `pendingOAuth` Map 改为文件持久化(`PersistentOAuthSessions`),修复 sidecar 重启丢失 OAuth pending session 的 bug。

**Architecture:** 新增 `PersistentOAuthSessions`(Map + `${configDir}/link-oauth-sessions.json` 原子持久化,启动加载 + 5min TTL expire,configDir 未设降级纯内存);`link-handlers.ts` 用 `getConfigDir()` 构造它,handlers 的 set/delete/status 改动后落盘。

**Tech Stack:** TypeScript、`node:fs`、`bun:test`、sidecar UtilityProcess。

## Global Constraints

- 不改 UI、不改 OpenConnector、不改 admin `/api/` 通路
- 用 sidecar 现有 `getConfigDir()`(`services/infra/config-paths`,对齐 model-meta-handlers)与原子写惯例(`writeFileSync(tmp) + renameSync`,对齐 agent-attachment-meta-service)
- 文件 `mode: 0o600`(对齐 supervisor `savePersistedState`)
- `LUME_CONFIG_DIR`/`getConfigDir()` 不可用时降级纯内存(不崩,headless/测试)
- stacked on `codex/link-openconnector`(PR#32);#3 worktree `D:/workspace/projects/ai-projects/lume-link-oauth-session`
- 提交 emoji 前缀 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

- `apps/sidecar/src/services/link/persistent-oauth-sessions.ts` — **新增**:`PersistentOAuthSessions`(Map + 文件持久化 + load/expire + 原子 persist)
- `apps/sidecar/src/services/link/persistent-oauth-sessions.test.ts` — **新增**:单元(重启恢复/TTL/降级/原子)
- `apps/sidecar/src/rpc/link-handlers.ts` — `pendingOAuth` Map → `PersistentOAuthSessions`(用 `getConfigDir()`);handlers set/delete/状态改后落盘
- `apps/sidecar/src/rpc/link-handlers.test.ts` — 加 sidecar 重启恢复 case

## Interfaces

- `PersistentOAuthSessions`(`apps/sidecar/src/services/link/persistent-oauth-sessions.ts`,Task 1 产出):
  - `constructor(configDir?: string)` —— configDir 设则文件持久化,undefined 纯内存
  - `get(state: string): (LinkOAuthSession & { startedAt: number }) | undefined`
  - `set(state: string, session: LinkOAuthSession & { startedAt: number }): void` —— 写后 persist
  - `delete(state: string): void` —— 删后 persist
  - `values(): IterableIterator<LinkOAuthSession & { startedAt: number }>`
  - `flush(): void` —— 显式 persist(状态字段改动后用)
- Task 2 消费:`link-handlers.ts` 用 `getConfigDir()` from `../services/infra/config-paths` 构造 `PersistentOAuthSessions`

---

### Task 1: PersistentOAuthSessions(文件持久化 + 单元测试)

**Files:**
- Create: `apps/sidecar/src/services/link/persistent-oauth-sessions.ts`
- Create: `apps/sidecar/src/services/link/persistent-oauth-sessions.test.ts`

**Interfaces:**
- Produces: `PersistentOAuthSessions`(见上)
- Consumes: `LinkOAuthSession` from `@lume/shared`

- [ ] **Step 1: 写失败测试**

```ts
// persistent-oauth-sessions.test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { LinkOAuthSession } from "@lume/shared";
import { PersistentOAuthSessions } from "./persistent-oauth-sessions";

const baseSession = (overrides: Partial<LinkOAuthSession & { startedAt: number }> = {}): LinkOAuthSession & { startedAt: number } => ({
  state: "state-1", service: "github", connectionName: "work", authorizationUrl: "https://example.test/authorize", status: "pending", startedAt: Date.now(), ...overrides,
});

describe("PersistentOAuthSessions", () => {
  test("recovers sessions across instances (sidecar restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      new PersistentOAuthSessions(dir).set("state-1", baseSession());
      const reloaded = new PersistentOAuthSessions(dir);
      expect(reloaded.get("state-1")).toMatchObject({ state: "state-1", service: "github", status: "pending" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("expires pending sessions older than 5min on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      new PersistentOAuthSessions(dir).set("state-old", baseSession({ state: "state-old", startedAt: Date.now() - 6 * 60_000 }));
      expect(new PersistentOAuthSessions(dir).get("state-old")?.status).toBe("timed_out");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("falls back to in-memory when configDir is undefined", () => {
    const sessions = new PersistentOAuthSessions(undefined);
    sessions.set("state-1", baseSession());
    expect(sessions.get("state-1")).toMatchObject({ state: "state-1" });
    expect(sessions.values()).toContainEqual(expect.objectContaining({ state: "state-1" }));
  });

  test("persists atomically (no partial file on disk after set)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      new PersistentOAuthSessions(dir).set("state-1", baseSession());
      const raw = readFileSync(join(dir, "link-oauth-sessions.json"), "utf8");
      const entries = JSON.parse(raw) as Array<[string, unknown]>;
      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe("state-1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("delete removes from memory and disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
    try {
      const sessions = new PersistentOAuthSessions(dir);
      sessions.set("state-1", baseSession());
      sessions.delete("state-1");
      expect(new PersistentOAuthSessions(dir).get("state-1")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/sidecar && bun test src/services/link/persistent-oauth-sessions.test.ts`
Expected: FAIL(`PersistentOAuthSessions` 未导出)

- [ ] **Step 3: 实现 PersistentOAuthSessions**

```ts
// persistent-oauth-sessions.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LinkOAuthSession } from "@lume/shared";

type PersistedSession = LinkOAuthSession & { startedAt: number };

const FILE_NAME = "link-oauth-sessions.json";
const SESSION_TTL_MS = 5 * 60_000;

export class PersistentOAuthSessions {
  private readonly sessions = new Map<string, PersistedSession>();
  private readonly file?: string;

  constructor(configDir?: string) {
    this.file = configDir ? join(configDir, FILE_NAME) : undefined;
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const entries = JSON.parse(readFileSync(this.file, "utf8")) as Array<[string, PersistedSession]>;
      const now = Date.now();
      for (const [state, session] of entries) {
        if (session && session.status === "pending" && now - session.startedAt > SESSION_TTL_MS) {
          session.status = "timed_out";
        }
        this.sessions.set(state, session);
      }
    } catch {
      // corrupt/missing → start empty
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.sessions.entries()]), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  get(state: string): PersistedSession | undefined {
    return this.sessions.get(state);
  }

  set(state: string, session: PersistedSession): void {
    this.sessions.set(state, session);
    this.persist();
  }

  delete(state: string): void {
    this.sessions.delete(state);
    this.persist();
  }

  values(): IterableIterator<PersistedSession> {
    return this.sessions.values();
  }

  flush(): void {
    this.persist();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/sidecar && bun test src/services/link/persistent-oauth-sessions.test.ts`
Expected: PASS(5/5)

- [ ] **Step 5: typecheck**

Run: `cd apps/sidecar && bun run typecheck`
Expected: 无 error

- [ ] **Step 6: commit**

```bash
git add apps/sidecar/src/services/link/persistent-oauth-sessions.ts apps/sidecar/src/services/link/persistent-oauth-sessions.test.ts
git commit -m "✨ feat(sidecar): PersistentOAuthSessions(OAuth session 文件持久化)"
```

---

### Task 2: link-handlers 集成 + 重启恢复测试

**Files:**
- Modify: `apps/sidecar/src/rpc/link-handlers.ts`
- Modify: `apps/sidecar/src/rpc/link-handlers.test.ts`

**Interfaces:**
- Consumes: `PersistentOAuthSessions`(Task 1)、`getConfigDir` from `../services/infra/config-paths`

- [ ] **Step 1: 写失败测试(sidecar 重启恢复)**

在 `link-handlers.test.ts` 加(顶部 import 加 `mkdtempSync, rmSync` from `node:fs`、`tmpdir` from `node:os`、`join` from `node:path`):
```ts
test("survives sidecar restart by persisting pending OAuth sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
  const previousConfigDir = process.env.LUME_CONFIG_DIR;
  process.env.LUME_CONFIG_DIR = dir;
  installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
  globalThis.fetch = (async (input) => {
    const request = new Request(input);
    if (request.url.endsWith("/api/oauth/authorizations")) return Response.json({ state: "state-1", authorizationUrl: "https://example.test/authorize" });
    if (request.url.endsWith("/api/connections")) return Response.json([]);
    throw new Error(`unexpected: ${request.url}`);
  }) as typeof fetch;
  try {
    const first = createLinkHandlers(() => {});
    await first["link:oauth-start"]!({ service: "github", connectionName: "work" });
    // 模拟 sidecar 重启:新 handlers 从磁盘恢复
    const restarted = createLinkHandlers(() => {});
    const sessions = await restarted["link:oauth-sessions"]!({}) as LinkOAuthSession[];
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ state: "state-1", service: "github", status: "pending" })]));
  } finally {
    process.env.LUME_CONFIG_DIR = previousConfigDir;
    installLinkRuntimeBootstrap({ phase: "offline" });
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/sidecar && bun test src/rpc/link-handlers.test.ts`
Expected: FAIL(restarted handlers 无持久化,oauth-sessions 返回空)

- [ ] **Step 3: link-handlers 集成 PersistentOAuthSessions**

`link-handlers.ts` 改动:
- 删除 module-level `const pendingOAuth = new Map<string, LinkOAuthSession & { startedAt: number }>();`(line 5)
- import 加:`import { PersistentOAuthSessions } from "../services/link/persistent-oauth-sessions";` 与 `import { getConfigDir } from "../services/infra/config-paths";`
- 在 `createLinkHandlers` 内(函数体首行)加:
```ts
const pendingOAuth = new PersistentOAuthSessions((() => { try { return getConfigDir(); } catch { return undefined; } })());
```
- handlers 内 `pendingOAuth.set` / `pendingOAuth.delete` 保持(set/delete 已自动 persist)
- `link:oauth-status` 与 `link:oauth-cancel` 内改动 `session.status` 后,加 `pendingOAuth.flush();`(状态字段改动落盘)
- `link:oauth-sessions` 与 `expireOAuthSessions`:`expireOAuthSessions` 改为遍历 `pendingOAuth.values()` 改 status 后 `pendingOAuth.flush()`;或内联到 `link:oauth-sessions`(因 pendingOAuth 不再是 module Map,expireOAuthSessions 函数要接收 pendingOAuth 或内联)

具体:`expireOAuthSessions()` 当前是 module 函数(遍历 pendingOAuth.values())。改为在 `createLinkHandlers` 内定义(闭包 pendingOAuth),或 `expireOAuthSessions(pendingOAuth)`。最简:内联到 `link:oauth-sessions` handler:
```ts
"link:oauth-sessions": async () => {
  const now = Date.now();
  let changed = false;
  for (const session of pendingOAuth.values()) {
    if (session.status === "pending" && now - session.startedAt > 5 * 60_000) { session.status = "timed_out"; changed = true; }
  }
  if (changed) pendingOAuth.flush();
  return [...pendingOAuth.values()].map(withoutStartedAt);
},
```
删除 module-level `expireOAuthSessions` 函数。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/sidecar && bun test src/rpc/link-handlers.test.ts`
Expected: PASS(全部,含新重启恢复 case + 原 3 case)

- [ ] **Step 5: typecheck + sidecar test:unit**

Run: `cd apps/sidecar && bun run typecheck && bun run test:unit`
Expected: 无 error(link 相关全过;3 baseline 平台 fail 非本任务)

- [ ] **Step 6: commit**

```bash
git add apps/sidecar/src/rpc/link-handlers.ts apps/sidecar/src/rpc/link-handlers.test.ts
git commit -m "🐛 fix(link): OAuth pending session 落盘,修 sidecar 重启丢失 bug"
```

---

## Self-Review

**Spec coverage**:设计文档 5 节全覆盖——架构(Task 2 集成)/PersistentOAuthSessions(Task 1)/测试(Task 1 单元 + Task 2 集成)/文件(4 文件:2 新 2 改)/非目标(不改 UI/OpenConnector/admin)。✅

**Placeholder scan**:Task 2 Step 3 的 `expireOAuthSessions` 重构给了具体内联代码(非占位)。getConfigDir try/catch 降级明确。其余步骤均含实际代码/命令。✅

**Type consistency**:`PersistentOAuthSessions`、`PersistedSession`、`get/set/delete/values/flush`、`getConfigDir` 在 Task 1-2 一致。`LinkOAuthSession & { startedAt: number }` 与 link-handlers 现有 pendingOAuth 值类型一致。✅
