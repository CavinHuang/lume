# Plugin Interaction Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installed plugins usable end-to-end by aligning install-time MCP approval, Agent plugin awareness, detail-page chat activation, and Obsidian pairing.

**Architecture:** Keep the platform changes narrow: reuse the existing plugin state store, permission runtime, `$plugin` workflow hook, and `welcomePromptSeedAtom`. Obsidian owns its pairing token through its MCP server; Lume never sees or renders the token. Chrome keeps the existing `node_repl` and `browserAuth` flow and only improves activation/discovery docs.

**Tech Stack:** Bun/TypeScript in Lume sidecar and web; Node test runner/tsx/esbuild in `D:\workspace\projects\ai-projects\lume-plugins`; no new dependencies.

---

### Task 1: Lume Install-Time MCP Approval

**Files:**
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.ts`
- Modify: `apps/sidecar/src/services/plugins/plugin-market-service.test.ts`

- [x] **Step 1: Write failing plugin-market-service test**

Add a test that installs a plugin with `mcp.json`, accepted permissions, and workspace enablement, then asserts the active version contains an approval for `mcpServer:obsidian-bridge:obsidian-bridge`.

```ts
test("plugin install records sensitive approval for declared MCP servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "lume-plugin-market-mcp-approval-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "lume-plugin.json"), JSON.stringify({
    schema: "lume-plugin/v1",
    name: "obsidian-bridge",
    version: "0.1.0",
    mcpServers: "./mcp.json",
    permissions: { mcpServers: { register: true } },
  }));
  writeFileSync(join(sourceRoot, "mcp.json"), JSON.stringify({
    mcpServers: { "obsidian-bridge": { command: "node", args: ["server.js"] } },
  }));

  const service = makeService(root);
  const detail = await service.getMarketDetail({
    workspaceSlug: "default",
    kind: "plugin",
    source: { type: "local", path: sourceRoot },
  });
  if (detail.inspect?.kind !== "plugin") throw new Error("expected plugin inspect");

  await service.installMarketItem({
    workspaceSlug: "default",
    kind: "plugin",
    source: { type: "local", path: sourceRoot },
    acceptedPermissionsHash: detail.inspect.permissionsHash,
    enableScope: "workspace",
  });

  const state = await service["stateStore"]().read();
  const approvals = state.plugins["obsidian-bridge"]?.versions["0.1.0"]?.sensitiveApprovals ?? [];
  expect(approvals).toContainEqual(expect.objectContaining({
    key: "mcpServer:obsidian-bridge:obsidian-bridge",
    scope: "workspace",
    decision: "allow",
    permissionsHash: detail.inspect.permissionsHash,
    workspaceSlug: "default",
  }));
});
```

- [x] **Step 2: Run test to verify RED**

Run:

```powershell
bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "plugin install records sensitive approval for declared MCP servers"
```

Expected: FAIL because `sensitiveApprovals` is currently empty.

- [x] **Step 3: Implement minimal approval creation**

Add a helper in `plugin-market-service.ts` that maps inspected MCP servers to approval records:

```ts
function buildMcpServerSensitiveApprovals(input: {
  plugin: NormalizedPlugin;
  mcpServers: Array<{ pluginId: string; serverId: string }>;
  permissionsHash: string;
  workspaceSlug: string;
  enableScope?: InstallMarketItemInput["enableScope"];
  now: string;
}): SensitiveApprovalRecord[] {
  if (input.enableScope === "none") return [];
  if (!input.plugin.permissions.mcpServers?.register) return [];
  return input.mcpServers
    .filter((server) => server.pluginId === input.plugin.pluginId)
    .map((server) => ({
      key: `mcpServer:${server.pluginId}:${server.serverId}`,
      scope: input.enableScope === "workspace" ? "workspace" : "global",
      decision: "allow" as const,
      createdAt: input.now,
      permissionsHash: input.permissionsHash,
      ...(input.enableScope === "workspace" ? { workspaceSlug: input.workspaceSlug } : {}),
    }));
}
```

Pass `pluginAssembly.mcpServers` or a resolved MCP list from the inspected plugin into `recordInstalledPlugin`, and use the returned array instead of `[]`.

- [x] **Step 4: Run focused sidecar test**

Run:

```powershell
bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "plugin install records sensitive approval for declared MCP servers"
```

Expected: PASS.

### Task 2: Agent Plugin Awareness

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plugins/runtime-bridge.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`
- Modify: `apps/sidecar/src/services/agent/agent-prompt-builder.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts`

