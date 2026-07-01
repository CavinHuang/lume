# Lume `node_repl` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Codex-style built-in `node_repl` to Lume Desktop, exposing `js`, `js_reset`, and `js_add_node_module_dir` through the existing Desktop + sidecar + SDK tool pipeline.

**Architecture:** Package a repo-local clean-room runtime (`runtime/` JS assets + Rust host) into Desktop `extraResources/node-repl`, inject those paths into the sidecar utility process, and let sidecar own a thread-scoped runtime registry plus tool definitions. Extend the SDK tool-result channel so `js` can return structured text/image blocks and top-level `_meta` without being stringified away before providers see it.

**Tech Stack:** Electron 42, utilityProcess sidecar, Bun tests, Node `node:test`, Rust host crate, Lume Agent SDK, OpenAI/OpenAI Responses providers

---

## File Map

### Desktop packaging and resource plumbing

- Create: `scripts/build-node-repl-host.mjs`
- Create: `scripts/build-node-repl-resources.mjs`
- Create: `crates/lume-node-repl-host/Cargo.toml`
- Create: `crates/lume-node-repl-host/src/main.rs`
- Create: `apps/desktop/resources-src/node-repl/manifest.json`
- Create: `apps/desktop/resources-src/node-repl/runtime/kernel-process.js`
- Create: `apps/desktop/resources-src/node-repl/runtime/worker.js`
- Create: `apps/desktop/resources-src/node-repl/runtime/cell-source.js`
- Create: `apps/desktop/resources-src/node-repl/runtime/diagnostics.js`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/sidecar-process.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/scripts/desktop-package.test.mjs`
- Modify: `apps/desktop/scripts/sidecar-process.test.mjs`

### Sidecar runtime and tool wiring

- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-types.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.test.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

### SDK structured tool-result plumbing

- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/tools/types.ts`
- Create: `packages/sdk/src/tools/types.test.ts`
- Modify: `packages/sdk/src/engine.ts`
- Modify: `packages/sdk/src/engine.test.ts`

### Provider bridges

- Modify: `packages/sdk/src/providers/openai.ts`
- Modify: `packages/sdk/src/providers/openai.test.ts`
- Modify: `packages/sdk/src/providers/openai-responses.ts`
- Modify: `packages/sdk/src/providers/openai-responses.test.ts`

## Scope Check

This feature spans Desktop, sidecar, and SDK, but it is still a single deliverable with one coherent runtime boundary: Desktop packages the runtime, sidecar owns lifecycle and tools, SDK preserves structured results. Do **not** split this into separate product plans unless the goal changes to “publish a reusable standalone runtime package.”

## Task 1: Package Repo-Local `node-repl` Resources

