import { stdin, stdout } from "node:process";
import { MAX_RPC_MESSAGE_BYTES } from "@lume/shared";
import { createLogger } from "../services/infra/logger";

const log = createLogger("process-rpc-transport");

export { MAX_RPC_MESSAGE_BYTES };

interface ElectronParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  on(event: "disconnect", listener: () => void): void;
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
  /** 对端通道关闭（desktop 死亡/断连）；用于批量 reject in-flight 请求而非干等超时（#611） */
  onClose(listener: () => void): void;
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
      },
      onClose(listener) {
        parentPort.on("disconnect", listener);
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
    },
    onClose(listener) {
      const readableInput = input as unknown as {
        on(event: "close" | "end", listener: () => void): void;
      };
      readableInput.on("close", listener);
      readableInput.on("end", listener);
    }
  };
}

function getElectronParentPort(): ElectronParentPort | null {
  return (process as typeof process & { parentPort?: ElectronParentPort }).parentPort ?? null;
}