- [x] **Step 1: Write failing runtime-core test**

Add a runtime test that creates an enabled plugin and checks `systemPrompt` includes the plugin summary, plus a prompt-builder test that checks plugin skills render in `Enabled Plugins`.

```ts
test("system prompt includes enabled plugin skills", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-plugin-skill-context-config-"));
  process.env.LUME_CONFIG_DIR = configDir;
  const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-plugin-skill-context-cwd-"));
  const agentDir = join(cwd, ".runtime-core-test");
  const skillDir = join(cwd, ".lume", "plugins", "obsidian-bridge", "skills", "demo");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(cwd, ".lume", "plugins", "obsidian-bridge", "lume-plugin.json"), JSON.stringify({
    schema: "lume-plugin/v1",
    name: "obsidian-bridge",
    version: "0.1.0",
    displayName: "Obsidian Bridge",
    description: "Connect a local Obsidian vault.",
    skills: ["./skills/"],
  }));
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo plugin skill.\n---\n\n# Demo\n");
  updateLumeConfigSection({ source: "system", path: "plugins.enabled", value: ["obsidian-bridge"] });

  const result = await createRuntimeCoreSession({
    lumeSessionId: "plugin-skill-context-session",
    cwd,
    agentDir,
    provider: "anthropic",
    resolvedModelId: "claude-sonnet-4-5",
    apiKey: "test-key",
    permissionMode: "plan",
  });

  expect(result.session.agent.state.systemPrompt).toContain("Enabled Plugins:");
  expect(result.session.agent.state.systemPrompt).toContain("obsidian-bridge:demo");
  result.session.dispose();
});
```

- [x] **Step 2: Run test to verify RED**

Run:

```powershell
bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "system prompt includes enabled plugin skills"
```

Expected: FAIL because plugin skills are registered with SDK but not injected into Lume dynamic prompt context.

- [x] **Step 3: Add plugin context model and renderer**

Add a small interface near `ContextAssemblyInput`:

```ts
export interface EnabledPluginContextItem {
  pluginId: string;
  displayName?: string;
  description?: string;
  skills: Array<{ name: string; description?: string }>;
  commandTools: string[];
  mcpServers: string[];
  diagnostics: string[];
}
```

Thread `enabledPlugins?: EnabledPluginContextItem[]` through `ContextAssembler` into `buildDynamicContext`.

In `agent-prompt-builder.ts`, render compact lines:

```ts
function renderEnabledPluginLines(plugins: EnabledPluginContextItem[]): string[] {
  if (plugins.length === 0) return [];
  const lines = ["Enabled Plugins:"];
  for (const plugin of plugins) {
    const label = plugin.displayName && plugin.displayName !== plugin.pluginId
      ? `${plugin.pluginId} (${plugin.displayName})`
      : plugin.pluginId;
    lines.push(`- ${label}: ${compactPromptText(plugin.description, 120) || "enabled plugin"}`);
    if (plugin.skills.length > 0) {
      lines.push(`  skills: ${plugin.skills.map((skill) => skill.name).join(", ")}`);
    }
    if (plugin.commandTools.length > 0 || plugin.mcpServers.length > 0) {
      lines.push(`  runtime: ${[...plugin.commandTools, ...plugin.mcpServers.map((id) => `mcp:${id}`)].join(", ")}`);
    }
    if (plugin.diagnostics.length > 0) {
      lines.push(`  diagnostics: ${plugin.diagnostics.join("; ")}`);
    }
  }
  lines.push("- To activate plugin instructions explicitly, the user or UI can prefix a message with $pluginId.");
  return lines;
}
```

