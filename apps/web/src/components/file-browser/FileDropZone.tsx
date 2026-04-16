/**
 * FileDropZone - 文件拖拽上传区域
 *
 * 覆盖 AgentView 的拖拽目标区域，拖入文件时高亮边框，
 * 松手后调用 sidecar 上传文件到 thread 工作目录。
 */

import * as React from 'react'
import { Upload, File, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { sidecarCall, openFileDialog } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'

interface FileDropZoneProps {
  threadId: string
  onFilesUploaded?: () => void
}

export function FileDropZone({ threadId, onFilesUploaded }: FileDropZoneProps) {
  const [isDragOver, setIsDragOver] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)

  const saveFiles = React.useCallback(async (files: globalThis.File[]) => {
    if (files.length === 0) return

    setIsUploading(true)
    try {
      const fileEntries: Array<{ filename: string; data: string }> = []
      for (const file of files) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1] ?? '')
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        fileEntries.push({ filename: file.name, data })
      }

      await sidecarCall('agent:save-files-to-thread', { threadId, files: fileEntries })
      onFilesUploaded?.()
      toast.success(`已添加 ${files.length} 个文件`)
    } catch (error) {
      console.error('[FileDropZone] 上传失败:', error)
      toast.error('文件上传失败')
    } finally {
      setIsUploading(false)
    }
  }, [threadId, onFilesUploaded])

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = React.useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    await saveFiles(files)
  }, [saveFiles])

  const handleSelectFiles = React.useCallback(async () => {
    try {
      const result = await openFileDialog()
      if (result.files.length === 0) return

      setIsUploading(true)
      await sidecarCall('agent:save-files-to-thread', {
        threadId,
        files: result.files.map((f) => ({ filename: f.filename, sourcePath: f.sourcePath })),
      })
      onFilesUploaded?.()
      toast.success(`已添加 ${result.files.length} 个文件`)
    } catch (error) {
      console.error('[FileDropZone] 选择文件失败:', error)
      toast.error('文件上传失败')
    } finally {
      setIsUploading(false)
    }
  }, [threadId, onFilesUploaded])

  return (
    <div className="flex-shrink-0 px-3 pt-3 pb-1">
      <div
        className={cn(
          'relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4',
          'transition-colors duration-200 cursor-default',
          isDragOver
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/20 hover:border-muted-foreground/40',
          isUploading && 'pointer-events-none opacity-60',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isUploading ? (
          <>
            <Loader2 className="size-5 text-muted-foreground animate-spin" />
            <span className="text-xs text-muted-foreground">正在上传...</span>
          </>
        ) : (
          <>
            <Upload className={cn(
              'size-5 transition-colors',
              isDragOver ? 'text-primary' : 'text-muted-foreground/75',
            )} />
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              拖拽文件到此处
              <br />
              <span className="text-[10px] text-muted-foreground/75">供 Agent 读取和处理</span>
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] px-2 gap-1 text-muted-foreground hover:text-foreground"
              onClick={handleSelectFiles}
            >
              <File className="size-3" />
              选择文件
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