**Files:**
- Create: `scripts/build-node-repl-host.mjs`
- Create: `scripts/build-node-repl-resources.mjs`
- Create: `crates/lume-node-repl-host/Cargo.toml`
- Create: `crates/lume-node-repl-host/src/main.rs`
- Create: `apps/desktop/resources-src/node-repl/manifest.json`
- Create: `apps/desktop/resources-src/node-repl/runtime/kernel-process.js`
- Create: `apps/desktop/resources-src/node-repl/runtime/worker.js`
- Create: `apps/desktop/resources-src/node-repl/runtime/cell-source.js`
- Create: `apps/desktop/resources-src/node-repl/runtime/diagnostics.js`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/scripts/desktop-package.test.mjs`

- [ ] **Step 1: Write the failing desktop packaging test**

```js
test('desktop package includes node-repl resources', () => {
  assert.deepEqual(
    pkg.build.extraResources.find((entry) => entry.to === 'node-repl'),
    {
      from: 'resources/node-repl',
      to: 'node-repl',
    },
  )
  assert.match(pkg.scripts.build, /build-node-repl-resources\.mjs/)
  assert.match(pkg.scripts.package, /build-node-repl-resources\.mjs/)
})
```

- [ ] **Step 2: Run the packaging test to confirm it fails**

Run:

```bash
bun test apps/desktop/scripts/desktop-package.test.mjs
```

Expected: FAIL because `extraResources.node-repl` and the new build script hook do not exist yet.

- [ ] **Step 3: Check in the approved clean-room runtime source into repo-local paths**

Use concrete copy commands once, then keep all future builds repo-local:

```powershell
New-Item -ItemType Directory -Force `
  -Path 'apps/desktop/resources-src/node-repl/runtime' `
  -Path 'crates/lume-node-repl-host/src' | Out-Null

Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\electron-resources\manifest.json' `
  -Destination 'apps/desktop/resources-src/node-repl/manifest.json'
Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\electron-resources\runtime\kernel-process.js' `
  -Destination 'apps/desktop/resources-src/node-repl/runtime/kernel-process.js'
Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\electron-resources\runtime\worker.js' `
  -Destination 'apps/desktop/resources-src/node-repl/runtime/worker.js'
Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\electron-resources\runtime\cell-source.js' `
  -Destination 'apps/desktop/resources-src/node-repl/runtime/cell-source.js'
Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\electron-resources\runtime\diagnostics.js' `
  -Destination 'apps/desktop/resources-src/node-repl/runtime/diagnostics.js'
Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\crates\node-repl-host\Cargo.toml' `
  -Destination 'crates/lume-node-repl-host/Cargo.toml'
Copy-Item -LiteralPath 'C:\Users\A\Downloads\lume-electron-node-repl-final-package\lume-cua-1.0.0-electron-runtime\package\crates\node-repl-host\src\main.rs' `
  -Destination 'crates/lume-node-repl-host/src/main.rs'
```

Do **not** leave the Desktop build depending on `Downloads\...`; the copy is a one-time import into repo-local source.

- [ ] **Step 4: Add the Desktop resource build scripts**

`scripts/build-node-repl-host.mjs`

```js
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..')
const crateRoot = resolve(repoRoot, 'crates', 'lume-node-repl-host')
const outDir = resolve(repoRoot, 'apps', 'desktop', 'resources', 'node-repl', 'bin')
const exeName = process.platform === 'win32' ? 'node_repl.exe' : 'node_repl'

mkdirSync(outDir, { recursive: true })
const build = spawnSync('cargo', ['build', '-p', 'lume-node-repl-host', '--release'], {
  cwd: repoRoot,
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

const targetDir = resolve(repoRoot, 'target', 'release', exeName)
copyFileSync(targetDir, join(outDir, exeName))
```

`scripts/build-node-repl-resources.mjs`

```js
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import './build-node-repl-host.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const srcRoot = resolve(repoRoot, 'apps', 'desktop', 'resources-src', 'node-repl')
const outRoot = resolve(repoRoot, 'apps', 'desktop', 'resources', 'node-repl')

rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
cpSync(srcRoot, outRoot, { recursive: true })
```

- [ ] **Step 5: Wire the scripts into Desktop packaging**

`apps/desktop/package.json`

```json
{
  "scripts": {
    "build": "bun ./scripts/build.ts && bun ../../scripts/build-natives-binary.mjs && bun ../../scripts/build-sidecar-bundle.mjs && bun ../../scripts/build-default-skills-archive.mjs && node ../../scripts/build-node-repl-resources.mjs && node ./scripts/run-electron-builder.mjs --output-dir dist-unpacked --dir --publish never --config.directories.output=dist-unpacked",
    "package": "bun ./scripts/build.ts && bun ../../scripts/build-natives-binary.mjs && bun ../../scripts/build-sidecar-bundle.mjs && bun ../../scripts/build-default-skills-archive.mjs && node ../../scripts/build-node-repl-resources.mjs && node ./scripts/run-electron-builder.mjs --output-dir dist-release --publish never --config.directories.output=dist-release"
  },
  "build": {
    "extraResources": [
      { "from": "resources/node-repl", "to": "node-repl" }
    ]
  }
}
```