- [x] **Step 4: Build context from plugin assembly in run.ts**

Create `buildEnabledPluginContext(registeredPlugins, pluginAssembly, pluginMcpRuntime.diagnostics)` in `run.ts` and pass it to `ContextAssembler`.

- [x] **Step 5: Run focused runtime test**

Run:

```powershell
bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "system prompt includes enabled plugin context"
```

Expected: PASS.

### Task 3: Plugin Detail Try-In-Chat Activation

**Files:**
- Modify: `apps/web/src/components/skills/SkillsMarketView.tsx`
- Modify: `apps/web/src/components/skills/PluginDetailPage.test.tsx`
- Optional Test: create `apps/web/src/components/skills/plugin-try-prompt-state.test.ts` and `apps/web/src/components/skills/plugin-try-prompt-state.ts`

- [x] **Step 1: Write failing state test**

Create a pure helper for default try prompts:

```ts
export function buildPluginTryPrompt(pluginId: string): string {
  if (pluginId === "obsidian-bridge") return "$obsidian-bridge 帮我检查 Obsidian 连接状态。";
  if (pluginId === "lume-chrome") return "$lume-chrome 说明当前 Chrome 连接状态，并告诉我你能控制什么。";
  return `$${pluginId} 说明这个插件现在可以做什么。`;
}
```

Test:

```ts
test("builds explicit plugin activation prompt", () => {
  expect(buildPluginTryPrompt("obsidian-bridge")).toBe("$obsidian-bridge 帮我检查 Obsidian 连接状态。");
  expect(buildPluginTryPrompt("demo")).toBe("$demo 说明这个插件现在可以做什么。");
});
```

- [x] **Step 2: Run test to verify RED**

Run:

```powershell
bun test apps/web/src/components/skills/plugin-try-prompt-state.test.ts
```

Expected: FAIL until the helper exists.

- [x] **Step 3: Implement helper and wire view**

Import `welcomePromptSeedAtom` and call:

```ts
const prompt = buildPluginTryPrompt(marketItem.pluginId);
setWelcomePromptSeed(prompt);
setTabs((previous) => upsertWelcomeTab(previous, workspaceId));
setActiveTabId("__welcome__");
```

- [x] **Step 4: Run focused web state test**

Run:

```powershell
bun test apps/web/src/components/skills/plugin-try-prompt-state.test.ts
```

Expected: PASS.

### Task 4: Obsidian Pairing Tools

**Files in `D:\workspace\projects\ai-projects\lume-plugins`:**
- Modify: `plugins/obsidian-bridge/lume-plugin.json`
- Create: `plugins/obsidian-bridge/src/mcp/token-store.ts`
- Modify: `plugins/obsidian-bridge/src/mcp/server.ts`
- Modify: `plugins/obsidian-bridge/src/mcp/tools.ts`
- Modify: `plugins/obsidian-bridge/src/mcp/obsidian-client.ts`
- Create or modify tests under `plugins/obsidian-bridge/tests/`
- Modify: `plugins/obsidian-bridge/README.md`
- Modify: `plugins/obsidian-bridge/skills/*/SKILL.md` only where setup preflight is helpful.

- [x] **Step 1: Write failing token-store test**

Create `plugins/obsidian-bridge/tests/mcp-token-store.test.ts`:

```ts
test("token store writes, reads, and forgets token without exposing it in status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "obsidian-token-store-"));
  const store = createFileTokenStore(join(dir, "token.json"));
  await store.write("TOK");
  assert.equal(await store.read(), "TOK");
  await store.clear();
  assert.equal(await store.read(), null);
});
```

- [x] **Step 2: Write failing tools test**

Use a fake server with a `tool(name, description, schema, handler)` method and a fake client. Assert `bridge_status`, `pair_with_code`, and `forget_pairing` are registered and do not return the token string.

