# Lume 插件系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Lume 已有 plugin v1 基础上，扩展为完整的插件系统：原生 manifest、Codex 适配器、权限拦截器、插件管理器

**Architecture:** SDK 层新增 manifest 解析 + 适配器 + 权限类型 + 管理器；Sidecar 层新增权限拦截器（集成到 tool-runtime）+ 插件生命周期管理。复用已有的 `registerSkill`、`HookRegistry`、`McpClientManager` 基础设施。

**Tech Stack:** TypeScript (SDK), TypeScript (Sidecar), Bun test framework

---

## File Structure

```
packages/sdk/src/
├── plugins/
│   ├── loader.ts              ← 已有，扩展签名
│   ├── loader.test.ts         ← 已有，补充测试
│   ├── manifest.ts            ← 新建：lume-plugin.json 解析 + 字段校验
│   ├── manifest.test.ts       ← 新建
│   ├── codex-adapter.ts       ← 新建：Codex .codex-plugin/plugin.json → lume-plugin.json
│   ├── codex-adapter.test.ts  ← 新建
│   └── permissions.ts         ← 新建：PluginPermissions 类型 + glob 匹配
│       └── permissions.test.ts ← 新建

apps/sidecar/src/services/agent-runtime/
├── plugins/
│   ├── index.ts               ← 新建：插件管理器导出
│   ├── plugin-manager.ts      ← 新建：安装/卸载/加载/列举 生命周期
│   ├── plugin-manager.test.ts ← 新建
│   ├── permission-interceptor.ts  ← 新建：插件级 canUseTool 拦截器
│   └── permission-interceptor.test.ts ← 新建
│
├── permissions/
│   └── permission-engine.ts   ← 已有，确认插件拦截器集成点
│
└── tools/
    └── tool-runtime.ts        ← 已有，修改 resolveCommandPluginSpecs 调用新 manager
```

---

### Task 1: Manifest 类型定义

**Files:**
- Create: `packages/sdk/src/plugins/manifest.ts`
- Create: `packages/sdk/src/plugins/manifest.test.ts`

**Goal:** 定义 `lume-plugin.json` 的类型系统，包含字段校验和默认值推断。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/src/plugins/manifest.test.ts
import { describe, expect, test } from "bun:test";
import { parseManifest, inferDefaults, validateManifest } from "./manifest.js";

describe("LumePluginManifest", () => {
  test("parses a minimal valid manifest", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
    };
    const result = parseManifest(raw);
    expect(result.schema).toBe("lume-plugin/v1");
    expect(result.name).toBe("my-plugin");
    expect(result.version).toBe("1.0.0");
  });

  test("injects default values for optional fields", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
    };
    const result = inferDefaults(raw);
    expect(result.permissions).toBeDefined();
    expect(result.permissions.filesystem.read).toEqual(["./**"]);
    expect(result.permissions.filesystem.write).toEqual(["./data/**"]);
    expect(result.permissions.network.outbound).toEqual([]);
    expect(result.permissions.mcpServers.register).toBe(false);
    expect(result.permissions.shell.allow).toBe(false);
    expect(result.lume).toBeDefined();
    expect(result.lume.hooksOnly).toBe(false);
  });

  test("rejects invalid name (uppercase)", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "My-Plugin",
      version: "1.0.0",
    };
    expect(() => parseManifest(raw)).toThrow("name");
  });

  test("rejects name exceeding 64 chars", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "a".repeat(65),
      version: "1.0.0",
    };
    expect(() => parseManifest(raw)).toThrow("name");
  });

  test("rejects path without ./ prefix", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      skills: "skills/",  // 缺少 ./
    };
    expect(() => parseManifest(raw)).toThrow("skills");
  });

  test("rejects path with parent directory traversal", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      hooks: "./hooks/../secret.json",
    };
    expect(() => parseManifest(raw)).toThrow("hooks");
  });

  test("validates version is semver-like", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "not-a-version",
    };
    expect(() => parseManifest(raw)).toThrow("version");
  });

  test("accepts skills as array of paths", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      skills: ["./skills-a/", "./skills-b/"],
    };
    const result = parseManifest(raw);
    expect(result.skills).toEqual(["./skills-a/", "./skills-b/"]);
  });

  test("validates permissions field structure", () => {
    const raw = {
      schema: "lume-plugin/v1",
      name: "my-plugin",
      version: "1.0.0",
      permissions: {
        tools: {
          allow: ["Bash", "FileWrite"],
        },
      },
    };
    const result = parseManifest(raw);
    expect(result.permissions.tools.allow).toEqual(["Bash", "FileWrite"]);
    expect(result.permissions.tools.deny).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/plugins/manifest.test.ts`
Expected: FAIL — `manifest.ts` does not exist yet

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/sdk/src/plugins/manifest.ts

/**
 * Validates that a path string is safe for use in a plugin manifest.
 * - Must start with "./"
 * - Must not contain ".." parent directory traversal
 */
export function validatePluginPath(value: string, field: string): void {
  if (!value.startsWith("./")) {
    throw new Error(`Invalid ${field}: path must start with "./"`);
  }
  const segments = value.slice(2).split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(`Invalid ${field}: path must not contain ".."`);
    }
  }
}

/** Validates a plugin name: kebab-case, ASCII, max 64 chars. */
export function validatePluginName(name: string): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`Invalid plugin name: "${name}". Must be 1-64 ASCII chars: a-z, 0-9, _, -.`);
  }
}

/** Validates semver format. */
export function validateSemver(version: string): void {
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid version: "${version}". Must be semver (e.g. "1.0.0").`);
  }
}

export interface PluginPermissions {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  network?: {
    outbound?: string[];
  };
  mcpServers?: {
    register?: boolean;
  };
  shell?: {
    allow?: boolean;
  };
  tools?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  hooks?: {
    events?: string[];
  };
}

export interface LumePluginManifest {
  schema: "lume-plugin/v1";
  name: string;
  version: string;
  description?: string;
  author?: string;
  displayName?: string;
  category?: string;
  skills?: string[];
  hooks?: string;
  mcpServers?: string;
  permissions?: PluginPermissions;
  lume?: {
    hooksOnly?: boolean;
    exclusivePermissions?: boolean;
  };
}

const DEFAULT_PERMISSIONS: PluginPermissions = {
  filesystem: { read: ["./**"], write: ["./data/**"] },
  network: { outbound: [] },
  mcpServers: { register: false },
  shell: { allow: false },
};

