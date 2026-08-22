import { spawn } from 'node:child_process'
import { MAX_FETCH_BYTES } from './web-fetch-http.js'

const STATUS_SENTINEL = '__SDK_STATUS__:'
// curl emits response headers + body + status sentinel; keep headroom above
// the 50MB fetch body budget instead of a hard-coded 4MB execFile maxBuffer.
const MAX_CURL_OUTPUT_BYTES = MAX_FETCH_BYTES + 8 * 1024 * 1024
const MAX_STDERR_CHARS = 8 * 1024

function shouldBypassProxy(targetUrl: string, noProxy?: string): boolean {
  const hostname = new URL(targetUrl).hostname.toLowerCase()
  const rules = (noProxy ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  return rules.some((rule) => hostname === rule || hostname.endsWith(`.${rule}`))
}

function resolveProxyUrl(targetUrl: string): string | null {
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
  if (shouldBypassProxy(targetUrl, noProxy)) {
    return null
  }
  const protocol = new URL(targetUrl).protocol
  if (protocol === 'https:') {
    return httpsProxy ?? httpProxy ?? null
  }
  return httpProxy ?? null
}

interface CurlRunResult {
  stdout: Buffer
  stderr: string
}

function runCurl(args: string[], options: { input?: string; signal?: AbortSignal }): Promise<CurlRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
      signal: options.signal,
      windowsHide: true,
    })
    let settled = false
    let stdout = Buffer.alloc(0)
    let stderr = ''
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      child.kill()
      reject(error)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > MAX_CURL_OUTPUT_BYTES) {
        fail(new Error(`curl output exceeds ${MAX_CURL_OUTPUT_BYTES} bytes`))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString()
    })
    child.on('error', fail)
    child.on('close', () => {
      if (!settled) {
        settled = true
        resolve({ stdout, stderr })
      }
    })
    // curl may exit before consuming stdin (e.g. on an early error); the
    // close/error handlers settle the promise either way.
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input)
  })
}

async function fetchViaCurl(input: string, init: RequestInit = {}, proxyUrl: string): Promise<Response> {
  const args = [
    '--silent',
    '--show-error',
    '--max-time',
    '30',
    '--connect-timeout',
    '12',
    '--proxy',
    proxyUrl,
    '--request',
    init.method ?? 'GET',
    input,
  ]
  if (init.redirect === 'manual') {
    args.push('--max-redirs', '0', '--dump-header', '-')
  } else {
    args.splice(2, 0, '--location')
  }

  const headers = new Headers(init.headers)
  headers.forEach((value, key) => {
    args.push('--header', `${key}: ${value}`)
  })

  // Bodies travel on stdin (--data-binary @-): request bodies are unbounded and
  // Windows caps a single argv entry around 32K chars, so large POST payloads
  // must never ride on the command line.
  const stdinBody = typeof init.body === 'string' ? init.body : undefined
  if (stdinBody !== undefined) {
    args.push('--data-binary', '@-')
  }

  args.push('--write-out', `\n${STATUS_SENTINEL}%{http_code}`)

  const { stdout, stderr } = await runCurl(args, { input: stdinBody, signal: init.signal ?? undefined })
  const output = stdout.toString()
  const markerIndex = output.lastIndexOf(STATUS_SENTINEL)
  if (markerIndex < 0) {
    throw new Error(stderr?.trim() || 'curl returned invalid output')
  }
  let body = output.slice(0, markerIndex)
  const statusText = output.slice(markerIndex + STATUS_SENTINEL.length).trim()
  const status = Number.parseInt(statusText, 10)
  let responseHeaders = new Headers({
    'content-type': headers.get('content-type') ?? 'text/plain; charset=utf-8',
  })
  if (init.redirect === 'manual') {
    const headerEnd = body.search(/\r?\n\r?\n/)
    if (headerEnd >= 0) {
      const headerText = body.slice(0, headerEnd)
      body = body.slice(headerEnd).replace(/^\r?\n\r?\n/, '')
      const parsedHeaders = new Headers()
      for (const line of headerText.split(/\r?\n/).slice(1)) {
        const separator = line.indexOf(':')
        if (separator > 0) parsedHeaders.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
      }
      responseHeaders = parsedHeaders
    }
  }
  return new Response(body, {
    status: Number.isFinite(status) ? status : 599,
    headers: responseHeaders,
  })
}

export async function sdkFetch(input: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = resolveProxyUrl(input)
  if (proxyUrl) {
    return fetchViaCurl(input, init, proxyUrl)
  }
  return fetch(input, init)
}