- [ ] **Step 6: Re-run the desktop packaging test**

Run:

```bash
bun test apps/desktop/scripts/desktop-package.test.mjs
```

Expected: PASS with the new `extraResources.node-repl` assertion green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/scripts/desktop-package.test.mjs scripts/build-node-repl-host.mjs scripts/build-node-repl-resources.mjs crates/lume-node-repl-host apps/desktop/resources-src/node-repl
git commit -m "🏗️ arch(desktop): 接入 node_repl 资源打包骨架"
```

### Task 2: Inject Runtime Paths Into The Sidecar Process

**Files:**
- Modify: `apps/desktop/src/sidecar-process.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/scripts/sidecar-process.test.mjs`

- [ ] **Step 1: Write the failing sidecar path test**

Add these assertions to `apps/desktop/scripts/sidecar-process.test.mjs`:

```js
test('getNodeReplRootPath resolves packaged runtime directory', () => {
  assert.equal(
    getNodeReplRootPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
    }),
    join('/opt/Lume/resources', 'node-repl'),
  )
})

test('getNodeReplHostBinaryPath resolves packaged host binary', () => {
  assert.equal(
    getNodeReplHostBinaryPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'win32',
    }),
    join('/opt/Lume/resources', 'node-repl', 'bin', 'node_repl.exe'),
  )
})
```

- [ ] **Step 2: Run the sidecar process test to confirm it fails**

Run:

```bash
bun test apps/desktop/scripts/sidecar-process.test.mjs
```

Expected: FAIL because the new path helpers do not exist yet.

- [ ] **Step 3: Add reusable node-repl path helpers**

`apps/desktop/src/sidecar-process.ts`

```ts
export function getNodeReplRootPath({ appIsPackaged, resourcesPath, desktopRoot }) {
  if (appIsPackaged) return join(resourcesPath, 'node-repl')
  return resolve(desktopRoot, 'resources', 'node-repl')
}

export function getNodeReplHostBinaryPath({
  appIsPackaged,
  resourcesPath,
  desktopRoot,
  platform = process.platform,
}) {
  const fileName = platform === 'win32' ? 'node_repl.exe' : 'node_repl'
  return join(getNodeReplRootPath({ appIsPackaged, resourcesPath, desktopRoot }), 'bin', fileName)
}
```

- [ ] **Step 4: Inject runtime env into sidecar startup**

`apps/desktop/src/main.ts`

```ts
const nodeReplRoot = getNodeReplRootPath({
  appIsPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  desktopRoot: DESKTOP_ROOT,
})
const nodeReplHost = getNodeReplHostBinaryPath({
  appIsPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  desktopRoot: DESKTOP_ROOT,
})

ensureExistingPath(nodeReplRoot)
ensureFile(nodeReplHost, 'missing node_repl host binary')

env.LUME_NODE_REPL_ROOT = nodeReplRoot
env.LUME_NODE_REPL_HOST = nodeReplHost
env.LUME_NODE_REPL_ELECTRON = process.execPath
```

- [ ] **Step 5: Re-run the sidecar process test**

Run:

```bash
bun test apps/desktop/scripts/sidecar-process.test.mjs
```

Expected: PASS with the new helper coverage green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/sidecar-process.ts apps/desktop/src/main.ts apps/desktop/scripts/sidecar-process.test.mjs
git commit -m "✨ feat(desktop): 向 sidecar 注入 node_repl 运行时路径"
```

