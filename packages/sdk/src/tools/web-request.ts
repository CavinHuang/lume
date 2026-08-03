import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const STATUS_SENTINEL = '__SDK_STATUS__:'

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

  if (typeof init.body === 'string') {
    args.push('--data-raw', init.body)
  }

  args.push('--write-out', `\n${STATUS_SENTINEL}%{http_code}`)

  const { stdout, stderr } = await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    maxBuffer: 1024 * 1024 * 4,
    signal: init.signal ?? undefined,
  })
  const output = stdout.toString()
  const markerIndex = output.lastIndexOf(STATUS_SENTINEL)
  if (markerIndex < 0) {
    throw new Error(stderr?.toString().trim() || 'curl returned invalid output')
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
