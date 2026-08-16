import { describe, expect, it, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as filePreviewUtils from "./file-preview-utils"
import {
  classifyFilePreview,
  createLatestPreviewRequestGuard,
  createPreviewLinkRateLimiter,
  isHtmlPreviewMessageForScope,
  isImageFile,
  isMissingFileError,
  lumeFileUrl,
  parseHtmlPreviewMessage,
  resolveHtmlPreviewLocalRef,
} from "./file-preview-utils"
import { parsePdbStats } from "./RightPanelPdbPreview"

describe("isImageFile", () => {
  test.each(["a.png", "photo.JPG", "x.jpeg", "g.gif", "w.webp", "b.bmp", "s.svg"])(
    "true for image %s",
    (f) => {
      expect(isImageFile(f)).toBe(true)
    },
  )
  test.each(["a.md", "a.txt", "notes", "a.mp4", "a.pdf", ""])(
    "false for non-image %s",
    (f) => {
      expect(isImageFile(f)).toBe(false)
    },
  )
  test("absolute path with image ext is still an image", () => {
    expect(isImageFile("C:\\data\\threads\\t1\\files\\image-gen\\x.png")).toBe(true)
    expect(isImageFile("/data/threads/t1/files/image-gen/x.webp")).toBe(true)
  })
})

describe("lumeFileUrl", () => {
  test("编码绝对路径为 lume-file URL", () => {
    expect(lumeFileUrl("/data/threads/t1/a.png")).toBe(
      "lume-file://file/" + encodeURIComponent("/data/threads/t1/a.png"),
    )
  })
  test("Windows 绝对路径也被正确编码", () => {
    const p = "C:\\data\\threads\\t1\\a.png"
    expect(lumeFileUrl(p)).toBe("lume-file://file/" + encodeURIComponent(p))
  })
})

describe('preview classification and race guard', () => {
  test('summarizes PDB models, chains, atoms, and residues', () => {
    const source = [
      'MODEL        1',
      'ATOM      1  CA  ALA A   1      11.000  12.000  13.000  1.00 90.00           C',
      'ATOM      2  CA  GLY B   2      14.000  15.000  16.000  1.00 70.00           C',
      'ENDMDL',
    ].join('\n')
    expect(parsePdbStats(source)).toEqual({
      atoms: 2,
      residues: 2,
      models: 1,
      chains: ['A', 'B'],
      residueEntries: [
        { chain: 'A', number: 1, name: 'ALA', code: 'A' },
        { chain: 'B', number: 2, name: 'GLY', code: 'G' },
      ],
    })
  })

  test('maps source files to Shiki languages and uses the highlighted source renderer', () => {
    const getLanguage = (filePreviewUtils as typeof filePreviewUtils & {
      getSourcePreviewLanguage?: (path: string) => string
    }).getSourcePreviewLanguage

    expect(getLanguage).toBeDefined()
    if (!getLanguage) return
    expect(getLanguage('src/App.tsx')).toBe('tsx')
    expect(getLanguage('scripts/build.py')).toBe('python')
    expect(getLanguage('Dockerfile')).toBe('docker')
    expect(getLanguage('AGENTS.md')).toBe('markdown')
    expect(getLanguage('notes.txt')).toBe('text')

    const previewSource = readFileSync(resolve(import.meta.dir, 'RightPanelFilePreview.tsx'), 'utf8')
    const sourceRenderer = readFileSync(resolve(import.meta.dir, 'RightPanelSourcePreview.tsx'), 'utf8')
    expect(previewSource).toContain('RightPanelSourcePreview')
    expect(previewSource).toContain("cn('h-full overflow-auto'")
    expect(sourceRenderer).toContain('PierreEditableFileView')
    expect(sourceRenderer).toContain('PierreFileView')
    expect(sourceRenderer).not.toContain('rounded-md p-4')
  })

  test.each([
    ['README.md', 'markdown'],
    ['index.html', 'html'],
    ['photo.png', 'image'],
    ['main.ts', 'text'],
    ['archive.zip', 'unsupported'],
    ['manual.pdf', 'pdf'],
    ['movie.mp4', 'video'],
    ['protein.pdb', 'pdb'],
  ] as const)('%s uses %s preview', (path, expected) => {
    expect(classifyFilePreview(path)).toBe(expected)
  })

  test('only accepts the latest asynchronous preview request', () => {
    const guard = createLatestPreviewRequestGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
    guard.cancel()
    expect(guard.isCurrent(second)).toBe(false)
  })

  test('recognizes missing-file failures from desktop and sidecar boundaries', () => {
    expect(isMissingFileError(new Error('FileRef 目标不存在'))).toBe(true)
    expect(isMissingFileError(new Error('ENOENT: no such file or directory'))).toBe(true)
    expect(isMissingFileError({ message: 'not found' })).toBe(true)
    expect(isMissingFileError(new Error('permission denied'))).toBe(false)
  })

  test('validates hostile iframe messages and keeps local links inside the HTML directory', () => {
    const scopeUrl = 'lume-file://preview/token/index.html'
    const parsed = parseHtmlPreviewMessage({ type: 'lume-preview-link', kind: 'local', href: './docs/help.html', scopeUrl })
    expect(parsed).toEqual({ kind: 'local', href: './docs/help.html', scopeUrl })
    expect(parsed && isHtmlPreviewMessageForScope(parsed, scopeUrl)).toBe(true)
    expect(parsed && isHtmlPreviewMessageForScope(parsed, 'lume-file://preview/other/index.html')).toBe(false)
    expect(parseHtmlPreviewMessage({ type: 'wrong', kind: 'local', href: './x' })).toBeNull()
    expect(parseHtmlPreviewMessage({ type: 'lume-preview-link', kind: 'remote', href: 'javascript:alert(1)' })).toBeNull()

    const entry = { source: 'project', scopeId: 'project-1', relativePath: 'site/index.html' } as const
    expect(resolveHtmlPreviewLocalRef(entry, './docs/help.html')).toEqual({
      source: 'project', scopeId: 'project-1', relativePath: 'site/docs/help.html',
    })
    expect(resolveHtmlPreviewLocalRef(entry, '../secret.txt')).toBeNull()
    expect(resolveHtmlPreviewLocalRef(entry, './.env')).toBeNull()
    expect(resolveHtmlPreviewLocalRef(entry, './source.ts')).toBeNull()
  })

  test('rate limits remote preview link requests', () => {
    let now = 0
    const limiter = createPreviewLinkRateLimiter({ max: 2, windowMs: 100, now: () => now })
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(true)
    expect(limiter.allow()).toBe(false)
    now = 101
    expect(limiter.allow()).toBe(true)
  })

  test('keeps browser fallbacks and clipboard/iframe security boundaries in the preview components', () => {
    const previewSource = readFileSync(resolve(import.meta.dir, 'RightPanelFilePreview.tsx'), 'utf8')
    const htmlSource = readFileSync(resolve(import.meta.dir, 'RightPanelHtmlPreview.tsx'), 'utf8')
    expect(previewSource).toContain("if (!isDesktopRuntime())")
    expect(htmlSource).toContain("if (!isDesktopRuntime())")
    expect(htmlSource).toMatch(/sandbox=["']allow-scripts["']/)
    expect(htmlSource).not.toContain('allow-same-origin')
    expect(`${previewSource}\n${htmlSource}`).not.toContain('navigator.clipboard')
    expect(previewSource).toContain('writeClipboardText')
  })

  test('does not reload an editor when preview bookkeeping callbacks change', () => {
    const previewSource = readFileSync(resolve(import.meta.dir, 'RightPanelFilePreview.tsx'), 'utf8')

    expect(previewSource).toContain('onPreviewScopeChangeRef.current')
    expect(previewSource).toContain('const previewScopeChange = onPreviewScopeChangeRef.current')
    expect(previewSource).toContain('previewScopeChange?.(scope.token)')
    expect(previewSource).toContain('previewScopeChange?.(null)')
    expect(previewSource).toContain('onMissingRef.current')
    expect(previewSource).toContain('[editorStateKey, guardedRef, kind, lineSelection?.end, lineSelection?.start, refreshKey]')
  })
})

describe('classifyFilePreview — 文档查看器格式', () => {
  it('识别 Office 与 CSV 文档', () => {
    expect(classifyFilePreview('a.docx')).toBe('docx')
    expect(classifyFilePreview('b.DOCX')).toBe('docx')
    expect(classifyFilePreview('a.xlsx')).toBe('xlsx')
    expect(classifyFilePreview('a.pptx')).toBe('pptx')
    expect(classifyFilePreview('a.csv')).toBe('csv')
    expect(classifyFilePreview('a.tsv')).toBe('csv')
  })

  it('保留既有分类不回归', () => {
    expect(classifyFilePreview('a.pdf')).toBe('pdf')
    expect(classifyFilePreview('a.png')).toBe('image')
    expect(classifyFilePreview('a.md')).toBe('markdown')
    expect(classifyFilePreview('a.html')).toBe('html')
    expect(classifyFilePreview('a.mp4')).toBe('video')
    expect(classifyFilePreview('a.ts')).toBe('text')
    expect(classifyFilePreview('a.unknownext')).toBe('unsupported')
  })
})