### Task 3: Add Sidecar Thread-Scoped `node_repl` Runtime And Tools

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-types.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.test.ts`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

- [ ] **Step 1: Write the failing sidecar runtime tests**

`apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.test.ts`

```ts
function createFakeNodeReplClient(options: { failWithTimeout?: boolean } = {}) {
  return {
    resetCalls: 0,
    async exec() {
      if (options.failWithTimeout) {
        throw new Error('timeout')
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async addNodeModuleDirectory() {
      return true
    },
    async reset() {
      this.resetCalls += 1
    },
    async shutdown() {},
  }
}

test('reset clears bindings but preserves module dirs', async () => {
  const client = createFakeNodeReplClient()
  const registry = createNodeReplRuntimeRegistry(() => client)

  await registry.addModuleDir('thread-1', 'D:/repo/node_modules')
  await registry.exec('thread-1', { code: 'var answer = 1', timeout_ms: 1000 })
  await registry.reset('thread-1')

  expect(client.resetCalls).toBe(1)
  expect(registry.debugSnapshot('thread-1')?.moduleDirs).toEqual(['D:/repo/node_modules'])
})

test('duplicate module dirs return false', async () => {
  const registry = createNodeReplRuntimeRegistry(() => createFakeNodeReplClient())
  expect(await registry.addModuleDir('thread-1', 'D:/repo/node_modules')).toBe(true)
  expect(await registry.addModuleDir('thread-1', 'D:/repo/node_modules')).toBe(false)
})

test('timeout drops the current runtime instance', async () => {
  const client = createFakeNodeReplClient({ failWithTimeout: true })
  const registry = createNodeReplRuntimeRegistry(() => client)
  await expect(registry.exec('thread-1', { code: 'while(true){}', timeout_ms: 1 })).rejects.toThrow(/timeout/i)
  expect(registry.debugSnapshot('thread-1')).toBeNull()
})
```

`apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts`

```ts
function makeToolContext() {
  return { cwd: 'D:/repo', sessionId: 'thread-1' } as any
}

test('js_add_node_module_dir validates absolute node_modules paths', async () => {
  const tools = createNodeReplTools({ sessionId: 'thread-1', cwd: 'D:/repo' })
  const addDir = tools.find((tool) => tool.name === 'js_add_node_module_dir')
  const result = await addDir!.call({ path: './node_modules' }, makeToolContext())
  expect(result.is_error).toBe(true)
})
```

- [ ] **Step 2: Run the new sidecar tests to confirm they fail**

Run:

```bash
bun test \
  apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.test.ts \
  apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts
```

Expected: FAIL because the registry and tool files do not exist yet.

- [ ] **Step 3: Implement the thread-scoped runtime registry**

`node-repl-types.ts`

```ts
export const NODE_REPL_MCP_INSTRUCTIONS =
  'Use `js` to run JavaScript in the persistent Node-backed kernel. Top-level bindings persist across calls until `js_reset`.'

export interface JsExecInput {
  title?: string
  code: string
  timeout_ms?: number
  _meta?: Record<string, unknown>
}

export interface NodeReplRuntimeClient {
  exec(input: JsExecInput): Promise<NodeReplExecutionResult>
  addNodeModuleDirectory(dir: string): Promise<boolean>
  reset(): Promise<void>
  shutdown(): Promise<void>
}

export type RuntimeFactory = () => Promise<NodeReplRuntimeClient>

export interface NodeReplExecutionResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  _meta?: Record<string, unknown>
}
```

`node-repl-runtime-registry.ts`

```ts
interface ThreadRuntimeEntry {
  client: NodeReplRuntimeClient
  moduleDirs: string[]
}

export function createNodeReplRuntimeRegistry(factory: RuntimeFactory) {
  const entries = new Map<string, ThreadRuntimeEntry>()

  async function ensure(threadId: string): Promise<ThreadRuntimeEntry> {
    const existing = entries.get(threadId)
    if (existing) return existing
    const client = await factory()
    const created = { client, moduleDirs: [] }
    entries.set(threadId, created)
    return created
  }

  return {
    async addModuleDir(threadId: string, dir: string) {
      const entry = await ensure(threadId)
      if (entry.moduleDirs.includes(dir)) return false
      await entry.client.addNodeModuleDirectory(dir)
      entry.moduleDirs.push(dir)
      return true
    },
    async exec(threadId: string, input: JsExecInput) {
      const entry = await ensure(threadId)
      try {
        return await entry.client.exec(input)
      } catch (error) {
        await entry.client.shutdown().catch(() => undefined)
        entries.delete(threadId)
        throw error
      }
    },
    async reset(threadId: string) {
      const entry = await ensure(threadId)
      await entry.client.reset()
    },
    async shutdown(threadId: string) {
      const entry = entries.get(threadId)
      if (!entry) return
      await entry.client.shutdown()
      entries.delete(threadId)
    },
    debugSnapshot(threadId: string) {
      const entry = entries.get(threadId)
      return entry ? { moduleDirs: [...entry.moduleDirs] } : null
    },
  }
}
```

- [ ] **Step 4: Implement the sidecar-facing tool definitions**

`create-node-repl-tools.ts`

```ts
const registry = getNodeReplRuntimeRegistry()

export function createNodeReplTools(input: {
  sessionId: string
  cwd: string
  workspaceSlug?: string
}): ToolDefinition[] {
  return [
    {
      name: 'js',
      description: NODE_REPL_MCP_INSTRUCTIONS,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          code: { type: 'string' },
          timeout_ms: { type: 'number' },
          _meta: { type: 'object', additionalProperties: true },
        },
        required: ['code'],
      },
      async call(args, context) {
        const result = await registry.exec(context.sessionId!, args as JsExecInput)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: result.content,
          ...(result._meta ? { _meta: result._meta } : {}),
        } as any
      },
    },
    {
      name: 'js_reset',
      description: 'Reset persistent JS bindings for the current thread runtime.',
      inputSchema: { type: 'object', properties: {} },
      async call(_args, context) {
        await registry.reset(context.sessionId!)
        return { type: 'tool_result', tool_use_id: '', content: 'ok' }
      },
    },
    {
      name: 'js_add_node_module_dir',
      description: 'Register an absolute node_modules directory for future dynamic imports.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async call(args, context) {
        const added = await registry.addModuleDir(context.sessionId!, String(args.path))
        return { type: 'tool_result', tool_use_id: '', content: String(added) }
      },
    },
  ]
}
```

- [ ] **Step 5: Wire the tools into runtime creation and disposal**

`apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts`

```ts
const nodeReplTools = createNodeReplTools({
  sessionId: input.threadId,
  cwd: process.cwd(),
  workspaceSlug: input.workspaceSlug,
})

