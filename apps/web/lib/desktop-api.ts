"use client";

import type { HealthcheckResult } from "@lume/shared";
import { invoke } from "@tauri-apps/api/core";

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

