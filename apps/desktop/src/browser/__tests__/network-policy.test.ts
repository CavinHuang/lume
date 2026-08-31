/**
 * 网络策略单测(ZCode JSe/VSe/YSe/QSe/G6/XSe/qSe/V6):代理配置构造、
 * PEM 指纹提取、证书链匹配、校验 proc 三分支、双 session 并发应用。
 */
import { describe, expect, test } from 'bun:test'

import {
  applyDesktopChromiumNetworkPolicies,
  applyDesktopSessionNetworkPolicy,
  buildElectronProxyConfig,
  certificateChainMatchesCustomCa,
  createCustomCaCertificateVerifyProc,
  createCustomCaCertificateVerifyProcFromFile,
  createInsecureCertificateVerifyProc,
  readCustomCaFingerprintsFromPem,
  readDesktopNetworkConfigFromEnv,
} from '../network-policy'

/** 自签测试证书(本地 openssl 生成,2 天有效期,仅夹具用)。 */
const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUS073LyMPeXMVfcSsCt4clvJss38wDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMbHVtZS10ZXN0LWNhMB4XDTI2MDgzMTA1MDUwOVoXDTI2
MDkwMjA1MDUwOVowFzEVMBMGA1UEAwwMbHVtZS10ZXN0LWNhMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyhCOG4sXsINSIcmO7kKfZ7T4kt18DKkfU0fX
PVDg5EFk1+TYsUmfAYt13MhX4wxvfl8G1t2YijUHLnHZUpU0Z4B1XGRlo8VaynvS
ST3LlneRZ1o9jKW1Qarl/ZVlIntCWvWVay5cIgo9lOroWzFFdDd2uTS4Y42qK0Od
T0mJKzRMWJD4v39ZjuIfeK3o6oZY+aaSJPHfrKPPO3pyfQYpjLGdlYi2PdODv6Me
J0nbU4o9I1B1EmNVUkbaP7jY1Jb/yYAjNiCqcrXH6R6p69R2H9nxg7+zHmEajnJe
ZBcKrKjcqj8JlDxpuTtcc0fGM07H6bFxI0233ldXt+9xUH9X+wIDAQABo1MwUTAd
BgNVHQ4EFgQU0r20J5N4Wv9h8eBIY+eq4dFBpc0wHwYDVR0jBBgwFoAU0r20J5N4
Wv9h8eBIY+eq4dFBpc0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAyQOLsH8/pQUhBXXPCjyL3NsFk2zUusw+pV3tC+HUza3r9Cuo/gNZiDuO+rMw
Xd/r0jxKzVnH49iD46/g9EF020xuG2CRW8wY/Izpxsj27W/bbqX3rxDFBMegQnsW
j5XpKKtmB7UGyqwYoYaLTHHavZnZFOeD/kXLbmBr2/DPeN87IvvIqjenz+Bp2n9G
9O0aNtEPuTN8+/AI0A8wta+h82YQ0+a2OyEXJ6sf8mLUr2A2b2/b1Q+VzSmYa1DS
BGH1PJgCWxgkVJFHhVseyELClKaAjHZ+1nag7fnCxkKT5A5je9+2fW4jmq6t5CXp
D1eQ12JfC6/1WFLUP91vHZZ56A==
-----END CERTIFICATE-----`

describe('buildElectronProxyConfig', () => {
  test('no proxy falls back to the given mode', () => {
    expect(buildElectronProxyConfig(undefined, undefined)).toEqual({ mode: 'direct' })
    expect(buildElectronProxyConfig('  ', undefined, 'system')).toEqual({ mode: 'system' })
  })

  test('fixed_servers with optional bypass rules', () => {
    expect(buildElectronProxyConfig(' http://127.0.0.1:7890 ', ' localhost, .internal ', 'direct')).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: 'localhost, .internal',
    })
  })
})

describe('custom CA verify proc', () => {
  test('pem without certificates yields null proc (default verification)', () => {
    expect(createCustomCaCertificateVerifyProcFromFile(undefined, console)).toBeNull()
    expect(createCustomCaCertificateVerifyProcFromFile('   ', console)).toBeNull()
  })

  test('insecure proc accepts everything', () => {
    let result: number | null = null
    createInsecureCertificateVerifyProc()({ verificationResult: 'ERR', certificate: { fingerprint256: 'AA' } }, (value) => {
      result = value
    })
    expect(result).toBe(0)
  })

  test('verify proc: OK → default(-3); chain match → accept(0); mismatch → default(-3)', () => {
    // 结构桩:链 a → b;指纹集含 b 的指纹
    const certB = { fingerprint256: 'BB:BB' }
    const certA = { fingerprint256: 'AA:AA', issuerCert: certB }
    const fingerprints = new Set(['bbbb'])

    const proc = createCustomCaCertificateVerifyProc(fingerprints)!
    const run = (request: Parameters<typeof proc>[0]) => {
      let result: number | null = null
      proc(request, (value) => { result = value })
      return result
    }

    expect(run({ verificationResult: 'OK', certificate: certA })).toBe(-3)
    expect(run({ verificationResult: 'ERR_CERT', certificate: certA })).toBe(0)
    expect(run({ verificationResult: 'ERR_CERT', certificate: { fingerprint256: 'ZZ', issuerCert: { fingerprint256: 'NOPE' } } })).toBe(-3)
  })

  test('certificateChainMatchesCustomCa walks the chain with depth and cycle guards', () => {
    const fingerprints = new Set(['cc'])
    const self = { fingerprint256: 'SELF' } as { fingerprint256: string; issuerCert?: unknown }
    self.issuerCert = self // 环
    expect(certificateChainMatchesCustomCa(self as never, fingerprints)).toBe(false)

    const leaf = { fingerprint256: 'AA', issuerCert: { fingerprint256: 'BB', issuerCert: { fingerprint256: 'CC' } } }
    expect(certificateChainMatchesCustomCa(leaf as never, fingerprints)).toBe(true)
    expect(certificateChainMatchesCustomCa({ fingerprint256: 'DD' } as never, fingerprints)).toBe(false)
  })
})

describe('applyDesktopSessionNetworkPolicy', () => {
  test('applies proxy, closes connections, and installs the verify proc', async () => {
    const calls: string[] = []
    const session = {
      setProxy: async (config: unknown) => { calls.push(`proxy:${JSON.stringify(config)}`) },
      closeAllConnections: async () => { calls.push('close') },
      setCertificateVerifyProc: (proc: unknown) => { calls.push(`verify:${typeof proc}`) },
    }
    await applyDesktopSessionNetworkPolicy(session, { httpProxy: 'http://p:1' }, console, { fallbackProxyMode: 'system' })
    // 无 CA 文件且未开 insecure:proc 为 null → Electron 回默认校验(ZCode XSe null 同)
    expect(calls).toEqual([
      'proxy:{"mode":"fixed_servers","proxyRules":"http://p:1"}',
      'close',
      'verify:object',
    ])

    calls.length = 0
    await applyDesktopSessionNetworkPolicy(session, {}, console, { allowInsecureCertificates: true })
    expect(calls[2]).toBe('verify:function')
  })
})

describe('applyDesktopChromiumNetworkPolicies', () => {
  test('applies to both sessions with per-target insecure/fallback policy', async () => {
    const seen: Array<{ mode: string; insecure: boolean }> = []
    const makeSession = (tag: string) => ({
      setProxy: async () => { seen.push({ mode: tag, insecure: false }); void 0 },
      closeAllConnections: async () => {},
      setCertificateVerifyProc: () => {},
    })
    const partitions: string[] = []
    await applyDesktopChromiumNetworkPolicies(
      {
        defaultSession: makeSession('default'),
        fromPartition: (partition: string) => { partitions.push(partition); return makeSession(partition) },
      },
      { embeddedBrowserAllowInsecureCertificates: true },
      console,
      'persist:lume-browser',
    )
    expect(partitions).toEqual(['persist:lume-browser'])
    expect(seen.map((entry) => entry.mode).sort()).toEqual(['default', 'persist:lume-browser'].sort())
  })
})

describe('readDesktopNetworkConfigFromEnv', () => {
  test('maps standard proxy vars and lume CA/insecure flags', () => {
    const config = readDesktopNetworkConfigFromEnv({
      HTTPS_PROXY: 'http://p:2',
      NO_PROXY: 'localhost',
      LUME_BROWSER_CA_CERT_PATH: 'D:/ca.pem',
      LUME_BROWSER_ALLOW_INSECURE_CERTIFICATES: 'true',
    })
    expect(config.httpProxy).toBe('http://p:2')
    expect(config.httpProxyNoProxy).toBe('localhost')
    expect(config.httpProxyCaCertPath).toBe('D:/ca.pem')
    expect(config.embeddedBrowserAllowInsecureCertificates).toBe(true)
    expect(readDesktopNetworkConfigFromEnv({}).embeddedBrowserAllowInsecureCertificates).toBe(false)
  })
})
