import { argv, stdin, stdout } from "node:process";

type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id?: string | number;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

function writeResponse(response: JsonRpcResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

function handleRpcLine(line: string): void {
  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeResponse({
      error: { code: "E_BAD_JSON", message: "Invalid JSON payload." }
    });
    return;
  }

  if (payload.method === "healthcheck") {
    writeResponse({
      id: payload.id,
      result: {
        ok: true,
        source: "sidecar",
        pid: process.pid
      }
    });
    return;
  }

  writeResponse({
    id: payload.id,
    error: {
      code: "E_NOT_IMPLEMENTED",
      message: `Method not implemented: ${payload.method ?? "unknown"}`
    }
  });
}

function boot(): void {
  console.log(`[sidecar] booted (pid=${process.pid}) args=${argv.slice(2).join(" ")}`);
  stdin.setEncoding("utf8");

  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      handleRpcLine(trimmed);
    }
  });
}

boot();

