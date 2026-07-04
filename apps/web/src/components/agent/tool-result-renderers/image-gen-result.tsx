import { useEffect, useState } from "react"
import { sidecarCall } from "@/lib/desktop-api"
import { AGENT_IPC_CHANNELS, type AgentThreadFileDataResult } from "@lume/shared"
import { useThreadFileEnv } from "../thread-file-env"

interface ImageGenImage {
  threadPath: string
  filename: string
  mediaType: string
  size: number
}

interface ImageGenResultData {
  images?: ImageGenImage[]
  modelUsed?: string
  mode?: string
}

interface Props {
  input: Record<string, unknown>
  result: unknown
}

/** 按 threadPath 调 READ_THREAD_FILE_DATA 读 base64 → data URL */
function useImageSrcs(
  threadId: string | undefined,
  images: ImageGenImage[],
): Record<string, string | undefined> {
  const [srcByPath, setSrcByPath] = useState<Record<string, string | undefined>>({})
  const key = images.map((i) => i.threadPath).join("|")
  useEffect(() => {
    if (!threadId || images.length === 0) {
      setSrcByPath({})
      return
    }
    let cancelled = false
    setSrcByPath({})
    void Promise.all(
      images.map(async (img) => {
        try {
          const r = await sidecarCall<AgentThreadFileDataResult>(
            AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA,
            { threadId, path: img.threadPath },
          )
          return [img.threadPath, `data:${img.mediaType};base64,${r.data}`] as const
        } catch (error) {
          console.error("[image-gen-result] 加载图片失败:", error)
          return [img.threadPath, undefined] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) setSrcByPath(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
    // 依赖 key（threadPath 拼接）而非数组引用，避免每次渲染重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, key])
  return srcByPath
}

export function ImageGenResult({ result }: Props) {
  const data = (result ?? {}) as ImageGenResultData
  const env = useThreadFileEnv()
  const images = data.images ?? []
  const srcByPath = useImageSrcs(env.threadId, images)

  if (images.length === 0) {
    const text = JSON.stringify(data, null, 2)
    return (
      <pre className="bg-muted/30 rounded-lg p-3 text-[12px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap">
        {text}
      </pre>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {images.map((img) => {
          const src = srcByPath[img.threadPath]
          return (
            <div
              key={img.threadPath}
              className="flex max-h-[256px] max-w-[320px] items-center justify-center overflow-hidden rounded-md bg-muted/40"
            >
              {src ? (
                <img
                  src={src}
                  alt={img.filename}
                  className="max-h-[256px] max-w-[320px] object-contain"
                />
              ) : (
                <div className="flex h-24 w-48 items-center justify-center text-[11px] text-foreground/40">
                  加载图片…
                </div>
              )}
            </div>
          )
        })}
      </div>
      {(data.modelUsed || data.mode) && (
        <div className="text-[11px] text-foreground/50 font-mono">
          {[data.modelUsed, data.mode].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  )
}
