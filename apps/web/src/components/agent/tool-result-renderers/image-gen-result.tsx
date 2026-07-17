import { useEffect, useState } from "react"
import { AGENT_IPC_CHANNELS, type FileRef } from "@lume/shared"
import { Button } from "@/components/ui/button"
import { createFilePreviewScope, revokeFilePreviewScope, sidecarCall } from "@/lib/desktop-api"
import { useThreadFileEnv, type ThreadFileEnv } from "../thread-file-env"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Maximize2, Minimize2, X } from "lucide-react"

export interface ImageGenImage {
  threadPath: string
  filename: string
  mediaType: string
  size: number
  fileRef?: FileRef
}

interface ImageGenResultData {
  images?: ImageGenImage[]
  modelUsed?: string
  mode?: string
}

interface Props {
  input: Record<string, unknown>
  result: unknown
  presentation?: "default" | "gallery"
}

interface ImageGenPreviewScope {
  token: string
  url: string
  expiresAt: number
}

interface ImageGenPreviewDeps {
  convertLegacyFileRef: (input: {
    recordKind: "thread-attachment"
    threadId: string
    workspaceSlug?: string
    legacyRelativePath: string
  }) => Promise<FileRef>
  createPreviewScope: (input: { ref: FileRef; kind: "media-file" }) => Promise<ImageGenPreviewScope>
}

const defaultPreviewDeps: ImageGenPreviewDeps = {
  convertLegacyFileRef: (input) => sidecarCall<FileRef>(AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF, input),
  createPreviewScope: (input) => createFilePreviewScope(input),
}

export async function createImageGenPreviewScope(
  image: ImageGenImage,
  env: ThreadFileEnv,
  deps: ImageGenPreviewDeps = defaultPreviewDeps,
): Promise<ImageGenPreviewScope> {
  if (!env.threadId) throw new Error("图片预览缺少 threadId")
  const ref = image.fileRef ?? await deps.convertLegacyFileRef({
    recordKind: "thread-attachment",
    threadId: env.threadId,
    ...(env.workspaceSlug ? { workspaceSlug: env.workspaceSlug } : {}),
    legacyRelativePath: image.threadPath,
  })
  return deps.createPreviewScope({ ref, kind: "media-file" })
}

/** 使用绑定 FileRef 的临时预览作用域，兼容 file-context 与旧版 threadPath。 */
function useImageSrcs(
  threadId: string | undefined,
  images: ImageGenImage[],
  workspaceSlug?: string,
): Record<string, string | null | undefined> {
  const [srcByPath, setSrcByPath] = useState<Record<string, string | null | undefined>>({})
  const key = images
    .map((image) => [
      image.threadPath,
      image.fileRef?.source,
      image.fileRef?.scopeId,
      image.fileRef?.relativePath,
    ].filter(Boolean).join(":"))
    .join("|")
  useEffect(() => {
    if (!threadId || images.length === 0) {
      setSrcByPath({})
      return
    }
    let cancelled = false
    const scopeTokens = new Set<string>()
    setSrcByPath({})
    void Promise.all(
      images.map(async (img) => {
        try {
          const scope = await createImageGenPreviewScope(img, {
            threadId,
            ...(workspaceSlug ? { workspaceSlug } : {}),
          })
          if (cancelled) {
            void revokeFilePreviewScope(scope.token).catch(() => undefined)
            return [img.threadPath, null] as const
          }
          scopeTokens.add(scope.token)
          return [img.threadPath, scope.url] as const
        } catch (error) {
          console.error("[image-gen-result] 加载图片失败:", error)
          return [img.threadPath, null] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setSrcByPath(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
      for (const token of scopeTokens) {
        void revokeFilePreviewScope(token).catch(() => undefined)
      }
    }
    // 依赖 key（threadPath 拼接）而非数组引用，避免每次渲染重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, key, workspaceSlug])
  return srcByPath
}

export function ImageGenResult({ result, presentation = "default" }: Props) {
  const data = (result ?? {}) as ImageGenResultData
  const env = useThreadFileEnv()
  const images = data.images ?? []
  const srcByPath = useImageSrcs(env.threadId, images, env.workspaceSlug)
  const [previewImage, setPreviewImage] = useState<ImageGenImage | null>(null)
  const [originalSize, setOriginalSize] = useState(false)
  const previewSrc = previewImage ? srcByPath[previewImage.threadPath] : undefined

  const closePreview = () => {
    setPreviewImage(null)
    setOriginalSize(false)
  }

  if (images.length === 0) {
    const text = JSON.stringify(data, null, 2)
    return (
      <pre className="bg-muted/30 rounded-lg p-3 text-[12px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap">
        {text}
      </pre>
    )
  }

  return (
    <div className={presentation === "gallery" ? "contents" : "space-y-2"}>
      <div className={presentation === "gallery" ? "contents" : "flex flex-nowrap gap-2"}>
        {images.map((img) => {
          const src = srcByPath[img.threadPath]
          return (
            <Button
              key={img.threadPath}
              variant="ghost"
              onClick={() => setPreviewImage(img)}
              disabled={!src}
              title={src ? `放大查看 ${img.filename}` : undefined}
              data-image-generation-image="true"
              className={cn(
                "flex aspect-square h-auto shrink-0 cursor-zoom-in items-center justify-center overflow-hidden bg-muted/40 p-0 disabled:cursor-default disabled:opacity-100",
                presentation === "gallery"
                  ? "w-[min(21.5vw,216px)] min-w-[190px] snap-start rounded-[20px]"
                  : "w-64 rounded-[28px]",
              )}
            >
              {src === null ? (
                <div className="flex h-full w-full items-center justify-center text-[11px] text-destructive/70">
                  图片加载失败
                </div>
              ) : src ? (
                <img
                  src={src}
                  alt={img.filename}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div
                  data-image-generation-loading="true"
                  className="lume-image-generation-loading h-full w-full"
                  role="status"
                  aria-label="正在加载生成的图片"
                />
              )}
            </Button>
          )
        })}
      </div>
      {presentation !== "gallery" && (data.modelUsed || data.mode) && (
        <div className="text-[11px] text-foreground/50 font-mono">
          {[data.modelUsed, data.mode].filter(Boolean).join(" · ")}
        </div>
      )}
      <Dialog open={Boolean(previewImage && previewSrc)} onOpenChange={(open) => { if (!open) closePreview() }}>
        <DialogContent
          showCloseButton={false}
          className="inset-0 left-0 top-0 z-[151] block h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-auto rounded-none bg-black/92 p-4 ring-0 sm:max-w-none"
          onClick={closePreview}
        >
          <DialogTitle className="sr-only">查看图片 {previewImage?.filename}</DialogTitle>
          <div className="fixed right-4 top-4 z-10 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
              onClick={() => setOriginalSize((value) => !value)}
            >
              {originalSize ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              {originalSize ? "适应窗口" : "原始尺寸"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
              onClick={closePreview}
              aria-label="关闭图片预览"
            >
              <X size={18} />
            </Button>
          </div>
          {previewSrc && (
            <div className={originalSize ? "min-h-full min-w-full" : "flex h-full w-full items-center justify-center"}>
              <img
                src={previewSrc}
                alt={previewImage?.filename ?? "生成的图片"}
                className={originalSize ? "max-w-none" : "max-h-full max-w-full object-contain"}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={() => setOriginalSize((value) => !value)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