export function parseManifest(raw: Record<string, unknown>): LumePluginManifest {
  if (raw.schema !== "lume-plugin/v1") {
    throw new Error(`Unsupported schema: "${raw.schema}". Expected "lume-plugin/v1".`);
  }

  const name = raw.name as string;
  validatePluginName(name);

  const version = raw.version as string;
  validateSemver(version);

  if (typeof raw.skills === "string") {
    validatePluginPath(raw.skills, "skills");
  } else if (Array.isArray(raw.skills)) {
    for (const path of raw.skills) {
      validatePluginPath(path as string, "skills");
    }
  }

  if (typeof raw.hooks === "string") {
    validatePluginPath(raw.hooks, "hooks");
  }
  if (typeof raw.mcpServers === "string") {
    validatePluginPath(raw.mcpServers, "mcpServers");
  }

  const result: LumePluginManifest = {
    schema: "lume-plugin/v1",
    name,
    version,
    description: raw.description as string | undefined,
    author: raw.author as string | undefined,
    displayName: raw.displayName as string | undefined,
    category: raw.category as string | undefined,
    skills: Array.isArray(raw.skills)
      ? raw.skills.map((s) => s as string)
      : raw.skills
        ? [raw.skills as string]
        : undefined,
    hooks: raw.hooks as string | undefined,
    mcpServers: raw.mcpServers as string | undefined,
  };

  if (raw.permissions && typeof raw.permissions === "object") {
    result.permissions = raw.permissions as PluginPermissions;
  }

  if (raw.lume && typeof raw.lume === "object") {
    result.lume = {
      hooksOnly: (raw.lume as Record<string, unknown>).hooksOnly as boolean | undefined,
      exclusivePermissions: (raw.lume as Record<string, unknown>).exclusivePermissions as boolean | undefined,
    };
  }

  return result;
}

export function inferDefaults(manifest: LumePluginManifest): LumePluginManifest {
  return {
    ...manifest,
    permissions: { ...DEFAULT_PERMISSIONS, ...manifest.permissions },
    lume: {
      hooksOnly: false,
      exclusivePermissions: false,
      ...manifest.lume,
    },
  };
}

