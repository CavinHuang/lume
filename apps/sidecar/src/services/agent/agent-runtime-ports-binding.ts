/**
 * RuntimeHostPorts 组装(#289):把应用层实现绑定到 agent-runtime 的 ports。
 * 本文件属于应用层(services/agent),方向为应用层→harness,合法;
 * agent-runtime 内部不得反向静态引用本文件之外的任何应用层模块。
 */
import {
  createAgentThreadWithModelRef,
  getAgentThreadMessages,
  getAgentThreadMeta,
  getAgentThreadSDKMessages,
  tryUpdateAgentThreadMeta,
  updateAgentThreadMeta
} from "./agent-thread-manager";
import { getAgentWorkspace } from "./agent-workspace-manager";
import { resolveAgentThreadWorkdir } from "./agent-workdir-resolver";
import { resolveThreadAttachmentPath, toThreadRelativePath } from "./agent-files-service";
import {
  buildBuiltinAgents,
  buildDynamicContext,
  buildSystemPromptAppend,
  loadCustomAgents
} from "./agent-prompt-builder";
import { resolveAgentDynamicContextInput } from "./agent-runtime-context";
import {
  decryptApiKey,
  getChannelById,
  isChannelConnectionUsable,
  listChannels,
  resolveChannelModelBinding
} from "../channel/channel-manager";
import { setRuntimeHostPorts } from "../agent-runtime/host-ports";
import { runAgentRuntime, stopAgentRuntime } from "../agent-runtime/runner/attempt";
import { registerRuntimeCoreEntry } from "../agent-runtime/runtime-core/runtime-entry";

let installed = false;

export function installRuntimeHostPorts(): void {
  if (installed) return;
  installed = true;
  registerRuntimeCoreEntry({ runAgentRuntime, stopAgentRuntime });
  setRuntimeHostPorts({
    getThreadMeta: getAgentThreadMeta,
    tryUpdateThreadMeta: tryUpdateAgentThreadMeta,
    updateThreadMeta: updateAgentThreadMeta,
    createThreadWithModelRef: createAgentThreadWithModelRef,
    getThreadMessages: getAgentThreadMessages,
    getThreadSDKMessages: getAgentThreadSDKMessages,
    getWorkspace: getAgentWorkspace,
    resolveThreadWorkdir: resolveAgentThreadWorkdir,
    resolveThreadAttachmentPath,
    toThreadRelativePath,
    buildBuiltinAgents,
    loadCustomAgents,
    buildSystemPromptAppend,
    buildDynamicContext,
    resolveDynamicContextInput: resolveAgentDynamicContextInput,
    listChannels,
    getChannelById,
    isChannelConnectionUsable,
    decryptApiKey,
    resolveChannelModelBinding
  });
}
