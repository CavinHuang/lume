/**
 * 浏览器工具注册门控(settings 驱动)。
 *
 * 从持久化 settings 的 `generalSettings.browser.agentToolsEnabled` 读取;
 * 缺省视为启用(本分支的目的就是把浏览器带回来),显式 false 关闭。
 * 读取走 shared GeneralSettings 的类型化字段,与设置持久化写入
 * (general-settings-service sanitize/update)保持同一形状。
 */
import type { GeneralSettings } from "@lume/shared";
import { readPersistedSettings } from "../../../system/settings-store";

export function isBrowserAgentToolsEnabled(): boolean {
  try {
    const store = readPersistedSettings() as { generalSettings?: GeneralSettings };
    return store.generalSettings?.browser?.agentToolsEnabled !== false;
  } catch {
    // 设置盘损坏时按启用处理:工具注册后调用会以 backend_unavailable 显式失败,
    // 不让持久化故障静默拔掉整个工具族。
    return true;
  }
}
