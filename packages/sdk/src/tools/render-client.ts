// packages/sdk/src/tools/render-client.ts
/**
 * RenderClient — abstracts "render a URL and return its post-JS HTML".
 * SDK defines only the interface + a no-op default (headless fallback).
 * The real reverse-RPC implementation lives in apps/sidecar.
 */

export interface RenderOptions {
  timeoutMs?: number;
  waitForSelector?: string;
}

export interface RenderSuccess {
  ok: true;
  html: string;
  finalUrl: string;
  status?: number;
}

export interface RenderFailure {
  ok: false;
  error: { code: string; message: string };
}

export type RenderOutcome = RenderSuccess | RenderFailure;

export interface RenderClient {
  renderUrl(url: string, options?: RenderOptions): Promise<RenderOutcome>;
}

/** Default client used when no renderer is available (headless sidecar / CLI). */
export function createNoopRenderClient(): RenderClient {
  return {
    async renderUrl() {
      return {
        ok: false,
        error: {
          code: "render_unavailable",
          message: "Rendering is unavailable in this environment (desktop only).",
        },
      };
    },
  };
}