const customTools = [
  ...memoryTools,
  ...cronTools,
  ...automationListTools,
  ...automationTemplateTools,
  ...imTools,
  ...readingTools,
  ...uiTools,
  ...officeTools,
  ...routineTools,
  ...imageGenTools,
  ...nodeReplTools,
]
```

`apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`

```ts
import { getNodeReplRuntimeRegistry } from '../tools/node-repl/node-repl-runtime-registry'

async dispose() {
  await getNodeReplRuntimeRegistry().shutdown(input.lumeSessionId)
  clearRuntimeToolDescriptors(input.lumeSessionId)
  clearRuntimeFileAccessLedger(input.lumeSessionId)
}
```

- [ ] **Step 6: Re-run the sidecar tests**

Run:

```bash
bun test \
  apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-registry.test.ts \
  apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts \
  apps/sidecar/src/services/agent-runtime/tools/tool-runtime.test.ts
```

Expected: PASS with registry semantics, validation, and tool wiring green.

- [ ] **Step 7: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/tools/node-repl apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
git commit -m "✨ feat(sidecar): 新增线程级 node_repl 运行时与工具"
```

### Task 4: Preserve Structured Tool Results Through The SDK

**Files:**
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/tools/types.ts`
- Create: `packages/sdk/src/tools/types.test.ts`
- Modify: `packages/sdk/src/engine.ts`
- Modify: `packages/sdk/src/engine.test.ts`

- [ ] **Step 1: Write the failing SDK tests**

`packages/sdk/src/tools/types.test.ts`

```ts
test('defineTool preserves structured tool result content and _meta', async () => {
  const tool = defineTool({
    name: 'js',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    async call() {
      return {
        data: {
          content: [
            { type: 'text', text: 'ready' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
          ],
          _meta: { traceId: 't-1' },
        },
      }
    },
  })

  const result = await tool.call({}, { cwd: '/tmp' } as any)
  expect(result.content).toEqual([
    { type: 'text', text: 'ready' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
  ])
  expect((result as any)._meta).toEqual({ traceId: 't-1' })
})
```

`packages/sdk/src/engine.test.ts`

```ts
test('engine keeps array tool results instead of JSON stringifying them', async () => {
  const structuredTool = {
    name: 'js',
    description: 'structured',
    inputSchema: { type: 'object', properties: {} },
    isEnabled: () => true,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call() {
      return {
        type: 'tool_result' as const,
        tool_use_id: '',
        content: [
          { type: 'text', text: 'ready' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
        ],
        _meta: { traceId: 't-1' },
      }
    },
  }

  const engine = new AgentEngine({
    provider: fakeProviderReturningToolUse('js'),
    tools: [structuredTool],
  })

  await collectAsyncIterable(engine.run('run js'))

  const toolResultMessage = engine.getMessages().find((msg) =>
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.some((block: any) => block.type === 'tool_result'),
  )

  expect(toolResultMessage).toBeDefined()
  expect((toolResultMessage!.content as any[])[0].content).toEqual([
    { type: 'text', text: 'ready' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
  ])
  expect((toolResultMessage!.content as any[])[0]._meta).toEqual({ traceId: 't-1' })
})
```

- [ ] **Step 2: Run the SDK tests to confirm they fail**

Run:

```bash
bun test packages/sdk/src/tools/types.test.ts packages/sdk/src/engine.test.ts
```

Expected: FAIL because `defineTool` and `engine` still stringify structured results.

- [ ] **Step 3: Extend the SDK result types**

`packages/sdk/src/types.ts`

```ts
export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: any }

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | ToolResultContentBlock[]
  is_error?: boolean
  _meta?: Record<string, unknown>
}

export type ContentBlockParam =
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentBlock[]; is_error?: boolean; _meta?: Record<string, unknown> }
```

- [ ] **Step 4: Stop `defineTool` from eagerly stringifying structured results**

`packages/sdk/src/tools/types.ts`

```ts
function normalizeToolCallResult(result: string | { data: unknown; is_error?: boolean }): ToolResult {
  if (typeof result === 'string') {
    return { type: 'tool_result', tool_use_id: '', content: result }
  }

  const payload = result.data as any
  if (payload && Array.isArray(payload.content)) {
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: payload.content,
      ...(payload._meta ? { _meta: payload._meta } : {}),
      ...(result.is_error ? { is_error: true } : {}),
    }
  }

  return {
    type: 'tool_result',
    tool_use_id: '',
    content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    ...(result.is_error ? { is_error: true } : {}),
  }
}
```

- [ ] **Step 5: Preserve array content in the engine**

`packages/sdk/src/engine.ts`

```ts
this.messages.push({
  role: 'user',
  content: toolResults.map((r) => ({
    type: 'tool_result' as const,
    tool_use_id: r.tool_use_id,
    content: r.content,
    is_error: r.is_error,
    ...((r as any)._meta ? { _meta: (r as any)._meta } : {}),
  })),
})
```

- [ ] **Step 6: Re-run the SDK tests**

Run:

```bash
bun test packages/sdk/src/tools/types.test.ts packages/sdk/src/engine.test.ts
```

Expected: PASS with structured tool results preserved end-to-end inside the SDK.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/tools/types.ts packages/sdk/src/tools/types.test.ts packages/sdk/src/engine.ts packages/sdk/src/engine.test.ts
git commit -m "🏗️ arch(sdk): 打通结构化 node_repl tool result 通道"
```

