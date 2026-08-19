import { lookup as dnsLookup } from "node:dns/promises"
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http"
import { request as httpsRequest } from "node:https"
import { connect as connectSocket, isIP } from "node:net"
import type { Duplex } from "node:stream"
import { connect as connectTls } from "node:tls"

type LookupResult = { address: string; family: number }
type Lookup = (hostname: string) => Promise<LookupResult[]>

export type BrowserNetworkGuardOptions = {
  allowPrivateOrigin?: (origin: string) => boolean
  lookup?: Lookup
  resolveProxy?: (url: string) => Promise<string>
}

type ProxyRoute =
  | { kind: "direct" }
  | { kind: "proxy"; host: string; port: number; secure: boolean }

export class BrowserNetworkGuard {
  private server: Server | null = null
  private port = 0
  private readonly lookup: Lookup

  constructor(private readonly options: BrowserNetworkGuardOptions = {}) {
    this.lookup = options.lookup ?? (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }))
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((request, response) => {
      void this.forwardHttp(request).then((upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers)
        upstream.pipe(response)
      }).catch(() => {
        if (!response.headersSent) response.writeHead(403, { "content-type": "text/plain" })
        response.end("blocked by Lume browser network policy")
      })
    })
    server.on("connect", (request, client, head) => { void this.forwardConnect(request.url ?? "", client, head) })
    server.on("clientError", (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === "string") { server.close(); throw new Error("browser_network_guard_unavailable") }
    this.server = server
    this.port = address.port
  }

  proxyRules(): string {
    if (!this.server || !this.port) throw new Error("browser_network_guard_unavailable")
    return `http=127.0.0.1:${this.port};https=127.0.0.1:${this.port};ws=127.0.0.1:${this.port};wss=127.0.0.1:${this.port}`
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async forwardHttp(request: IncomingMessage): Promise<IncomingMessage> {
    const url = new URL(request.url ?? "")
    if (url.protocol !== "http:") throw new Error("browser_network_blocked")
    const route = await this.resolveRoute(url)
    const target = await resolveGuardTarget(url.hostname, Number(url.port || 80), url.protocol, this.lookup, this.options.allowPrivateOrigin, route.kind === "proxy")
    const forwardedHeaders = { ...request.headers, host: url.host }
    delete forwardedHeaders["proxy-connection"]
    return new Promise<IncomingMessage>((resolve, reject) => {
      const requestUpstream = route.kind === "proxy" && route.secure ? httpsRequest : httpRequest
      const upstream = requestUpstream({
        host: route.kind === "proxy" ? route.host : target.address,
        ...(route.kind === "direct" ? { family: target.family } : {}),
        port: route.kind === "proxy" ? route.port : target.port,
        method: request.method ?? "GET",
        path: route.kind === "proxy" ? url.toString() : `${url.pathname}${url.search}`,
        headers: forwardedHeaders,
      }, resolve)
      upstream.once("error", reject)
      request.pipe(upstream)
    })
  }

  private async forwardConnect(authority: string, client: Duplex, head: Buffer): Promise<void> {
    try {
      const parsed = new URL(`https://${authority}`)
      const port = Number(parsed.port || 443)
      const route = await this.resolveRoute(parsed)
      const target = await resolveGuardTarget(parsed.hostname, port, "https:", this.lookup, this.options.allowPrivateOrigin, route.kind === "proxy")
      if (route.kind === "proxy") {
        await connectThroughProxy(route, authority, client, head)
        return
      }
      const upstream = connectSocket({ host: target.address, family: target.family as 4 | 6, port })
      upstream.setTimeout(30_000, () => upstream.destroy())
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Lume\r\n\r\n")
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.once("error", () => client.destroy())
      client.once("error", () => upstream.destroy())
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
    }
  }

  private async resolveRoute(url: URL): Promise<ProxyRoute> {
    if (!this.options.resolveProxy) return { kind: "direct" }
    return parseProxyRoute(await this.options.resolveProxy(url.toString()))
  }
}

export async function resolveGuardTarget(hostname: string, port: number, scheme: "http:" | "https:", lookup: Lookup, allowPrivateOrigin?: (origin: string) => boolean, allowProxyFakeAddress = false): Promise<{ address: string; family: number; port: number }> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("browser_network_blocked")
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const literalFamily = isIP(normalized)
  const origin = new URL(`${scheme}//${formatHost(normalized)}:${port}`).origin
  if (literalFamily && !isPublicAddress(normalized)) {
    if (!allowPrivateOrigin?.(origin)) throw new Error("private_origin_confirmation_required")
    return { address: normalized, family: literalFamily, port }
  }
  const results = literalFamily ? [{ address: normalized, family: literalFamily }] : await lookup(normalized)
  if (!results.length) throw new Error("browser_network_blocked")
  const hasPrivateAddress = results.some((result) => !isPublicAddress(result.address) && !(allowProxyFakeAddress && isProxyFakeAddress(result.address)))
  if (hasPrivateAddress && (!results.every((result) => !isPublicAddress(result.address)) || !allowPrivateOrigin?.(origin))) throw new Error("browser_network_blocked")
  return { address: results[0].address, family: results[0].family, port }
}

