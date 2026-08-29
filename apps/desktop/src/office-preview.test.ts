// Office 预览纯逻辑单测：目标平台映射、二进制路径解析（打包/开发两种布局）、
// 输出 CSP 注入、扩展名白名单。execFile 渲染主链路依赖真实二进制，不在单测覆盖。
import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  getBundledOfficeCliPath,
  getOfficeCliTargetId,
  isOfficePreviewPath,
  restrictOfficeCliHtml,
} from './office-preview'

describe('getOfficeCliTargetId', () => {
  test('maps supported platform/arch pairs', () => {
    expect(getOfficeCliTargetId({ platform: 'win32', arch: 'x64' })).toBe('win32-x64')
    expect(getOfficeCliTargetId({ platform: 'win32', arch: 'arm64' })).toBe('win32-arm64')
    expect(getOfficeCliTargetId({ platform: 'darwin', arch: 'x64' })).toBe('darwin-x64')
    expect(getOfficeCliTargetId({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64')
    expect(getOfficeCliTargetId({ platform: 'linux', arch: 'x64' })).toBe('linux-x64')
    expect(getOfficeCliTargetId({ platform: 'linux', arch: 'arm64' })).toBe('linux-arm64')
  })

  test('rejects unsupported targets', () => {
    expect(() => getOfficeCliTargetId({ platform: 'freebsd' as never, arch: 'x64' })).toThrow()
    expect(() => getOfficeCliTargetId({ platform: 'win32', arch: 'riscv64' })).toThrow()
  })
})

describe('getBundledOfficeCliPath', () => {
  const base = { resourcesPath: '/app/resources', desktopRoot: '/repo/apps/desktop' }

  test('packaged layout reads from resourcesPath', () => {
    expect(getBundledOfficeCliPath({ ...base, appIsPackaged: true, platform: 'darwin', arch: 'arm64' }))
      .toBe(join('/app/resources', 'officecli', 'darwin-arm64', 'officecli'))
    expect(getBundledOfficeCliPath({ ...base, appIsPackaged: true, platform: 'win32', arch: 'x64' }))
      .toBe(join('/app/resources', 'officecli', 'win32-x64', 'officecli.exe'))
  })

  test('dev layout reads from desktopRoot/resources', () => {
    // 实现用 resolve 锚定 desktopRoot（Windows 下会补盘符），期望值用同语义构造
    expect(getBundledOfficeCliPath({ ...base, appIsPackaged: false, platform: 'darwin', arch: 'x64' }))
      .toBe(resolve('/repo/apps/desktop', 'resources', 'officecli', 'darwin-x64', 'officecli'))
  })
})

describe('restrictOfficeCliHtml', () => {
  const marker = 'Content-Security-Policy'

  test('injects CSP meta after existing <head>', () => {
    const html = '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>'
    const result = restrictOfficeCliHtml(html)
    expect(result).toContain(marker)
    expect(result.indexOf(marker)).toBeGreaterThan(html.indexOf('<head>'))
    expect(result).toContain("connect-src 'none'")
  })

  test('synthesizes a head when missing', () => {
    const html = '<html><body>hi</body></html>'
    const result = restrictOfficeCliHtml(html)
    expect(result).toContain(marker)
    expect(result).toContain('<head>')
  })

  test('keeps original content intact', () => {
    const html = '<html><head></head><body><p>doc</p></body></html>'
    const result = restrictOfficeCliHtml(html)
    expect(result).toContain('<p>doc</p>')
    expect(result.startsWith('<html><head>')).toBe(true)
  })
})

describe('isOfficePreviewPath', () => {
  test('accepts OOXML extensions case-insensitively', () => {
    expect(isOfficePreviewPath('/a/b.docx')).toBe(true)
    expect(isOfficePreviewPath('/a/b.XLSX')).toBe(true)
    expect(isOfficePreviewPath('/a/b.pptx')).toBe(true)
  })

  test('rejects other formats', () => {
    expect(isOfficePreviewPath('/a/b.ppt')).toBe(false)
    expect(isOfficePreviewPath('/a/b.csv')).toBe(false)
    expect(isOfficePreviewPath('/a/b.html')).toBe(false)
    expect(isOfficePreviewPath('/a/b')).toBe(false)
  })
})
