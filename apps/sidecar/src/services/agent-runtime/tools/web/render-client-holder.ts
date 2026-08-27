// apps/sidecar/src/services/agent-runtime/tools/web/render-client-holder.ts
/**
 * Process-wide holder for the sidecar's RenderClient singleton.
 *
 * The renderClient is created once in apps/sidecar/src/index.ts and must reach
 * two consumers:
 *   1. createRpcHandlers (render:result handler resolves pending renders)
 *   2. createSdkWebTools (enhanced WebFetch uses it for JS-rendered pages)
 *
 * Consumer (2) sits deep in the runtime call chain
 * (index → rpc → runAgentRuntime → runRuntimeCoreAttempt → LumeRunner →
 * createRuntimeCoreSession → buildRuntimeCoreTools → createSdkWebTools).
 * Threading a process-global dependency through every one of those param types
 * would be a large, invasive change for no gain. Instead we expose it via this
 * holder — the same pattern the codebase uses for other process singletons
 * (getOutboundNotificationWriter, getAgentRuntimeStatusManager, ...).
 *
 * The default is the SDK's no-op client, so headless sidecar / CLI / tests keep
 * working unchanged (render falls back to static fetch).
 */
import { createNoopRenderClient, type RenderClient } from "@lume/agent-sdk";

let current: RenderClient = createNoopRenderClient();

/** Install the process-wide renderClient. Pass undefined to reset to noop. */
export function setSidecarRenderClient(client: RenderClient | undefined): void {
  current = client ?? createNoopRenderClient();
}

/** Read the process-wide renderClient (noop when none has been installed). */
export function getSidecarRenderClient(): RenderClient {
  return current;
}
