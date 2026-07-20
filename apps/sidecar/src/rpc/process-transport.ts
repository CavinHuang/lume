import { stdin, stdout } from "node:process";

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
      let buffer = "";
      const readableInput = input as unknown as {
        on(event: "data", listener: (chunk: Buffer | string) => void): void;
      };
      readableInput.on("data", (chunk) => {
        buffer += chunk.toString();
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
