// apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.ts
import type { RenderClient, RenderOutcome, RenderOptions } from "@lume/agent-sdk";

const RENDER_REQUEST = "render:request";

interface Pending {
  resolve: (v: RenderOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReverseRpcRenderClient extends RenderClient {
  handleRenderResult(params: {
    reqId: string;
    html?: string;
    finalUrl?: string;
    status?: number;
    error?: { code: string; message: string };
  }): void;
}

export function createReverseRpcRenderClient(opts: {
  sendNotification: (method: string, params: unknown) => void;
  timeoutMs?: number;
}): ReverseRpcRenderClient {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const pending = new Map<string, Pending>();
  let counter = 0;

  function renderUrl(url: string, options?: RenderOptions): Promise<RenderOutcome> {
    const reqId = `r${Date.now()}-${counter++}`;
    return new Promise<RenderOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(reqId)) {
          resolve({ ok: false, error: { code: "render_timeout", message: `render timed out after ${timeoutMs}ms` } });
        }
      }, options?.timeoutMs ?? timeoutMs);
      pending.set(reqId, { resolve, timer });
      opts.sendNotification(RENDER_REQUEST, { reqId, url, options: options ?? {} });
    });
  }

  function handleRenderResult(params: {
    reqId: string; html?: string; finalUrl?: string; status?: number;
    error?: { code: string; message: string };
  }): void {
    const entry = pending.get(params.reqId);
    if (!entry) return;
    pending.delete(params.reqId);
    clearTimeout(entry.timer);
    if (params.error) {
      entry.resolve({ ok: false, error: params.error });
    } else {
      entry.resolve({ ok: true, html: params.html ?? "", finalUrl: params.finalUrl ?? "", status: params.status });
    }
  }

  return { renderUrl, handleRenderResult };
}
