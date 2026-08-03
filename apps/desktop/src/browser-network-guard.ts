import { lookup as dnsLookup } from "node:dns/promises"
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http"
import { connect as connectSocket, isIP } from "node:net"
import type { Duplex } from "node:stream"

type LookupResult = { address: string; family: number }
type Lookup = (hostname: string) => Promise<LookupResult[]>

export type BrowserNetworkGuardOptions = {
  allowPrivateOrigin?: (origin: string) => boolean
  lookup?: Lookup
}

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
    const target = await resolveGuardTarget(url.hostname, Number(url.port || 80), url.protocol, this.lookup, this.options.allowPrivateOrigin)
    const forwardedHeaders = { ...request.headers, host: url.host }
    delete forwardedHeaders["proxy-connection"]
    return new Promise<IncomingMessage>((resolve, reject) => {
      const upstream = httpRequest({ host: target.address, family: target.family, port: target.port, method: request.method ?? "GET", path: `${url.pathname}${url.search}`, headers: forwardedHeaders }, resolve)
      upstream.once("error", reject)
      request.pipe(upstream)
    })
  }

  private async forwardConnect(authority: string, client: Duplex, head: Buffer): Promise<void> {
    try {
      const parsed = new URL(`https://${authority}`)
      const port = Number(parsed.port || 443)
      const target = await resolveGuardTarget(parsed.hostname, port, "https:", this.lookup, this.options.allowPrivateOrigin)
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
}

export async function resolveGuardTarget(hostname: string, port: number, scheme: "http:" | "https:", lookup: Lookup, allowPrivateOrigin?: (origin: string) => boolean): Promise<{ address: string; family: number; port: number }> {
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
  const hasPrivateAddress = results.some((result) => !isPublicAddress(result.address))
  if (hasPrivateAddress && (!results.every((result) => !isPublicAddress(result.address)) || !allowPrivateOrigin?.(origin))) throw new Error("browser_network_blocked")
  return { address: results[0].address, family: results[0].family, port }
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
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return false
  if (normalized.startsWith("2001:db8:")) return false
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  return mapped ? isPublicAddress(mapped) : true
}

function formatHost(hostname: string): string { return isIP(hostname) === 6 ? `[${hostname}]` : hostname }
