import * as React from 'react'
import { LiveMarkdownEditor, type LiveMarkdownEditorHandle, type LiveMarkdownEditorProps } from '@/components/markdown/LiveMarkdownEditor'
import { createVaultMediaPreviewScope } from '@/lib/desktop-api/native'
import { saveObsidianVaultPastedImage } from '@/lib/desktop-api/obsidian-vault'

const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024

/** 分块 btoa 避免 String.fromCharCode 展开超大参数栈。 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

type VaultLiveMarkdownEditorProps = Omit<LiveMarkdownEditorProps, 'resolveImageSrc' | 'savePastedImage'> & {
  vaultPath: string
  relativePath: string
}

/**
 * LiveMarkdownEditor 的 Vault 适配层（移植自 Proma 同名组件）：
 * 相对图片路径经主进程登记为受控 URL 后渲染；粘贴图片落盘为
 * `<笔记目录>/assets/` 下的文件并插入相对引用。
 */
export const VaultLiveMarkdownEditor = React.forwardRef<LiveMarkdownEditorHandle, VaultLiveMarkdownEditorProps>(function VaultLiveMarkdownEditor({
  vaultPath,
  relativePath,
  ...editorProps
}, ref) {
  const mediaRequestsRef = React.useRef(new Map<string, Promise<string | null>>())
  const locationRef = React.useRef({ vaultPath, relativePath })
  locationRef.current = { vaultPath, relativePath }

  const resolveImageSrc = React.useCallback((src: string): Promise<string | null> => {
    const cached = mediaRequestsRef.current.get(src)
    if (cached) return cached
    const request = createVaultMediaPreviewScope({
      vaultPath: locationRef.current.vaultPath,
      noteRelativePath: locationRef.current.relativePath,
      src,
    }).then((scope) => scope?.url ?? null).catch(() => null)
    mediaRequestsRef.current.set(src, request)
    return request
  }, [])

  const savePastedImage = React.useCallback(async (file: File): Promise<string | null> => {
    if (file.size <= 0 || file.size > MAX_PASTED_IMAGE_BYTES) return null
    try {
      const result = await saveObsidianVaultPastedImage({
        vaultPath: locationRef.current.vaultPath,
        noteRelativePath: locationRef.current.relativePath,
        mimeType: file.type,
        base64: await fileToBase64(file),
      })
      return result?.src ?? null
    } catch {
      return null
    }
  }, [])

  return <LiveMarkdownEditor ref={ref} {...editorProps} resolveImageSrc={resolveImageSrc} savePastedImage={savePastedImage} />
})
