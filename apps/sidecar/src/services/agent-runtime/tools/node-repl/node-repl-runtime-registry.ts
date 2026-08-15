import { createNodeReplRuntimeClientFromEnv } from "./node-repl-runtime-manager";
import type {
  JsExecInput,
  NodeReplExecutionResult,
  NodeReplRuntimeClient,
  NodeReplRuntimeRegistry,
  NodeReplRuntimeExecOptions,
  RuntimeFactory
} from "./node-repl-types";

interface ThreadRuntimeEntry {
  client: NodeReplRuntimeClient;
  cwd: string;
  moduleDirs: string[];
  lastUsedAt: number;
}

// node_repl 按 thread 常驻后，闲置超时的沙箱回收，防止子进程无限累积
const IDLE_SHUTDOWN_MS = 30 * 60_000;

export function createNodeReplRuntimeRegistry(
  factory: RuntimeFactory,
  defaults: { cwd?: string } = {}
): NodeReplRuntimeRegistry {
  const entries = new Map<string, ThreadRuntimeEntry>();

  function sweepIdle(): void {
    const now = Date.now();
    for (const [threadId, entry] of entries) {
      if (now - entry.lastUsedAt > IDLE_SHUTDOWN_MS) {
        entries.delete(threadId);
        void entry.client.shutdown().catch(() => undefined);
      }
    }
  }

  async function ensure(threadId: string, options: { cwd?: string; sandbox?: import("@lume/agent-sdk").SandboxSettings } = {}): Promise<ThreadRuntimeEntry> {
    sweepIdle();
    const existing = entries.get(threadId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const cwd = options.cwd ?? defaults.cwd ?? process.cwd();
    const client = await factory({ threadId, cwd, sandbox: options.sandbox });
    const created: ThreadRuntimeEntry = { client, cwd, moduleDirs: [], lastUsedAt: Date.now() };
    entries.set(threadId, created);
    return created;
  }

  return {
    async addModuleDir(threadId: string, dir: string, options?: { cwd?: string; sandbox?: import("@lume/agent-sdk").SandboxSettings }) {
      const entry = await ensure(threadId, options);
      if (entry.moduleDirs.includes(dir)) return false;
      const added = await entry.client.addNodeModuleDirectory(dir);
      if (added) {
        entry.moduleDirs.push(dir);
      }
      return added;
    },
    async exec(threadId: string, input: JsExecInput, options?: { cwd?: string } & NodeReplRuntimeExecOptions): Promise<NodeReplExecutionResult> {
      const entry = await ensure(threadId, options);
      try {
        return await entry.client.exec(input, options);
      } catch (error) {
        await entry.client.shutdown().catch(() => undefined);
        entries.delete(threadId);
        throw error;
      }
    },
    async reset(threadId: string, options?: { cwd?: string; sandbox?: import("@lume/agent-sdk").SandboxSettings }) {
      const entry = await ensure(threadId, options);
      await entry.client.reset();
    },
    async shutdown(threadId: string) {
      const entry = entries.get(threadId);
      if (!entry) return;
      entries.delete(threadId);
      await entry.client.shutdown();
    },
    async shutdownAll() {
      const pending = [...entries.values()].map((entry) => entry.client.shutdown().catch(() => undefined));
      entries.clear();
      await Promise.all(pending);
    },
    debugSnapshot(threadId: string) {
      const entry = entries.get(threadId);
      return entry ? { moduleDirs: [...entry.moduleDirs], cwd: entry.cwd } : null;
    }
  };
}

let globalRegistry: NodeReplRuntimeRegistry | null = null;

export function getNodeReplRuntimeRegistry(): NodeReplRuntimeRegistry {
  if (!globalRegistry) {
    globalRegistry = createNodeReplRuntimeRegistry(createNodeReplRuntimeClientFromEnv);
  }
  return globalRegistry;
}
