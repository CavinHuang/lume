/**
 * runner 编排入口的注册点(#289):runtime-core 的子代理工具需要发起/停止
 * 一次 run,但 attempt(编排)位于上层 runner——方向必须由上向下。组合根
 * (services/agent/agent-runtime-ports-binding.ts)注入,未注入即抛错。
 */
import type { AgentRuntimeEmitter, AgentRuntimeRunParams, AgentRuntimeRunResult } from "./types";

export interface RuntimeCoreEntry {
  runAgentRuntime: (
    params: AgentRuntimeRunParams,
    emit: AgentRuntimeEmitter
  ) => Promise<AgentRuntimeRunResult>;
  stopAgentRuntime: (threadId: string) => Promise<boolean>;
}

let entry: RuntimeCoreEntry | null = null;

export function registerRuntimeCoreEntry(registry: RuntimeCoreEntry): void {
  entry = registry;
}

export function getRuntimeCoreEntry(): RuntimeCoreEntry {
  if (!entry) {
    throw new Error(
      "RuntimeCoreEntry 未注册:组合根须调用 registerRuntimeCoreEntry();测试经 --preload 注入"
    );
  }
  return entry;
}