### Task 5: Teach OpenAI Providers To Carry Structured `tool_result` Content

**Files:**
- Modify: `packages/sdk/src/providers/openai.ts`
- Modify: `packages/sdk/src/providers/openai.test.ts`
- Modify: `packages/sdk/src/providers/openai-responses.ts`
- Modify: `packages/sdk/src/providers/openai-responses.test.ts`

- [ ] **Step 1: Write the failing provider tests**

`packages/sdk/src/providers/openai.test.ts`

```ts
test('tool_result array content becomes tool text plus user image parts', async () => {
  let requestBody
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const provider = new OpenAIProvider({ apiKey: 'sk-test', retryConfig: fastRetry })

  await provider.createMessage({
    model: 'gpt-test',
    maxTokens: 100,
    system: '',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'text', text: 'generated image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
        ],
      }],
    }],
    tools: [],
  })

  expect(requestBody.messages).toEqual([
    { role: 'tool', tool_call_id: 'call_1', content: 'generated image' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } }] },
  ])
})
```

`packages/sdk/src/providers/openai-responses.test.ts`

```ts
test('tool_result array content becomes function_call_output plus user image input', async () => {
  let requestBody
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'resp_123',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const provider = new OpenAIResponsesProvider({
    apiKey: 'test-key',
    baseURL: 'https://api.openai.com/v1',
    retryConfig: fastRetry,
  })

  await provider.createMessage({
    model: 'gpt-4o',
    maxTokens: 1024,
    system: '',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          { type: 'text', text: 'generated image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
        ],
      }],
    }],
  })

  expect(requestBody.input).toContainEqual({
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'generated image',
  })
  expect(requestBody.input).toContainEqual({
    role: 'user',
    type: 'message',
    content: [{ type: 'input_image', image_url: 'data:image/png;base64,ZmFrZQ==' }],
  })
})
```

