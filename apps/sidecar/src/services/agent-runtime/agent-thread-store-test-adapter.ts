// apps/sidecar/src/services/agent-runtime/agent-thread-store-test-adapter.ts
/**
 * 测试装配：把真实线程/工作区存储实现注册进 holder 端口。
 *
 * 生产环境由 index.ts 组装层注册；测试进程不走 boot()，
 * 需要触达这些端口的用例在文件顶部调用本函数。
 */
import { registerAgentThreadStore } from "./agent-thread-store-holder";
import { registerAgentWorkspaceStore } from "./agent-workspace-store-holder";
import {
  createAgentThreadWithModelRef,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getAgentThreadSDKMessages,
  tryUpdateAgentThreadMeta,
  updateAgentThreadMeta,
} from "../agent/agent-thread-manager";
import { getAgentWorkspace } from "../agent/agent-workspace-manager";

/** 一次性注册全部存储端口（线程 + 工作区）。幂等，重复调用覆盖旧注册。 */
export function registerRealAgentStores(): void {
  registerAgentThreadStore({
    getMeta: getAgentThreadMeta,
    getMessages: getAgentThreadMessages,
    getSdkMessages: getAgentThreadSDKMessages,
    tryUpdateMeta: tryUpdateAgentThreadMeta,
    updateMeta: updateAgentThreadMeta,
    createWithModelRef: createAgentThreadWithModelRef,
  });
  registerAgentWorkspaceStore({
    get: getAgentWorkspace,
  });
}
