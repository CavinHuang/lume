import type { AgentProxyMode } from "@lume/shared";

// #578:infra 不得上行依赖 system 域(proxy-fetch 曾直接 import
// proxy-settings-manager 形成基础设施→设置域倒挂)。照 browser-broker-holder
// 惯用法:配置读取器由组合根(sidecar 启动序列)注入,本模块保持中立。

export interface ActiveProxyConfig {
  mode: AgentProxyMode;
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

let proxyConfigProvider: (() => ActiveProxyConfig) | null = null;

export function setProxyConfigProvider(provider: () => ActiveProxyConfig): void {
  proxyConfigProvider = provider;
}

/** 未注入时返回关闭态——组合根装配前的调用面(fetchWithProxy)安全降级直连。 */
export function getActiveProxyConfig(): ActiveProxyConfig {
  return proxyConfigProvider?.() ?? { mode: "off", enabled: false };
}
