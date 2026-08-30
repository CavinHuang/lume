/**
 * 浏览器工具注册门控(settings 驱动,重写期最小实现)。
 *
 * 从持久化 settings 的 `generalSettings.browser.agentToolsEnabled` 读取;
 * 缺省视为启用(本分支的目的就是把浏览器带回来),显式 false 关闭。
 * 布尔字段不存在时静默降级,避免在 shared GeneralSettings 类型上制造
 * 跨代理冲突——后续设置页接入时再补类型化字段。
 */
import { readPersistedSettings } from "../../../system/settings-store";

export function isBrowserAgentToolsEnabled(): boolean {
  try {
    const store = readPersistedSettings() as { generalSettings?: { browser?: { agentToolsEnabled?: unknown } } };
    return store.generalSettings?.browser?.agentToolsEnabled !== false;
  } catch {
    // 设置盘损坏时按启用处理:工具注册后调用会以 backend_unavailable 显式失败,
    // 不让持久化故障静默拔掉整个工具族。
    return true;
  }
}
