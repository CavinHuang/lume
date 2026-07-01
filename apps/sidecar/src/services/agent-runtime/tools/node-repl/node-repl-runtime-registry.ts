import { createNodeReplRuntimeClientFromEnv } from "./node-repl-runtime-manager";
import type {
  JsExecInput,
  NodeReplExecutionResult,
  NodeReplRuntimeClient,
  NodeReplRuntimeRegistry,
  RuntimeFactory
} from "./node-repl-types";

interface ThreadRuntimeEntry {
  client: NodeReplRuntimeClient;
  cwd: string;
  moduleDirs: string[];
}

export function createNodeReplRuntimeRegistry(
  factory: RuntimeFactory,
  defaults: { cwd?: string } = {}
): NodeReplRuntimeRegistry {
  const entries = new Map<string, ThreadRuntimeEntry>();

  async function ensure(threadId: string, options: { cwd?: string } = {}): Promise<ThreadRuntimeEntry> {
    const existing = entries.get(threadId);
    if (existing) return existing;

    const cwd = options.cwd ?? defaults.cwd ?? process.cwd();
    const client = await factory({ threadId, cwd });
    const created: ThreadRuntimeEntry = { client, cwd, moduleDirs: [] };
    entries.set(threadId, created);
    return created;
  }

  return {
    async addModuleDir(threadId: string, dir: string, options?: { cwd?: string }) {
      const entry = await ensure(threadId, options);
      if (entry.moduleDirs.includes(dir)) return false;
      const added = await entry.client.addNodeModuleDirectory(dir);
      if (added) {
        entry.moduleDirs.push(dir);
      }
      return added;
    },
    async exec(threadId: string, input: JsExecInput, options?: { cwd?: string }): Promise<NodeReplExecutionResult> {
      const entry = await ensure(threadId, options);
      try {
        return await entry.client.exec(input);
      } catch (error) {
        await entry.client.shutdown().catch(() => undefined);
        entries.delete(threadId);
        throw error;
      }
    },
    async reset(threadId: string, options?: { cwd?: string }) {
      const entry = await ensure(threadId, options);
      await entry.client.reset();
    },
    async shutdown(threadId: string) {
      const entry = entries.get(threadId);
      if (!entry) return;
      await entry.client.shutdown();
      entries.delete(threadId);
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
