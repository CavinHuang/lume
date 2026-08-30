/**
 * sidecar 终端 RPC 桥 —— `terminal:create/write/resize/dispose` 方法注册 +
 * `terminal:data` 输出通知外发。
 *
 * 传输决策：不复用 browser 命令桥的 MAC+sequence 传输。那是为「sidecar→main 请求」
 * 设计的（sidecar 是被 fork 的一方，需防伪造载荷）；终端方向相反——main→sidecar
 * 走既有 fork RPC（进程内通道，desktop 侧 sidecarHost.call），sidecar→main 输出走
 * 既有通知通道（terminal:data），与 planning-todo-changed 等通知同型，无需再认证。
 *
 * 会话生命周期：桥懒创建并持有唯一 TerminalService 实例（getTerminalBridgeHandlers
 * 模块级缓存）；sidecar 优雅关停时由组合根调用 disposeTerminalBridge() 回收 shell。
 */
import { validateInput, z } from "../../rpc/validation";
import type { NotificationWriter, RpcHandler } from "../../rpc/types";
import {
  TERMINAL_SIDECAR_METHODS,
  type TerminalDataEvent,
} from "@lume/shared";
import {
  createDefaultTerminalServiceDeps,
  createTerminalService,
  type TerminalService,
} from "./terminal-service";

const createInputSchema = z
  .object({
    cwd: z.string().min(1).nullish(),
    cols: z.number().int().finite().optional(),
    rows: z.number().int().finite().optional(),
  })
  .optional();

const idSchema = z.object({ id: z.string().min(1) });
const writeInputSchema = idSchema.extend({ data: z.string() });
const resizeInputSchema = idSchema.extend({
  cols: z.number().int().finite(),
  rows: z.number().int().finite(),
});

export interface TerminalBridge {
  /** 方法名 → handler（Object.assign 进 createRpcHandlers 的 handlers 表）。 */
  handlers: Record<string, RpcHandler>;
  /** 优雅关停：回收全部 shell 会话。 */
  dispose(): void;
}

export function createTerminalBridge(input: { writeNotification: NotificationWriter }): TerminalBridge {
  const service: TerminalService = createTerminalService({
    ...createDefaultTerminalServiceDeps((event: TerminalDataEvent) => {
      input.writeNotification(TERMINAL_SIDECAR_METHODS.data, event);
    }),
  });

  const handlers: Record<string, RpcHandler> = {
    [TERMINAL_SIDECAR_METHODS.create]: async (params) => {
      const parsed = validateInput(createInputSchema, params ?? {}, TERMINAL_SIDECAR_METHODS.create);
      return service.create(parsed ?? {});
    },
    [TERMINAL_SIDECAR_METHODS.write]: async (params) => {
      const parsed = validateInput(writeInputSchema, params, TERMINAL_SIDECAR_METHODS.write);
      service.write(parsed.id, parsed.data);
      return { ok: true };
    },
    [TERMINAL_SIDECAR_METHODS.resize]: async (params) => {
      const parsed = validateInput(resizeInputSchema, params, TERMINAL_SIDECAR_METHODS.resize);
      service.resize(parsed.id, parsed.cols, parsed.rows);
      return { ok: true };
    },
    [TERMINAL_SIDECAR_METHODS.dispose]: async (params) => {
      const parsed = validateInput(idSchema, params, TERMINAL_SIDECAR_METHODS.dispose);
      service.dispose(parsed.id);
      return { ok: true };
    },
  };

  return {
    handlers,
    dispose: () => service.disposeAll(),
  };
}

/* ── 模块级单例（createRpcHandlers 装配 + index.ts 关停回收） ───────────── */

let activeBridge: TerminalBridge | null = null;

export function getTerminalBridgeHandlers(input: { writeNotification: NotificationWriter }): Record<string, RpcHandler> {
  if (!activeBridge) {
    activeBridge = createTerminalBridge(input);
  }
  return activeBridge.handlers;
}

export function disposeTerminalBridge(): void {
  activeBridge?.dispose();
  activeBridge = null;
}
