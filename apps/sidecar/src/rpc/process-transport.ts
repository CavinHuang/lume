import { stdin, stdout } from "node:process";
import { createLogger } from "../services/infra/logger";

const log = createLogger("process-rpc-transport");

/**
 * 单条 RPC 消息上限。合法最大 payload = 批量附件 50MB 原始 → ~66.7MB base64 + JSON 壳 ≈ 68MB，
 * 取 96MB 留余量；防畸形渲染层用超大行在 JSON.parse 前打爆内存（OOM 崩进程，全部会话随进程丢失）。
 */
export const MAX_RPC_MESSAGE_BYTES = 96 * 1024 * 1024;

interface ElectronParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: string): void;
}

interface ProcessRpcTransportOptions {
  input?: NodeJS.ReadableStream;
  output?: Pick<NodeJS.WritableStream, "write">;
  parentPort?: ElectronParentPort | null;
  /** 单条消息上限，默认 MAX_RPC_MESSAGE_BYTES；测试注入小值。 */
  maxMessageBytes?: number;
}

export interface ProcessRpcTransport {
  listen(listener: (message: string) => void): void;
  send(message: string): void;
}

export function createProcessRpcTransport(
  options: ProcessRpcTransportOptions = {}
): ProcessRpcTransport {
  const parentPort = options.parentPort === undefined
    ? getElectronParentPort()
    : options.parentPort;
  const maxMessageBytes = options.maxMessageBytes ?? MAX_RPC_MESSAGE_BYTES;

  if (parentPort) {
    return {
      listen(listener) {
        parentPort.on("message", (event) => {
          if (typeof event.data !== "string") return;
          if (event.data.length > maxMessageBytes) {
            log.error("RPC 消息超过大小上限，已丢弃", { bytes: event.data.length });
            return;
          }
          listener(event.data);
        });
      },
      send(message) {
        parentPort.postMessage(message);
      }
    };
  }

  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  return {
    listen(listener) {
      let buffer = "";
      let dropped = false;
      const readableInput = input as unknown as {
        on(event: "data", listener: (chunk: Buffer | string) => void): void;
        destroy?: (error?: Error) => void;
      };
      readableInput.on("data", (chunk) => {
        if (dropped) return;
        buffer += chunk.toString();
        // 单行超限：继续缓冲只会放大内存占用，直接断开输入流（无参 destroy 避免 error 事件逃逸）
        if (buffer.length > maxMessageBytes) {
          dropped = true;
          buffer = "";
          log.error("RPC 行超过大小上限，断开输入流", { limitBytes: maxMessageBytes });
          readableInput.destroy?.();
          return;
        }
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          listener(line);
        }
      });
    },
    send(message) {
      output.write(`${message}\n`);
    }
  };
}

function getElectronParentPort(): ElectronParentPort | null {
  return (process as typeof process & { parentPort?: ElectronParentPort }).parentPort ?? null;
}