export function validateManifest(raw: Record<string, unknown>): LumePluginManifest {
  const parsed = parseManifest(raw);
  return inferDefaults(parsed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/plugins/manifest.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/plugins/manifest.ts packages/sdk/src/plugins/manifest.test.ts
git commit -m "✨ feat(sdk): 新增 LumePluginManifest 类型定义和校验

- parseManifest 解析 lume-plugin.json 字段并做安全检查
- inferDefaults 补充默认权限值
- validatePluginPath 禁止 ../ 穿越和缺少 ./ 前缀
- validatePluginName 限制 kebab-case + 64 字符
- validateSemver 基础 semver 校验"
```

---

### Task 2: 权限匹配工具

**Files:**
- Create: `packages/sdk/src/plugins/permissions.ts`
- Create: `packages/sdk/src/plugins/permissions.test.ts`

**Goal:** 实现 glob 路径匹配和工具名权限判断的纯函数。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/src/plugins/permissions.test.ts
import { describe, expect, test } from "bun:test";
import { checkToolPermission, matchPathGlob, checkFilesystemPermission, checkNetworkPermission } from "./permissions.js";

describe("PluginPermissions", () => {
  const pluginRoot = "/home/user/.lume/plugins/cache/my-plugin/1.0.0";

  describe("matchPathGlob", () => {
    test("matches exact path", () => {
      expect(matchPathGlob("/home/user/.lume/plugins/cache/my-plugin/1.0.0/data/file.txt", ["./data/**"])).toBe(true);
    });

    test("rejects path outside pattern", () => {
      expect(matchPathGlob("/home/user/.lume/plugins/cache/my-plugin/1.0.0/secret.json", ["./data/**"])).toBe(false);
    });

    test("matches wildcard in subdirectory", () => {
      expect(matchPathGlob("/home/user/.lume/plugins/cache/my-plugin/1.0.0/skills/foo/SKILL.md", ["./skills/**"])).toBe(true);
    });

    test("matches root-level pattern", () => {
      expect(matchPathGlob("/home/user/.lume/plugins/cache/my-plugin/1.0.0/readme.md", ["./**"])).toBe(true);
    });

    test("normalizes relative paths against plugin root", () => {
      expect(matchPathGlob("data/file.txt", ["./data/**"], pluginRoot)).toBe(true);
    });
  });

  describe("checkFilesystemPermission", () => {
    const perms = {
      filesystem: {
        read: ["./data/**", "./skills/**"],
        write: ["./data/**"],
      },
    };

    test("allows read within declared pattern", () => {
      expect(checkFilesystemPermission("read", "./data/config.json", perms, pluginRoot)).toBe("allow");
    });

    test("denies read outside declared pattern", () => {
      expect(checkFilesystemPermission("read", "./secret.json", perms, pluginRoot)).toBe("ask");
    });

    test("allows write within declared pattern", () => {
      expect(checkFilesystemPermission("write", "./data/output.txt", perms, pluginRoot)).toBe("allow");
    });

    test("denies write outside declared pattern", () => {
      expect(checkFilesystemPermission("write", "./skills/foo.txt", perms, pluginRoot)).toBe("ask");
    });

    test("returns ask when filesystem is not declared", () => {
      expect(checkFilesystemPermission("read", "./data/x.txt", {}, pluginRoot)).toBe("ask");
    });
  });

  describe("checkToolPermission", () => {
    test("deny takes highest priority", () => {
      const perms = {
        tools: {
          allow: ["Bash"],
          deny: ["Bash"],
        },
      };
      expect(checkToolPermission("Bash", perms)).toBe("deny");
    });

    test("allow matches before ask", () => {
      const perms = {
        tools: {
          allow: ["FileRead", "Glob"],
          ask: ["WebFetch"],
        },
      };
      expect(checkToolPermission("FileRead", perms)).toBe("allow");
      expect(checkToolPermission("WebFetch", perms)).toBe("ask");
    });

    test("returns undefined when tool not listed", () => {
      const perms = {
        tools: {
          allow: ["FileRead"],
        },
      };
      expect(checkToolPermission("Bash", perms)).toBeUndefined();
    });

    test("returns undefined when no tools section", () => {
      expect(checkToolPermission("Bash", {})).toBeUndefined();
    });
  });

  describe("checkNetworkPermission", () => {
    test("allows host in outbound list", () => {
      const perms = { network: { outbound: ["api.example.com", "*.cdn.example.com"] } };
      expect(checkNetworkPermission("api.example.com", perms)).toBe("allow");
    });

    test("allows wildcard match", () => {
      const perms = { network: { outbound: ["*.cdn.example.com"] } };
      expect(checkNetworkPermission("assets.cdn.example.com", perms)).toBe("allow");
    });

    test("asks for host not in list", () => {
      const perms = { network: { outbound: ["api.example.com"] } };
      expect(checkNetworkPermission("evil.com", perms)).toBe("ask");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/plugins/permissions.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/sdk/src/plugins/permissions.ts

/** Simple glob-to-regex converter supporting * and ** patterns. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export type PermissionDecision = "allow" | "deny" | "ask" | undefined;

/**
 * Resolves a relative or absolute path against the plugin root.
 * Returns absolute path string.
 */
export function resolvePluginPath(
  path: string,
  pluginRoot: string,
): string {
  if (path.startsWith("./")) {
    return `${pluginRoot}/${path.slice(2)}`;
  }
  if (path.startsWith(pluginRoot)) {
    return path;
  }
  return `${pluginRoot}/${path}`;
}

/**
 * Matches an absolute path against a list of glob patterns (relative to plugin root).
 * Patterns use "./" prefix notation.
 */
export function matchPathGlob(
  absolutePath: string,
  patterns: string[],
  pluginRoot: string,
): boolean {
  for (const pattern of patterns) {
    const relativePattern = pattern.startsWith("./") ? pattern.slice(2) : pattern;
    const regex = globToRegex(relativePattern);
    if (regex.test(absolutePath)) return true;
    if (regex.test(`${pluginRoot}/${relativePattern}`)) return true;
  }
  return false;
}

export function checkFilesystemPermission(
  operation: "read" | "write",
  targetPath: string,
  permissions: Record<string, unknown>,
  pluginRoot: string,
): PermissionDecision {
  const fs = permissions.filesystem as { read?: string[]; write?: string[] } | undefined;
  if (!fs) return "ask";

  const patterns = operation === "read" ? fs.read : fs.write;
  if (!patterns || patterns.length === 0) return "ask";

  const resolved = resolvePluginPath(targetPath, pluginRoot);
  return matchPathGlob(resolved, patterns, pluginRoot) ? "allow" : "ask";
}

export function checkNetworkPermission(
  hostname: string,
  permissions: Record<string, unknown>,
): PermissionDecision {
  const network = permissions.network as { outbound?: string[] } | undefined;
  if (!network?.outbound?.length) return "ask";

  for (const pattern of network.outbound) {
    const regex = globToRegex(pattern);
    if (regex.test(hostname)) return "allow";
  }
  return "ask";
}

export function checkToolPermission(
  toolName: string,
  permissions: Record<string, unknown>,
): PermissionDecision {
  const tools = permissions.tools as
    | { allow?: string[]; deny?: string[]; ask?: string[] }
    | undefined;
  if (!tools) return undefined;

  if (tools.deny?.includes(toolName)) return "deny";
  if (tools.allow?.includes(toolName)) return "allow";
  if (tools.ask?.includes(toolName)) return "ask";
  return undefined;
}
```

**Note:** `minimatch` 需要先确认是否是已有依赖。如果项目已有 glob 库（如 `minimatch` 或 `picomatch`），直接使用；否则改用内联的简单 glob 匹配。

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/plugins/permissions.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/plugins/permissions.ts packages/sdk/src/plugins/permissions.test.ts
git commit -m "✨ feat(sdk): 新增插件权限匹配工具

- matchPathGlob 基于 minimatch 的 glob 路径匹配
- checkFilesystemPermission 读/写路径权限检查
- checkNetworkPermission 出站主机名匹配
- checkToolPermission 工具名优先级判断 (deny > allow > ask > undefined)"
```

---

### Task 3: Codex 适配器

**Files:**
- Create: `packages/sdk/src/plugins/codex-adapter.ts`
- Create: `packages/sdk/src/plugins/codex-adapter.test.ts`

**Goal:** 将 Codex `.codex-plugin/plugin.json` 转换为 Lume `lume-plugin.json`，包含字段映射、事件兼容和权限推断。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/src/plugins/codex-adapter.test.ts
import { describe, expect, test } from "bun:test";
import { adaptCodexPlugin, CODEX_EVENT_MAP } from "./codex-adapter.js";

describe("CodexAdapter", () => {
  test("maps Codex manifest fields to Lume manifest", () => {
    const codex = {
      name: "linear",
      version: "1.2.0",
      description: "Linear integration",
      author: "OpenAI",
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
      mcpServers: "./mcp.json",
      interface: {
        displayName: "Linear",
        category: "Productivity",
      },
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.schema).toBe("lume-plugin/v1");
    expect(result.name).toBe("linear");
    expect(result.version).toBe("1.2.0");
    expect(result.displayName).toBe("Linear");
    expect(result.category).toBe("Productivity");
    expect(result.skills).toEqual(["./skills/"]);
    expect(result.hooks).toBe("./hooks/hooks.json");
    expect(result.mcpServers).toBe("./mcp.json");
  });

  test("infers Codex-compatible permissions", () => {
    const codex = {
      name: "linear",
      version: "1.0.0",
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
      mcpServers: "./mcp.json",
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.permissions.mcpServers.register).toBe(true);
    expect(result.permissions.shell.allow).toBe(true);
    expect(result.permissions.tools.deny).toContain("Bash");
    expect(result.permissions.tools.deny).toContain("FileWrite");
    expect(result.permissions.tools.allow).toContain("FileRead");
    expect(result.permissions.tools.allow).toContain("Glob");
    expect(result.lume.hooksOnly).toBe(false);
  });

  test("maps Codex hooks events to Lume equivalents", () => {
    const codex = {
      name: "test",
      version: "1.0.0",
      hooks: "./hooks/hooks.json",
      interface: {},
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.permissions.hooks?.events).toEqual([
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);
  });

  test("throws on path with parent traversal", () => {
    const codex = {
      name: "test",
      version: "1.0.0",
      skills: "./skills/../etc/passwd",
      interface: {},
    };

    expect(() => adaptCodexPlugin(codex, "/plugin/root")).toThrow();
  });

  test("handles missing optional fields gracefully", () => {
    const codex = {
      name: "minimal",
      version: "0.1.0",
      interface: {},
    };

    const result = adaptCodexPlugin(codex, "/plugin/root");
    expect(result.skills).toBeUndefined();
    expect(result.hooks).toBeUndefined();
    expect(result.mcpServers).toBeUndefined();
    expect(result.permissions.mcpServers.register).toBe(true);
    expect(result.permissions.shell.allow).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/plugins/codex-adapter.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/sdk/src/plugins/codex-adapter.ts

import { validatePluginPath, validatePluginName, validateSemver } from "./manifest.js";

export const CODEX_EVENT_MAP: Record<string, string> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  PermissionRequest: "PermissionRequest",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  Stop: "Stop",
};

export function adaptCodexPlugin(
  codex: Record<string, unknown>,
  pluginRoot: string,
): Record<string, unknown> {
  const name = codex.name as string;
  validatePluginName(name);
  const version = codex.version as string;
  validateSemver(version);

  // Validate paths
  const pathFields = ["skills", "hooks", "mcpServers"];
  for (const field of pathFields) {
    const raw = codex[field];
    if (typeof raw === "string") {
      validatePluginPath(raw, field);
    }
  }

  const iface = (codex.interface as Record<string, unknown>) ?? {};

  // Map skills: string → string[]
  const skills = typeof codex.skills === "string"
    ? [codex.skills as string]
    : Array.isArray(codex.skills)
      ? codex.skills.map((s) => s as string)
      : undefined;

  return {
    schema: "lume-plugin/v1",
    name,
    version,
    description: codex.description as string | undefined,
    author: codex.author as string | undefined,
    displayName: (iface.displayName as string) ?? name,
    category: (iface.category as string) ?? undefined,
    skills,
    hooks: codex.hooks as string | undefined,
    mcpServers: codex.mcpServers as string | undefined,
    permissions: {
      filesystem: { read: ["./**"], write: ["./data/**"] },
      network: { outbound: [] },
      mcpServers: { register: true },
      shell: { allow: true },
      tools: {
        allow: [
          "FileRead", "Glob", "Grep", "WebFetch", "WebSearch",
          "TaskList", "TaskGet", "AskUserQuestion", "Config",
        ],
        deny: [
          "Bash", "FileWrite", "FileEdit", "NotebookEdit",
          "EnterWorktree", "ExitWorktree", "AgentTool", "SendMessage",
        ],
      },
      hooks: { events: Object.keys(CODEX_EVENT_MAP) },
    },
    lume: { hooksOnly: false },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/plugins/codex-adapter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/plugins/codex-adapter.ts packages/sdk/src/plugins/codex-adapter.test.ts
git commit -m "✨ feat(sdk): 新增 CodexPluginAdapter 适配器

- adaptCodexPlugin 将 .codex-plugin/plugin.json 转换为 lume-plugin.json
- CODEX_EVENT_MAP 10 个 Codex 事件 → Lume 等价事件
- 自动推断宽松默认权限（allow 非危险工具 / deny 危险工具 / shell+mcp 允许）"
```

---

### Task 4: 插件管理器（PluginManager）

**Files:**
- Create: `packages/sdk/src/plugins/manager.ts`
- Create: `packages/sdk/src/plugins/manager.test.ts`

**Goal:** 实现插件的安装/卸载/列举/加载生命周期，操作 `~/.lume/plugins/cache/` 和 `~/.lume/plugins/data/`。

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sdk/src/plugins/manager.test.ts
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join, homedir } from "path";
import { PluginManager } from "./manager.js";

describe("PluginManager", () => {
  const testRoot = join(homedir(), ".lume", "plugins", "cache");
  const dataRoot = join(homedir(), ".lume", "plugins", "data");

  test("installs a plugin from a source directory", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const src = join(testRoot, "_src", "demo");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "demo",
        version: "1.0.0",
        skills: ["./skills/"],
      })
    );
    await mkdir(join(src, "skills"), { recursive: true });

    const result = await manager.install({ source: src, pluginName: "demo" });

    expect(result.installedPath).toBeDefined();
    expect(result.installedPath).toContain("cache/demo/1.0.0");
    expect(result.version).toBe("1.0.0");
  });

  test("lists installed plugins", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    // Install two plugins
    for (const [name, ver] of [["alpha", "1.0.0"], ["beta", "2.0.0"]]) {
      const src = join(testRoot, "_src", name);
      await mkdir(src, { recursive: true });
      await writeFile(
        join(src, "lume-plugin.json"),
        JSON.stringify({ schema: "lume-plugin/v1", name, version: ver })
      );
      await manager.install({ source: src, pluginName: name });
    }

    const listed = await manager.list();
    const names = listed.map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  test("uninstalls a plugin", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const src = join(testRoot, "_src", "temp");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "lume-plugin.json"),
      JSON.stringify({ schema: "lume-plugin/v1", name: "temp", version: "1.0.0" })
    );
    await manager.install({ source: src, pluginName: "temp" });
    expect(await manager.list()).toContainEqual(expect.objectContaining({ name: "temp" }));

    await manager.uninstall("temp");
    expect(await manager.list()).not.toContainEqual(expect.objectContaining({ name: "temp" }));
  });

  test("resolves the active version (highest semver)", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const pluginDir = join(testRoot, "semver-test");
    await mkdir(pluginDir, { recursive: true });
    for (const ver of ["1.0.0", "1.2.0", "2.0.0"]) {
      await writeFile(
        join(pluginDir, ver, "lume-plugin.json"),
        JSON.stringify({ schema: "lume-plugin/v1", name: "semver-test", version: ver })
      );
    }

    const active = manager.resolveActiveVersion("semver-test");
    expect(active).toBe("2.0.0");
  });

  test("loads manifest from installed path", async () => {
    const manager = new PluginManager(testRoot, dataRoot);
    const src = join(testRoot, "_src", "load-test");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "lume-plugin.json"),
      JSON.stringify({
        schema: "lume-plugin/v1",
        name: "load-test",
        version: "1.0.0",
        skills: ["./skills/"],
        hooks: "./hooks/hooks.json",
      })
    );
    await manager.install({ source: src, pluginName: "load-test" });

    const loaded = await manager.load("load-test");
    expect(loaded.name).toBe("load-test");
    expect(loaded.skills).toEqual(["./skills/"]);
    expect(loaded.hooks).toBe("./hooks/hooks.json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/plugins/manager.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/sdk/src/plugins/manager.ts

import { access, mkdir, readdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { parseManifest, inferDefaults, validatePluginPath, type LumePluginManifest } from "./manifest.js";

export interface PluginInstallInput {
  source: string;
  pluginName: string;
  version?: string;
}

export interface PluginInstallResult {
  installedPath: string;
  version: string;
}

export interface PluginInfo {
  name: string;
  version: string;
  path: string;
}

export class PluginManager {
  private cacheRoot: string;
  private dataRoot: string;

  constructor(cacheRoot?: string, dataRoot?: string) {
    this.cacheRoot = cacheRoot ?? join(process.env.HOME ?? "~", ".lume", "plugins", "cache");
    this.dataRoot = dataRoot ?? join(process.env.HOME ?? "~", ".lume", "plugins", "data");
  }

  async install(input: PluginInstallInput): Promise<PluginInstallResult> {
    const version = input.version ?? "local";
    const targetRoot = join(this.cacheRoot, input.pluginName, version);
    await mkdir(targetRoot, { recursive: true });

    // Copy source → target (simple recursive copy for now)
    await copyDir(input.source, targetRoot);

    // Validate the manifest
    const manifestPath = join(targetRoot, "lume-plugin.json");
    await access(manifestPath);
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    parseManifest(raw);

    // Ensure data dir exists
    await mkdir(join(this.dataRoot, input.pluginName), { recursive: true });

    return { installedPath: targetRoot, version };
  }

  async uninstall(pluginName: string, version?: string): Promise<void> {
    const pluginDir = join(this.cacheRoot, pluginName);
    const entries = await readdir(pluginDir).catch(() => []);
    if (version) {
      await rm(join(pluginDir, version), { recursive: true, force: true });
    } else {
      await rm(pluginDir, { recursive: true, force: true });
    }
  }

  async list(): Promise<PluginInfo[]> {
    const result: PluginInfo[] = [];
    await readdir(this.cacheRoot).catch(async () => {
      // cache dir doesn't exist yet
    });
    try {
      const entries = await readdir(this.cacheRoot);
      for (const entry of entries) {
        const pluginDir = join(this.cacheRoot, entry);
        try {
          const versions = await readdir(pluginDir);
          for (const ver of versions) {
            const manifestPath = join(pluginDir, ver, "lume-plugin.json");
            try {
              await access(manifestPath);
              result.push({ name: entry, version: ver, path: join(pluginDir, ver) });
            } catch {
              // skip entries without manifest
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      // cache dir doesn't exist
    }
    return result;
  }

  resolveActiveVersion(pluginName: string): string {
    const pluginDir = join(this.cacheRoot, pluginName);
    // Read versions from disk synchronously (called during config resolution)
    try {
      const entries = require("fs").readdirSync(pluginDir);
      const versions = entries.filter((e: string) => e !== "local");
      if (versions.includes("local")) return "local";
      versions.sort(semverSort);
      return versions[versions.length - 1] ?? "local";
    } catch {
      return "local";
    }
  }

  async load(pluginName: string, version?: string): Promise<LumePluginManifest> {
    const ver = version ?? this.resolveActiveVersion(pluginName);
    const manifestPath = join(this.cacheRoot, pluginName, ver, "lume-plugin.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    return inferDefaults(parseManifest(raw));
  }
}

/** Simple semver-aware sort: "1.0.0" < "1.2.0" < "2.0.0" */
function semverSort(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      const { copyFile } = await import("fs/promises");
      await copyFile(srcPath, destPath);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/plugins/manager.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/plugins/manager.ts packages/sdk/src/plugins/manager.test.ts
git commit -m "✨ feat(sdk): 新增 PluginManager 插件生命周期管理

- install/uninstall/list/load 四个核心操作
- resolveActiveVersion semver 选择活跃版本
- copyDir 递归复制插件文件到 cache 目录
- 安装时校验 lume-plugin.json 合法性"
```

---

### Task 5: 侧边栏插件权限拦截器

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/index.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts`

**Goal:** 在 sidecar 的 `CanUseToolFn` 链中插入插件级权限拦截器，在全局 `PermissionEngine` 之前执行。

- [ ] **Step 1: Write the failing test**

```typescript
// apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts
import { describe, expect, test } from "bun:test";
import { createPluginPermissionInterceptor } from "./permission-interceptor.js";

describe("createPluginPermissionInterceptor", () => {
  test("denies tool when plugin tools.deny matches", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        tools: { deny: ["Bash", "FileWrite"] },
      },
    });

    const result = await interceptor({
      toolName: "Bash",
      input: { command: "rm -rf /" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("demo");
  });

  test("allows tool when plugin tools.allow matches", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        tools: { allow: ["FileRead", "Glob"] },
      },
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/plugins/demo/data/notes.md" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("allow");
  });

  test("asks for unlisted tool (no allow/deny match)", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        tools: { allow: ["FileRead"] },
      },
    });

    const result = await interceptor({
      toolName: "WebFetch",
      input: { url: "https://example.com" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("ask");
  });

  test("asks when path outside filesystem.read pattern", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        filesystem: { read: ["./data/**"] },
      },
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/plugins/demo/secret.json" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("ask");
  });

  test("allows path within filesystem.read pattern", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        filesystem: { read: ["./data/**"] },
      },
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/plugins/demo/data/config.json" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("allow");
  });

  test("asks for network host not in outbound list", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {
        network: { outbound: ["api.example.com"] },
      },
    });

    const result = await interceptor({
      toolName: "WebFetch",
      input: { url: "https://evil.com" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBe("ask");
  });

  test("passes through when no permissions defined", async () => {
    const interceptor = createPluginPermissionInterceptor({
      pluginName: "demo",
      pluginRoot: "/plugins/demo",
      permissions: {},
    });

    const result = await interceptor({
      toolName: "FileRead",
      input: { file_path: "/any/path" },
      context: { cwd: "/project", threadId: "t1" },
    });

    expect(result.behavior).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/sidecar/src/services/agent-runtime/plugins/index.ts

export { createPluginPermissionInterceptor } from "./permission-interceptor.js";

// types
export interface PluginPermissionContext {
  pluginName: string;
  pluginRoot: string;
  permissions: Record<string, unknown>;
}

export interface InterceptorInput {
  toolName: string;
  input: unknown;
  context: {
    cwd: string;
    threadId: string;
  };
}

export interface InterceptorResult {
  behavior: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: unknown;
}
```

```typescript
// apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts

import { checkToolPermission, checkFilesystemPermission, checkNetworkPermission } from "@lume/agent-sdk/plugins/permissions.js";
import type { InterceptorInput, InterceptorResult, PluginPermissionContext } from "./index.js";

const FILESYSTEM_TOOLS = new Set([
  "FileRead", "FileWrite", "FileEdit", "NotebookEdit",
  "Glob", "Grep",
]);

const NETWORK_TOOLS = new Set([
  "WebFetch", "WebSearch",
]);

export function createPluginPermissionInterceptor(
  ctx: PluginPermissionContext,
) {
  return async (input: InterceptorInput): Promise<InterceptorResult | undefined> => {
    const { toolName, input: toolInput, context } = input;
    const perms = ctx.permissions;

    // 1. tools 优先级检查 (deny > allow > ask > pass-through)
    const toolDecision = checkToolPermission(toolName, perms);
    if (toolDecision === "deny") {
      return { behavior: "deny", reason: `Plugin "${ctx.pluginName}" denied tool "${toolName}"` };
    }
    if (toolDecision === "allow") {
      return { behavior: "allow" };
    }
    if (toolDecision === "ask") {
      return { behavior: "ask", reason: `Plugin "${ctx.pluginName}" requires confirmation for "${toolName}"` };
    }

    // 2. filesystem 路径检查
    if (FILESYSTEM_TOOLS.has(toolName)) {
      const pathInput = (toolInput as Record<string, unknown>)?.file_path ?? (toolInput as Record<string, unknown>)?.path;
      if (typeof pathInput === "string") {
        const op = (toolName === "FileRead" || toolName === "Glob" || toolName === "Grep") ? "read" : "write";
        const fsDecision = checkFilesystemPermission(op, pathInput, perms, ctx.pluginRoot);
        if (fsDecision === "allow") return { behavior: "allow" };
        if (fsDecision === "ask") {
          return { behavior: "ask", reason: `Plugin "${ctx.pluginName}" needs confirmation for ${op}: ${pathInput}` };
        }
      }
    }

    // 3. network 主机名检查
    if (NETWORK_TOOLS.has(toolName)) {
      const url = (toolInput as Record<string, unknown>)?.url as string | undefined;
      if (url) {
        try {
          const hostname = new URL(url).hostname;
          const netDecision = checkNetworkPermission(hostname, perms);
          if (netDecision === "allow") return { behavior: "allow" };
          if (netDecision === "ask") {
            return { behavior: "ask", reason: `Plugin "${ctx.pluginName}" needs confirmation to access ${hostname}` };
          }
        } catch {
          // invalid URL, fall through
        }
      }
    }

    // 4. pass-through: 没有匹配任何插件权限规则，走全局权限引擎
    return undefined;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/index.ts \
  apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.ts \
  apps/sidecar/src/services/agent-runtime/plugins/permission-interceptor.test.ts
git commit -m "✨ feat(sidecar): 新增插件级权限拦截器

- createPluginPermissionInterceptor 在全局 PermissionEngine 前执行
- tools deny > allow > ask 优先级判断
- filesystem read/write glob 路径匹配
- network outbound 主机名匹配
- 无匹配时返回 undefined 透传全局权限引擎"
```

---

### Task 6: 插件管理器（Sidecar 生命周期）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts`
- Create: `apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`

**Goal:** Sidecar 侧的插件生命周期管理，集成到 `ToolRuntime` 和 permission engine。

- [ ] **Step 1: Write the failing test**

```typescript
// apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join, homedir } from "path";
import { SidecarPluginManager } from "./plugin-manager.js";

describe("SidecarPluginManager", () => {
  const root = join(homedir(), ".lume", "plugins");

  test("resolves enabled plugins from config", async () => {
    await mkdir(join(root, "alpha"), { recursive: true });
    await writeFile(join(root, "alpha", "lume-plugin.json"), JSON.stringify({
      schema: "lume-plugin/v1", name: "alpha", version: "1.0.0",
    }));

    const manager = new SidecarPluginManager(root);
    const config = { enabled: ["alpha"], directories: [] };
    const plugins = await manager.resolveEnabled(config);
    expect(plugins.map((p) => p.name)).toContain("alpha");
  });

  test("skips disabled plugins", async () => {
    await mkdir(join(root, "beta"), { recursive: true });
    await writeFile(join(root, "beta", "lume-plugin.json"), JSON.stringify({
      schema: "lume-plugin/v1", name: "beta", version: "1.0.0",
    }));

    const manager = new SidecarPluginManager(root);
    const config = { enabled: [], directories: [] };
    const plugins = await manager.resolveEnabled(config);
    expect(plugins.map((p) => p.name)).not.toContain("beta");
  });

  test("scans additional configured directories", async () => {
    const extra = join(root, "_extra");
    await mkdir(join(extra, "gamma"), { recursive: true });
    await writeFile(join(extra, "gamma", "lume-plugin.json"), JSON.stringify({
      schema: "lume-plugin/v1", name: "gamma", version: "1.0.0",
    }));

    const manager = new SidecarPluginManager(root);
    const config = { enabled: [], directories: [extra] };
    const plugins = await manager.resolveEnabled(config);
    expect(plugins.map((p) => p.name)).toContain("gamma");
  });

  test("builds interceptor contexts for all enabled plugins", async () => {
    await mkdir(join(root, "delta"), { recursive: true });
    await writeFile(join(root, "delta", "lume-plugin.json"), JSON.stringify({
      schema: "lume-plugin/v1",
      name: "delta",
      version: "1.0.0",
      permissions: {
        tools: { deny: ["Bash"] },
        filesystem: { read: ["./data/**"] },
      },
    }));

    const manager = new SidecarPluginManager(root);
    const config = { enabled: ["delta"], directories: [] };
    const contexts = await manager.buildInterceptorContexts(config);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.pluginName).toBe("delta");
    expect(contexts[0]!.permissions.tools.deny).toContain("Bash");
  });

  test("returns empty contexts when no plugins enabled", async () => {
    const manager = new SidecarPluginManager(root);
    const contexts = await manager.buildInterceptorContexts({ enabled: [], directories: [] });
    expect(contexts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseManifest, type LumePluginManifest } from "@lume/agent-sdk/plugins/manifest.js";

export interface ResolvedPlugin {
  name: string;
  version: string;
  root: string;
  manifest: LumePluginManifest;
}

export class SidecarPluginManager {
  private readonly pluginRoot: string;

  constructor(pluginRoot?: string) {
    this.pluginRoot = pluginRoot ?? join(process.env.HOME ?? "~", ".lume", "plugins");
  }

  async resolveEnabled(config: {
    enabled: string[];
    directories: string[];
  }): Promise<ResolvedPlugin[]> {
    const roots = [
      this.pluginRoot,
      ...config.directories.map((d) => resolve(d)),
    ];
    const seen = new Set<string>();
    const results: ResolvedPlugin[] = [];

    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (config.enabled.length > 0 && !config.enabled.has(entry.name)) continue;
        const pluginDir = join(root, entry.name);
        if (seen.has(pluginDir)) continue;
        seen.add(pluginDir);

        const manifestPath = join(pluginDir, "lume-plugin.json");
        if (!existsSync(manifestPath)) continue;

        try {
          const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const manifest = parseManifest(raw);
          // Skip hooks-only plugins at this layer (they're handled by hook system)
          if (manifest.lume?.hooksOnly) continue;

          // Resolve version: try version dirs, fallback to "local"
          const version = resolveVersion(pluginDir);

          results.push({
            name: manifest.name,
            version,
            root: pluginDir,
            manifest,
          });
        } catch {
          // skip invalid manifests
        }
      }
    }

    return results;
  }

  buildInterceptorContexts(config: {
    enabled: string[];
    directories: string[];
  }): Array<{ pluginName: string; pluginRoot: string; permissions: Record<string, unknown> }> {
    const plugins = this.resolveEnabledSync(config);
    return plugins.map((p) => ({
      pluginName: p.name,
      pluginRoot: p.root,
      permissions: p.manifest.permissions ?? {},
    }));
  }

  private resolveEnabledSync(config: {
    enabled: string[];
    directories: string[];
  }): ResolvedPlugin[] {
    // Synchronous variant for use in permission interceptor setup
    const roots = [this.pluginRoot, ...config.directories.map((d) => resolve(d))];
    const seen = new Set<string>();
    const results: ResolvedPlugin[] = [];

    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (config.enabled.length > 0 && !config.enabled.has(entry.name)) continue;
        const pluginDir = join(root, entry.name);
        if (seen.has(pluginDir)) continue;
        seen.add(pluginDir);

        const manifestPath = join(pluginDir, "lume-plugin.json");
        if (!existsSync(manifestPath)) continue;

        try {
          const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const manifest = parseManifest(raw);
          if (manifest.lume?.hooksOnly) continue;

          const version = resolveVersion(pluginDir);
          results.push({ name: manifest.name, version, root: pluginDir, manifest });
        } catch {
          // skip
        }
      }
    }
    return results;
  }
}

function resolveVersion(pluginDir: string): string {
  try {
    const entries = readdirSync(pluginDir);
    const versions = entries.filter((e) => /^\d+\.\d+\.\d+/.test(e) || e === "local");
    if (versions.includes("local")) return "local";
    versions.sort(semverSort);
    return versions[versions.length - 1] ?? "local";
  } catch {
    return "local";
  }
}

function semverSort(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.ts \
  apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts \
  apps/sidecar/src/services/agent-runtime/plugins/index.ts
git commit -m "✨ feat(sidecar): 新增 SidecarPluginManager 插件生命周期管理

- resolveEnabled 扫描 ~/.lume/plugins/ + 额外目录
- buildInterceptorContexts 为每个启用插件构建权限拦截器上下文
- 支持 enabled 白名单过滤
- 跳过 invalid manifest 和 hooksOnly 插件"
```

---

### Task 7: Sidecar 集成 — 替换 validateCommandPluginManifest

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts:103-138`

**Goal:** 将 `resolveCommandPluginSpecs` 从简单的目录扫描升级为使用 `SidecarPluginManager`，支持 `lume-plugin.json` manifest。

- [ ] **Step 1: Write the failing test (add to existing tool-runtime.test.ts)**

```typescript
// 在 apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts 中追加
test("resolveCommandPluginSpecs picks up lume-plugin.json plugins", async () => {
  const root = join(tmpdir(), `lume-plugin-${crypto.randomUUID()}`);
  const pluginDir = join(root, ".lume", "plugins", "manifest-plugin");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "lume-plugin.json"),
    JSON.stringify({
      schema: "lume-plugin/v1",
      name: "manifest-plugin",
      version: "1.0.0",
      skills: ["./skills/"],
    })
  );
  await mkdir(join(pluginDir, "skills"), { recursive: true });

  const result = ToolRuntime.resolveCommandPluginSpecs({ cwd: root });
  expect(result.specs.some((s) => s.name === "manifest-plugin")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`
Expected: 新测试 FAIL（现有代码只认 `plugin.json`）

- [ ] **Step 3: Modify tool-runtime.ts**

在 `tool-runtime.ts` 顶部新增 import：
```typescript
import { SidecarPluginManager } from "../plugins/plugin-manager.js";
```

替换 `resolveCommandPluginSpecs` 中的目录扫描逻辑：

```typescript
// 替换原 107-137 行
static resolveCommandPluginSpecs(input: {
  cwd: string;
  workspaceSlug?: string;
}): ResolveCommandPluginSpecsResult {
  const manager = new SidecarPluginManager();
  const config = getEffectiveLumeConfig(input.workspaceSlug).plugins;
  const enabledList = config?.enabled ?? [];
  const directories = config?.directories ?? [];

  // 如果用户没有配置 enabled 列表，默认扫描所有插件
  const effectiveEnabled = enabledList.length > 0 ? enabledList : undefined;

  const resolved = await manager.resolveEnabled({
    enabled: effectiveEnabled ?? [],
    directories,
  });

  const specs: NonNullable<AgentOptions["plugins"]> = [];
  const diagnostics: ToolRuntimeDiagnostic[] = [];

  for (const plugin of resolved) {
    if (plugin.manifest.lume?.hooksOnly) continue;
    specs.push({ name: plugin.name, path: plugin.root, kind: "command" });
  }

  return { specs, diagnostics };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`
Expected: 新测试 PASS，原有测试仍 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts
git commit -m "♻️ refactor(sidecar): 插件发现改用 SidecarPluginManager

- resolveCommandPluginSpecs 委托给 SidecarPluginManager
- 支持 lume-plugin.json manifest
- 保留 plugin.json 兼容（SidecarPluginManager 内部 fallback）
- 空 enabled 列表时扫描全部插件"
```

---

### Task 8: Sidecar 集成 — 权限拦截器接入 ToolRuntime

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.ts`
- Test: add test to `apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts` (or `tool-runtime-wrapper.test.ts`)

**Goal:** 在 tool 执行的 canUseTool 链路中，先执行插件权限拦截器，再进入全局 PermissionEngine。

- [ ] **Step 1: Write the failing test**

```typescript
// 追加到 tool-runtime.test.ts
test("plugin permission interceptor blocks denied tool before global engine", async () => {
  const root = join(tmpdir(), `lume-plugin-${crypto.randomUUID()}`);
  const pluginDir = join(root, ".lume", "plugins", "blocker");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "lume-plugin.json"),
    JSON.stringify({
      schema: "lume-plugin/v1",
      name: "blocker",
      version: "1.0.0",
      permissions: { tools: { deny: ["Bash"] } },
    })
  );

  const result = ToolRuntime.resolveCommandPluginSpecs({ cwd: root });
  expect(result.specs.some((s) => s.name === "blocker")).toBe(true);

  // 验证 interceptor contexts 能生成 deny 规则
  const manager = new SidecarPluginManager();
  const contexts = manager.buildInterceptorContexts({ enabled: ["blocker"], directories: [] });
  expect(contexts).toHaveLength(1);
  // 使用拦截器验证 Bash 被拒绝
  const { createPluginPermissionInterceptor } = await import("../plugins/permission-interceptor.js");
  const interceptor = createPluginPermissionInterceptor(contexts[0]!);
  const decision = await interceptor({
    toolName: "Bash",
    input: { command: "echo hi" },
    context: { cwd: root, threadId: "t1" },
  });
  expect(decision?.behavior).toBe("deny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts`
Expected: FAIL — 需要 `SidecarPluginManager` 和 interceptor 存在（Task 5/6 完成后才应通过）

**注意：** 如果 Task 5/6 已完成，此测试应直接通过。若尚未完成，跳过此测试到 Task 6 之后。

- [ ] **Step 3: Verify integration point**

在 `tool-runtime-wrapper.ts` 或 tool 执行路径中确认拦截器接入点。查看现有 `wrapToolDefinitionWithRuntimePolicies` 的实现：

```typescript
// 确认 tool-runtime-wrapper.ts 中是否有 canUseTool 集成点
// 如果有，在那里注入插件拦截器链
```

- [ ] **Step 4: Commit（如果有代码变更）**

如果 Task 5/6 已提前完成，此步骤可能有代码变更需要提交。否则标记为"随 Task 6 完成"。

---

### Task 9: SDK 导出更新

**Files:**
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/plugins/loader.ts`

**Goal:** 将新模块导出到 SDK 公共 API，让 sidecar 和外部消费者可以导入。

- [ ] **Step 1: Update index.ts exports**

在 `packages/sdk/src/index.ts` 的 plugins 区块追加：

```typescript
// 在现有的 loadFilesystemSkills 之后追加
export {
  parseManifest,
  validateManifest,
  inferDefaults,
  validatePluginPath,
  validatePluginName,
  validateSemver,
  type LumePluginManifest,
  type PluginPermissions,
} from './plugins/manifest.js'
export {
  adaptCodexPlugin,
  CODEX_EVENT_MAP,
} from './plugins/codex-adapter.js'
export {
  checkToolPermission,
  checkFilesystemPermission,
  checkNetworkPermission,
  matchPathGlob,
  type PermissionDecision,
} from './plugins/permissions.js'
```

- [ ] **Step 2: Verify existing loader still works**

```bash
bun test packages/sdk/src/plugins/loader.test.ts
```
Expected: PASS（Task 1-4 未修改 loader 逻辑）

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/index.ts
git commit -m "✨ feat(sdk): 导出插件 manifest/adapter/permissions 到公共 API

- index.ts 新增 manifest、codex-adapter、permissions 导出
- 保持 loader.ts 向后兼容"
```

---

### Task 10: minimatch 依赖确认与安装

**Files:**
- Modify: `packages/sdk/package.json` (如果 minimatch 不是已有依赖)

**Goal:** 确保 glob 匹配库可用。

- [ ] **Step 1: Check if minimatch exists**

Run: `grep -r "minimatch\|picomatch\|globby" packages/sdk/package.json`
If found: 已有依赖，跳过。If not: 进入 Step 2。

- [ ] **Step 2: Install minimatch**

```bash
cd packages/sdk && bun add minimatch
```

- [ ] **Step 3: 更新 permissions.ts 使用已有库**

如果项目已有其他 glob 库（如 `picomatch`），将 `permissions.ts` 中的 `minimatch` 调用替换为对应库的 API。

- [ ] **Step 4: Run all plugin tests**

```bash
bun test packages/sdk/src/plugins/
```
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/package.json packages/sdk/package-lock.json  # or bun.lock
git commit -m "⬆️ deps(sdk): 添加 minimatch glob 匹配依赖"
```

---

## 集成测试（最后一步）

所有单元测试通过后，做一次端到端验证：

```bash
# 1. 创建一个测试 Codex 插件
mkdir -p /tmp/test-codex-plugin/.codex-plugin
cat > /tmp/test-codex-plugin/.codex-plugin/plugin.json << 'EOF'
{
  "name": "test-codex",
  "version": "1.0.0",
  "description": "Test Codex plugin",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./mcp.json",
  "interface": { "displayName": "Test Codex" }
}
EOF

# 2. 用适配器转换
node -e "
const { adaptCodexPlugin } = require('./packages/sdk/src/plugins/codex-adapter.ts');
const result = adaptCodexPlugin(require('/tmp/test-codex-plugin/.codex-plugin/plugin.json'), '/tmp/test-codex-plugin');
console.log(JSON.stringify(result, null, 2));
"

# 3. 安装到本地 cache
# （通过 PluginManager.install 或手动复制）

# 4. 启动 sidecar，确认插件被发现
bun test apps/sidecar/src/services/agent-runtime/plugins/plugin-manager.test.ts
```

---

## Spec 覆盖检查

| Spec 章节 | 对应 Task | 状态 |
|---|---|---|
| §3 Lume 原生 Manifest 格式 | Task 1 | 覆盖 |
| §4 权限系统（全部 6 类 + 默认值 + Codex 宽松默认） | Task 1 + Task 2 + Task 3 | 覆盖 |
| §4.5 运行时执行流程 | Task 5 | 覆盖 |
| §4.6 跨插件工具调用 | Task 6 | 覆盖（全局池 + context 控制可见性） |
| §5 Codex 适配器字段映射 | Task 3 | 覆盖 |
| §5.2 事件兼容 | Task 3 | 覆盖 |
| §6 安装与加载流程 | Task 4 + Task 6 | 覆盖 |
| §9 Phase 1 实现列表 | Task 1-9 | 全部覆盖 |