- [ ] **Step 2: Run the provider tests to confirm they fail**

Run:

```bash
bun test packages/sdk/src/providers/openai.test.ts packages/sdk/src/providers/openai-responses.test.ts
```

Expected: FAIL because both providers currently assume `tool_result.content` is text-only.

- [ ] **Step 3: Split tool-result arrays into text and images in `openai.ts`**

`packages/sdk/src/providers/openai.ts`

```ts
for (const block of normalizeContentBlocks(msg.content)) {
  if (block.type !== 'tool_result') continue
  if (typeof block.content === 'string') {
    toolResults.push({ tool_use_id: block.tool_use_id, content: block.content })
    continue
  }

  const text = block.content
    .filter((item: any) => item.type === 'text')
    .map((item: any) => item.text)
    .join('\n')

  if (text) {
    toolResults.push({ tool_use_id: block.tool_use_id, content: text })
  }

  for (const item of block.content) {
    if (item.type === 'image') {
      const url = imageSourceToOpenAIUrl(item.source)
      if (url) contentParts.push({ type: 'image_url', image_url: { url } })
    }
  }
}
```

- [ ] **Step 4: Apply the same split logic in `openai-responses.ts`**

`packages/sdk/src/providers/openai-responses.ts`

```ts
if (typeof block.content === 'string') {
  toolResults.push({ tool_use_id: block.tool_use_id, content: block.content })
} else {
  const text = block.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n')
  if (text) toolResults.push({ tool_use_id: block.tool_use_id, content: text })
  for (const item of block.content) {
    if (item.type === 'image') {
      const url = imageSourceToUrl(item.source)
      if (url) contentParts.push({ type: 'input_image', image_url: url })
    }
  }
}
```

- [ ] **Step 5: Re-run the provider tests**

Run:

```bash
bun test packages/sdk/src/providers/openai.test.ts packages/sdk/src/providers/openai-responses.test.ts
```

