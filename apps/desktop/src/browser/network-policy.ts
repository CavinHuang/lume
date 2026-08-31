/**
 * 桌面会话网络策略 —— ZCode V6/qSe/JSe/VSe/XSe/YSe/QSe/G6
 * (提取源 06-ipc-and-wiring.source.js)。
 *
 * 对 default-session 与 embedded-browser(persist 分区)并发应用:
 * setProxy(fixed_servers / 兜底 direct|system)+ closeAllConnections +
 * setCertificateVerifyProc(不安全证书放行 / 自定义 CA 文件指纹匹配,链深 16;
 * verificationResult OK 或不匹配时回默认校验 -3,指纹命中放行 0)。
 *
 * 配置来源偏差:ZCode 读桌面配置(httpProxy/httpProxyNoProxy/httpProxyCaCertPath/
 * embeddedBrowserAllowInsecureCertificates);Lume 尚无该设置面,由环境变量驱动
 * (HTTPS_PROXY|HTTP_PROXY / NO_PROXY / LUME_BROWSER_CA_CERT_PATH /
 * LUME_BROWSER_ALLOW_INSECURE_CERTIFICATES)。
 * 代理规则/绕过规整器的原始实现(eCe/tCe)未能恢复,以 trim 直传等价替代
 * (Electron 本身接受逗号/分号多代理与绕过列表)。
 */
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

/* ── 结构面(免 electron 类型依赖,测试可桩) ─────────────────────────── */

export interface ElectronProxyConfig {
  mode: "direct" | "fixed_servers" | "system"
  proxyRules?: string
  proxyBypassRules?: string
}

export interface DesktopNetworkConfig {
  httpProxy?: string
  httpProxyNoProxy?: string
  httpProxyCaCertPath?: string
  embeddedBrowserAllowInsecureCertificates?: boolean
}

/** 证书链节点(Electron ChainableCertificate 最小面)。 */
export interface ChainCertificate {
  /** Electron Certificate 实际恒有;结构面放宽为可选以接受其 proc 请求类型。 */
  fingerprint256?: string
  issuerCert?: ChainCertificate
}

export interface CertificateVerifyProcRequest {
  verificationResult?: string
  certificate: ChainCertificate
  validatedCertificate?: ChainCertificate
}

export type CertificateVerifyProc = (
  request: CertificateVerifyProcRequest,
  callback: (result: number) => void,
) => void

export interface SessionNetworkPolicyTarget {
  setProxy(config: ElectronProxyConfig): Promise<void>
  closeAllConnections(): Promise<void>
  setCertificateVerifyProc(proc: CertificateVerifyProc | null): void
}

export type DesktopNetworkLogger = {
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
}

/** ZCode 常量 KSe/H6/q6:CA 链深 16 / 回默认校验 -3 / 放行 0。 */
const CERT_CHAIN_MAX_DEPTH = 16
const VERIFY_PROC_USE_DEFAULT = -3
const VERIFY_PROC_ACCEPT = 0

/* ── 代理(ZCode JSe/eCe/tCe) ───────────────────────────────────────── */

/** 规整单条代理值:trim 后非空返回,否则 null(直传 Electron 规则语法)。 */
function normalizeProxyValue(value: string | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.length > 0 ? trimmed : null
}

export function buildElectronProxyConfig(
  httpProxy: string | undefined,
  httpProxyNoProxy: string | undefined,
  fallbackProxyMode: "direct" | "system" = "direct",
): ElectronProxyConfig {
  const rules = normalizeProxyValue(httpProxy)
  if (!rules) return { mode: fallbackProxyMode }
  const config: ElectronProxyConfig = { mode: "fixed_servers", proxyRules: rules }
  const bypass = normalizeProxyValue(httpProxyNoProxy)
  if (bypass) config.proxyBypassRules = bypass
  return config
}

/* ── 自定义 CA(ZCode QSe/G6/YSe/XSe/VSe) ──────────────────────────── */

/** ZCode jD 等效:指纹去冒号统一形态。 */
function normalizeFingerprint(fingerprint256: string | undefined): string {
  return typeof fingerprint256 === "string" ? fingerprint256.replace(/:/g, "").toLowerCase() : ""
}

/** ZCode QSe:PEM 文本 → SHA-256 指纹集(去冒号小写)。 */
export function readCustomCaFingerprintsFromPem(pem: string): Set<string> {
  const fingerprints = new Set<string>()
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  for (const block of blocks) {
    fingerprints.add(normalizeFingerprint(new X509Certificate(block).fingerprint256))
  }
  return fingerprints
}

/** ZCode G6:沿 issuerCert 链上溯(≤16 深度,环路截断)匹配指纹集。 */
export function certificateChainMatchesCustomCa(
  certificate: ChainCertificate,
  fingerprints: ReadonlySet<string>,
): boolean {
  let current: ChainCertificate | undefined = certificate
  const seen = new Set<string>()
  for (let depth = 0; current && depth < CERT_CHAIN_MAX_DEPTH; depth += 1) {
    const fingerprint = normalizeFingerprint(current.fingerprint256)
    if (fingerprint && fingerprints.has(fingerprint)) return true
    if (!fingerprint || seen.has(fingerprint)) return false
    seen.add(fingerprint)
    current = current.issuerCert
  }
  return false
}

