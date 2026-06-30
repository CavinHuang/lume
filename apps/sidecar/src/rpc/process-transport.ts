import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

interface ElectronParentPort {
  on(event: "message", listener: (event: { data?: unknown }) => void): void;
  postMessage(message: string): void;
}

interface ProcessRpcTransportOptions {
  input?: NodeJS.ReadableStream;
  output?: Pick<NodeJS.WritableStream, "write">;
  parentPort?: ElectronParentPort | null;
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

  if (parentPort) {
    return {
      listen(listener) {
        parentPort.on("message", (event) => {
          if (typeof event.data === "string") listener(event.data);
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
      const lines = createInterface({ input, crlfDelay: Infinity });
      lines.on("line", listener);
    },
    send(message) {
      output.write(`${message}\n`);
    }
  };
}

function getElectronParentPort(): ElectronParentPort | null {
  return (process as typeof process & { parentPort?: ElectronParentPort }).parentPort ?? null;
}