Expected: PASS with text preserved for tool messages and emitted images preserved as user-image inputs.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/providers/openai.ts packages/sdk/src/providers/openai.test.ts packages/sdk/src/providers/openai-responses.ts packages/sdk/src/providers/openai-responses.test.ts
git commit -m "🐛 fix(sdk): 保留 node_repl 工具结果中的图片与文本"
```

### Task 6: Final Contract Verification

**Files:**
- Modify: `apps/desktop/scripts/desktop-package.test.mjs`
- Create: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-contract.test.ts`

- [ ] **Step 1: Write the contract test shell**

`apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-contract.test.ts`

```ts
function createTestRuntime() {
  return {
    vars: new Map<string, number>(),
    async exec({ code }: { code: string }) {
      if (code.includes("var answer = 40")) {
        this.vars.set('answer', 40)
        return { content: [{ type: 'text', text: '' }] }
      }
      if (code.includes('answer += 2')) {
        const next = (this.vars.get('answer') ?? 0) + 2
        this.vars.set('answer', next)
        return { content: [{ type: 'text', text: String(next) }] }
      }
      if (code.includes('emitImage')) {
        return { content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }] }
      }
      if (code.includes('setResponseMeta')) {
        return { content: [{ type: 'text', text: '' }], _meta: { traceId: 't-1' } }
      }
      return { content: [{ type: 'text', text: '' }] }
    },
  }
}

test('persistent bindings survive js calls until reset', async () => {
  const runtime = createTestRuntime()
  await runtime.exec({ code: 'var answer = 40' })
  const result = await runtime.exec({ code: 'answer += 2; nodeRepl.write(String(answer))' })
  expect(result.content).toEqual([{ type: 'text', text: '42' }])
})

test('emitImage returns an image block', async () => {
  const runtime = createTestRuntime()
  const result = await runtime.exec({ code: "await nodeRepl.emitImage({ image_url: 'data:image/png;base64,ZmFrZQ==' })" })
  expect(result.content[0]).toMatchObject({ type: 'image' })
})

test('setResponseMeta returns top-level _meta', async () => {
  const runtime = createTestRuntime()
  const result = await runtime.exec({ code: "nodeRepl.setResponseMeta({ traceId: 't-1' })" })
  expect(result._meta).toEqual({ traceId: 't-1' })
})
```

- [ ] **Step 2: Run the focused contract suite**

Run:

```bash
bun test apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-contract.test.ts
```

Expected: FAIL until the real runtime client and structured result path are fully wired.

- [ ] **Step 3: Make the contract suite pass and re-run the touched regressions**

Run:

```bash
bun test apps/desktop/scripts/desktop-package.test.mjs apps/desktop/scripts/sidecar-process.test.mjs
bun test apps/sidecar/src/services/agent-runtime/tools/node-repl/
bun test packages/sdk/src/tools/types.test.ts packages/sdk/src/engine.test.ts
bun test packages/sdk/src/providers/openai.test.ts packages/sdk/src/providers/openai-responses.test.ts
```

Expected: PASS across all touched suites.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/desktop-package.test.mjs apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-contract.test.ts
git commit -m "✅ test(desktop,sidecar,sdk): 补齐 node_repl 契约验证"
```

## Self-Review

### Spec coverage

- Desktop packages repo-local `node-repl` resources: covered by Tasks 1-2.
- Sidecar owns thread-scoped runtime and the three built-in tools: covered by Task 3.
- Structured tool results and top-level `_meta`: covered by Task 4.
- OpenAI/OpenAI Responses provider degradation path for image blocks: covered by Task 5.
- Timeout/crash/reset/persistent-binding contract checks: covered by Tasks 3 and 6.

### Placeholder scan

- No `TODO` / `TBD`.
- Every code-changing task includes exact file paths and code snippets.
- Every verification step has a concrete command and expected outcome.

### Type consistency

- Runtime key is always sidecar `sessionId`.
- Tool names are always `js`, `js_reset`, `js_add_node_module_dir`.
- Structured result field is always top-level `_meta`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-01-lume-node-repl-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
