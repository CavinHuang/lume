"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HealthcheckResult } from "@lume/shared";

const SIDECAR_CALL_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export type SidecarNotification = {
  method: string;
  params: unknown;
};

export type SidecarMethod = string;

export async function desktopHealthcheck(): Promise<HealthcheckResult> {
  try {
    const result = await invoke<HealthcheckResult>("healthcheck");
    return result;
  } catch {
    return {
      ok: true,
      source: "web"
    };
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke("open_external", { url });
}

export async function sidecarHealthcheck(): Promise<HealthcheckResult> {
  try {
    const result = await invoke<HealthcheckResult>("sidecar_healthcheck");
    return result;
  } catch {
    return {
      ok: true,
      source: "web"
    };
  }
}

export async function sidecarCall<T>(method: string, params?: unknown): Promise<T> {
  const invokeOnce = (): Promise<T> =>
    withTimeout(
      invoke<T>("sidecar_call", {
        method,
        params: params ?? null
      }),
      SIDECAR_CALL_TIMEOUT_MS,
      `sidecar_call(${method})`
    );

  try {
    return await invokeOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = (
      message.includes("超时")
      || message.includes("sidecar is not running")
      || message.includes("sidecar stdin unavailable")
      || message.includes("response channel disconnected")
      || message.includes("write sidecar request failed")
      || message.toLowerCase().includes("broken pipe")
      || message.toLowerCase().includes("os error 32")
    );
    if (!shouldRetry) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return invokeOnce();
  }
}

export async function onSidecarEvent(
  handler: (event: SidecarNotification) => void
): Promise<UnlistenFn> {
  try {
    const rawUnlisten = await listen<SidecarNotification>("sidecar:event", (event) => {
      handler(event.payload);
    });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await rawUnlisten();
      } catch (error) {
        console.warn("[desktop-api] 重复注销 sidecar:event 监听器，已忽略:", error);
      }
    };
  } catch (error) {
    console.error("[desktop-api] 订阅 sidecar:event 失败:", error);
    return async () => {};
  }
}

export async function onSidecarMethodEvent(
  method: SidecarMethod,
  handler: (params: unknown) => void
): Promise<UnlistenFn> {
  return onSidecarEvent((event) => {
    if (event.method === method) {
      handler(event.params);
    }
  });
}