/** ZCode YSe:校验 proc——OK/不匹配回默认(-3),自定义 CA 命中放行(0)。 */
export function createCustomCaCertificateVerifyProc(fingerprints: ReadonlySet<string>): CertificateVerifyProc | null {
  if (fingerprints.size === 0) return null
  return (request, callback) => {
    if (request.verificationResult === "OK") {
      callback(VERIFY_PROC_USE_DEFAULT)
      return
    }
    if (
      certificateChainMatchesCustomCa(request.certificate, fingerprints)
      || (request.validatedCertificate && certificateChainMatchesCustomCa(request.validatedCertificate, fingerprints))
    ) {
      callback(VERIFY_PROC_ACCEPT)
      return
    }
    callback(VERIFY_PROC_USE_DEFAULT)
  }
}

/** ZCode VSe:不安全证书全放行。 */
export function createInsecureCertificateVerifyProc(): CertificateVerifyProc {
  return (_request, callback) => {
    callback(VERIFY_PROC_ACCEPT)
  }
}

/** ZCode XSe:CA 文件 → 校验 proc;无证书告警并返回 null(回默认校验)。 */
export function createCustomCaCertificateVerifyProcFromFile(
  caCertPath: string | undefined,
  logger: DesktopNetworkLogger,
): CertificateVerifyProc | null {
  const trimmed = typeof caCertPath === "string" ? caCertPath.trim() : ""
  if (!trimmed) return null
  try {
    const fingerprints = readCustomCaFingerprintsFromPem(readFileSync(trimmed, "utf8"))
    if (fingerprints.size === 0) {
      logger.warn(`[desktop-network] custom CA file contains no certificates: ${trimmed}`)
      return null
    }
    return createCustomCaCertificateVerifyProc(fingerprints)
  } catch (error) {
    logger.warn(`[desktop-network] failed to load custom CA file: ${trimmed}`, error)
    return null
  }
}

/* ── 会话应用(ZCode qSe/V6) ───────────────────────────────────────── */

/**
 * ZCode qSe:setProxy → closeAllConnections → setCertificateVerifyProc
 * (insecure 优先;否则 CA 文件 proc,可能为 null 即回默认校验)。
 */
export async function applyDesktopSessionNetworkPolicy(
  session: SessionNetworkPolicyTarget,
  config: DesktopNetworkConfig,
  logger: DesktopNetworkLogger,
  options: { allowInsecureCertificates?: boolean; fallbackProxyMode?: "direct" | "system" } = {},
): Promise<void> {
  const proxyConfig = buildElectronProxyConfig(
    config.httpProxy,
    config.httpProxyNoProxy,
    options.fallbackProxyMode ?? "direct",
  )
  await session.setProxy(proxyConfig)
  await session.closeAllConnections()
  const verifyProc = options.allowInsecureCertificates
    ? createInsecureCertificateVerifyProc()
    : createCustomCaCertificateVerifyProcFromFile(config.httpProxyCaCertPath, logger)
  session.setCertificateVerifyProc(verifyProc)
  const bypassState = proxyConfig.proxyBypassRules ? "enabled" : "disabled"
  const caState = verifyProc ? "enabled" : "disabled"
  logger.info(
    `[desktop-network] proxy mode=${proxyConfig.mode} bypass=${bypassState} customCa=${caState} insecureCerts=${options.allowInsecureCertificates ? "allowed" : "rejected"}`,
  )
}

/**
 * ZCode V6:default-session(allowInsecure=false,兜底 direct)与
 * embedded-browser 分区(allowInsecure 按配置,兜底 system)并发应用。
 */
export async function applyDesktopChromiumNetworkPolicies(
  sessions: { defaultSession: SessionNetworkPolicyTarget; fromPartition: (partition: string) => SessionNetworkPolicyTarget },
  config: DesktopNetworkConfig,
  logger: DesktopNetworkLogger,
  embeddedBrowserPartition: string,
): Promise<void> {
  const targets: Array<{ name: string; session: SessionNetworkPolicyTarget; allowInsecure: boolean; fallbackProxyMode: "direct" | "system" }> = [
    { name: "default-session", session: sessions.defaultSession, allowInsecure: false, fallbackProxyMode: "direct" },
    { name: "embedded-browser", session: sessions.fromPartition(embeddedBrowserPartition), allowInsecure: config.embeddedBrowserAllowInsecureCertificates === true, fallbackProxyMode: "system" },
  ]
  await Promise.all(targets.map(async (target) => {
    try {
      await applyDesktopSessionNetworkPolicy(target.session, config, logger, {
        allowInsecureCertificates: target.allowInsecure,
        fallbackProxyMode: target.fallbackProxyMode,
      })
    } catch (error) {
      logger.warn(`[desktop-network] ${target.name} network policy apply failed`, error)
    }
  }))
}

/** Lume 附加:环境变量 → 配置(HTTPS_PROXY 优先于 HTTP_PROXY)。 */
export function readDesktopNetworkConfigFromEnv(env: NodeJS.ProcessEnv): DesktopNetworkConfig {
  const config: DesktopNetworkConfig = {
    httpProxy: env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy,
    httpProxyNoProxy: env.NO_PROXY ?? env.no_proxy,
    httpProxyCaCertPath: env.LUME_BROWSER_CA_CERT_PATH,
    embeddedBrowserAllowInsecureCertificates: ["1", "true", "yes"].includes((env.LUME_BROWSER_ALLOW_INSECURE_CERTIFICATES ?? "").toLowerCase()),
  }
  return config
}
