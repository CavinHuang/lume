/**
 * IAB 命令协议版本闸(旧 C6 闸思路在新协议上的重实现,旧实现见
 * e5ec4503d assertIabProtocolCompatible)。
 *
 * desktop/sidecar 独立发版,版本错配时命令会静默命中未知方法/载荷。
 * 闸只对正向不相容证据行动:main 响应声明了协议范围且与 sidecar 构建期常量
 * (BROWSER_PROTOCOL_VERSION_MIN/MAX)不相容 → fail closed 抛 incompatible_protocol;
 * 未声明范围(旧版 main)→ 放行,真实命令以真实传输错误失败,不吞更有诊断价值的原始错误。
 */
import { BROWSER_PROTOCOL_VERSION_MAX, BROWSER_PROTOCOL_VERSION_MIN } from "@lume/shared";

export const BROWSER_PROTOCOL_INCOMPATIBLE = "incompatible_protocol";

/** main 响应可声明的协议范围字段(至少 protocolVersion;min/max 可选收窄)。 */
export interface BrowserPeerProtocol {
  protocolVersion?: unknown;
  minSupported?: unknown;
  maxSupported?: unknown;
}

export class BrowserProtocolGateError extends Error {
  readonly code = BROWSER_PROTOCOL_INCOMPATIBLE;

  constructor(message: string) {
    super(message);
    this.name = "BrowserProtocolGateError";
  }
}

function finiteVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 解析对端声明的支持范围;未声明任何范围时返回 null(放行)。
 * 只声明 protocolVersion 时按单点范围处理;声明 min/max 时按闭区间处理。
 */
export function parsePeerProtocolRange(peer: BrowserPeerProtocol): { min: number; max: number } | null {
  const declared = finiteVersion(peer.protocolVersion);
  const min = finiteVersion(peer.minSupported) ?? declared;
  const max = finiteVersion(peer.maxSupported) ?? declared;
  if (min === null || max === null) return null;
  return { min, max };
}

/** 纯判定:对端范围与本端支持范围是否不相容(未声明 → 相容/放行)。 */
export function isBrowserProtocolIncompatible(peer: BrowserPeerProtocol): boolean {
  const range = parsePeerProtocolRange(peer);
  if (!range) return false;
  return range.max < BROWSER_PROTOCOL_VERSION_MIN || range.min > BROWSER_PROTOCOL_VERSION_MAX;
}

/** fail closed:不相容时抛 incompatible_protocol,文案含双方范围便于诊断。 */
export function assertBrowserProtocolCompatible(peer: BrowserPeerProtocol): void {
  if (!isBrowserProtocolIncompatible(peer)) return;
  const range = parsePeerProtocolRange(peer);
  throw new BrowserProtocolGateError(
    `browser protocol mismatch: sidecar supports ${BROWSER_PROTOCOL_VERSION_MIN}..${BROWSER_PROTOCOL_VERSION_MAX},`
      + ` desktop declares ${range?.min}..${range?.max}`,
  );
}
