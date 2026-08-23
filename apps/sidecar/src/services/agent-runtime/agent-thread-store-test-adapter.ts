// apps/sidecar/src/services/agent-runtime/agent-thread-store-test-adapter.ts
/**
 * 测试装配：把真实线程存储实现注册进 holder 端口。
 *
 * 生产环境由 index.ts 组装层注册；测试进程不走 boot()，
 * 需要触达线程存储的用例在文件顶部调用本函数。
 */
import { registerAgentThreadStore } from "./agent-thread-store-holder";
import {
  createAgentThreadWithModelRef,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getAgentThreadSDKMessages,
  tryUpdateAgentThreadMeta,
  updateAgentThreadMeta,
} from "../agent/agent-thread-manager";

export function registerRealAgentThreadStore(): void {
  registerAgentThreadStore({
    getMeta: getAgentThreadMeta,
    getMessages: getAgentThreadMessages,
    getSdkMessages: getAgentThreadSDKMessages,
    tryUpdateMeta: tryUpdateAgentThreadMeta,
    updateMeta: updateAgentThreadMeta,
    createWithModelRef: createAgentThreadWithModelRef,
  });
}
