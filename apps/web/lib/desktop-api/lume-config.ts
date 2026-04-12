import { LUME_CONFIG_IPC_CHANNELS } from "@lume/shared";
import type { LumeEffectiveConfig } from "@lume/shared";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onSidecarMethodEvent, sidecarCall } from "./core";

export async function getEffectiveLumeConfig(workspaceSlug?: string): Promise<LumeEffectiveConfig> {
  return sidecarCall<LumeEffectiveConfig>(LUME_CONFIG_IPC_CHANNELS.GET_EFFECTIVE, {
    ...(workspaceSlug ? { workspaceSlug } : {})
  });
}

export async function getLumeConfigSourcePath(): Promise<string> {
  const result = await sidecarCall<{ sourcePath: string }>(LUME_CONFIG_IPC_CHANNELS.GET_SOURCE_PATH);
  return result.sourcePath;
}

export async function openLumeConfigSourceFile(): Promise<{ ok: true }> {
  return sidecarCall<{ ok: true }>(LUME_CONFIG_IPC_CHANNELS.OPEN_SOURCE_FILE);
}

export async function onLumeConfigChanged(handler: () => void): Promise<UnlistenFn> {
  return onSidecarMethodEvent(LUME_CONFIG_IPC_CHANNELS.CHANGED, () => {
    handler();
  });
}