export function parseProxyRoute(value: string): ProxyRoute {
  for (const directive of value.split(";")) {
    const [kind = "", authority = ""] = directive.trim().split(/\s+/, 2)
    if (kind.toUpperCase() === "DIRECT") return { kind: "direct" }
    if (!["PROXY", "HTTP", "HTTPS"].includes(kind.toUpperCase()) || !authority) continue
    try {
      const parsed = new URL(`http://${authority}`)
      const port = Number(parsed.port)
      if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) continue
      return { kind: "proxy", host: parsed.hostname, port, secure: kind.toUpperCase() === "HTTPS" }
    } catch { /* try the next proxy directive */ }
  }
  return { kind: "direct" }
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "")
  const family = isIP(normalized)
  if (family === 4) {
    const [a, b, c] = normalized.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && (b === 0 || b === 168)) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (family !== 6) return false
  const groups = parseIpv6Groups(normalized)
  if (!groups) return false
  if (groups.every((group) => group === 0)) return false
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false
  if ((groups[0] & 0xfe00) === 0xfc00) return false
  if ((groups[0] & 0xffc0) === 0xfe80) return false
  if ((groups[0] & 0xff00) === 0xff00) return false
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false
  const embeddedIpv4 = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
    || (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 5).every((group) => group === 0))
  if (!embeddedIpv4) return true
  return isPublicAddress(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`)
}

function parseIpv6Groups(host: string): number[] | null {
  const halves = host.split("::")
  if (halves.length > 2) return null
  const groups: number[] = []
  for (let half = 0; half < halves.length; half++) {
    const parts = halves[half] ? halves[half].split(":") : []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (half === halves.length - 1 && index === parts.length - 1 && part.includes(".")) {
        if (isIP(part) !== 4) return null
        const [a, b, c, d] = part.split(".").map(Number)
        groups.push((a << 8) | b, (c << 8) | d)
      } else if (/^[0-9a-f]{1,4}$/.test(part)) groups.push(parseInt(part, 16))
      else return null
    }
  }
  const missing = 8 - groups.length
  if (halves.length === 1) return missing === 0 ? groups : null
  if (missing < 1) return null
  groups.splice(halves[0] ? halves[0].split(":").length : 0, 0, ...Array.from({ length: missing }, () => 0))
  return groups
}

function isProxyFakeAddress(address: string): boolean {
  const [a, b] = address.split(".").map(Number)
  return isIP(address) === 4 && a === 198 && (b === 18 || b === 19)
}

function connectThroughProxy(route: Extract<ProxyRoute, { kind: "proxy" }>, authority: string, client: Duplex, head: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const upstream = route.secure
      ? connectTls({ host: route.host, port: route.port, servername: isIP(route.host) ? undefined : route.host })
      : connectSocket({ host: route.host, port: route.port })
    let response = Buffer.alloc(0)
    const fail = (error: Error) => {
      upstream.destroy()
      reject(error)
    }
    upstream.setTimeout(30_000, () => fail(new Error("browser_proxy_timeout")))
    upstream.once("error", fail)
    upstream.once(route.secure ? "secureConnect" : "connect", () => {
      upstream.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n`)
    })
    upstream.on("data", function onData(chunk: Buffer) {
      response = Buffer.concat([response, chunk])
      const headerEnd = response.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (response.length > 16_384) fail(new Error("browser_proxy_invalid_response"))
        return
      }
      upstream.off("data", onData)
      const statusLine = response.subarray(0, headerEnd).toString("latin1").split("\r\n", 1)[0] ?? ""
      if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
        fail(new Error("browser_proxy_connect_failed"))
        return
      }
      upstream.removeListener("error", fail)
      upstream.setTimeout(0)
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Lume\r\n\r\n")
      if (head.length) upstream.write(head)
      const remaining = response.subarray(headerEnd + 4)
      if (remaining.length) client.write(remaining)
      upstream.once("error", () => client.destroy())
      client.once("error", () => upstream.destroy())
      upstream.pipe(client)
      client.pipe(upstream)
      resolve()
    })
  })
}

function formatHost(hostname: string): string { return isIP(hostname) === 6 ? `[${hostname}]` : hostname }