- [x] **Step 3: Run tests to verify RED**

Run:

```powershell
npm test -- --test-name-pattern "token store|pair_with_code|bridge_status"
```

from `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge`.

Expected: FAIL because store/tools do not exist.

- [x] **Step 4: Implement token store**

Implement:

```ts
export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}
```

Default path:

```ts
join(homedir(), ".lume", "plugin-data", "obsidian-bridge", "token.json")
```

Use `OBSIDIAN_BRIDGE_TOKEN_STORE` override for tests and advanced users.

- [x] **Step 5: Implement tools**

Extend `registerTools(server, client, { tokenStore })` with:

- `bridge_status`
- `pair_with_code`
- `forget_pairing`

Existing read/write tools should catch `BridgeError` with `token_invalid` and return a clear pairing-required message.

- [x] **Step 6: Wire server**

Use token order:

```ts
getToken: async () => process.env.OBSIDIAN_BRIDGE_TOKEN ?? await tokenStore.read()
```

- [x] **Step 7: Run focused Obsidian tests and build**

Run:

```powershell
npm test -- --test-name-pattern "token store|pair_with_code|bridge_status|read_note"
npm run build:mcp
```

Expected: PASS and `dist/mcp.js` updated.

### Task 5: Chrome And Obsidian Metadata/Docs

**Files in `D:\workspace\projects\ai-projects\lume-plugins`:**
- Modify: `plugins/obsidian-bridge/lume-plugin.json`
- Modify: `plugins/obsidian-bridge/README.md`
- Modify: `plugins/lume-chrome/lume-plugin.json`
- Modify: `plugins/lume-chrome/README.md`
- Modify: `plugins/lume-chrome/skills/control-browser/SKILL.md`

- [x] **Step 1: Update Obsidian manifest**

Set:

```json
"permissions": {
  "mcpServers": { "register": true },
  "network": { "outbound": ["127.0.0.1:43112"] }
}
```

Change setup copy from “Lume 弹窗” to “在 Lume 对话中输入配对码，Agent 调用 `pair_with_code`”。

- [x] **Step 2: Update Chrome wording**

Make README and skill explicit that `$lume-chrome` is the activation path and browser secrets/OTP go through Lume `browserAuth` prompts.

- [x] **Step 3: Run plugin package checks**

Run:

```powershell
npm test
npm run build:mcp
```

from Obsidian plugin. For Chrome, run the focused package metadata test if it exists:

```powershell
npm test -- --test-name-pattern "plugin packaging|documentation"
```

### Task 6: Final Verification And Commits

**Files:**
- All modified files above.

- [x] **Step 1: Run focused Lume tests**

Run:

```powershell
bun test apps/sidecar/src/services/plugins/plugin-market-service.test.ts -t "plugin install records sensitive approval for declared MCP servers"
bun test apps/sidecar/src/services/agent-runtime/runtime-core/run.test.ts -t "system prompt includes enabled plugin skills"
bun test apps/web/src/components/skills/plugin-try-prompt-state.test.ts
```

- [x] **Step 2: Run focused plugin tests**

Run from `D:\workspace\projects\ai-projects\lume-plugins\plugins\obsidian-bridge`:

```powershell
npm test -- --test-name-pattern "token store|pair_with_code|bridge_status|read_note"
npm run build:mcp
```

- [x] **Step 3: Review diffs**

Run:

```powershell
git diff --check
git status --short
```

in both repositories.

- [x] **Step 4: Commit with Lore protocol**

Lume commit:

```text
✨ feat(sidecar,web): 打通插件授权与对话激活

Constraint: 复用现有插件权限状态和 welcome prompt seed
Tested: focused sidecar and web tests
```

Lume plugins commit:

```text
✨ feat(plugins): 支持 Obsidian 对话配对

Constraint: token 只保存在本地 store,不返回给工具结果
Tested: focused Obsidian MCP tests and build
```
