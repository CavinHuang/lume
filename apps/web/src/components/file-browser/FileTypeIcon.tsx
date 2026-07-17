/**
 * FileTypeIcon - 根据文件扩展名返回对应图标
 */

import {
  File,
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  FileType,
  Folder,
  Presentation,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const EXT_MAP: Record<string, { icon: typeof File; color: string }> = {
  // 代码
  ts: { icon: FileCode, color: 'text-blue-500' },
  tsx: { icon: FileCode, color: 'text-blue-500' },
  js: { icon: FileCode, color: 'text-yellow-500' },
  jsx: { icon: FileCode, color: 'text-yellow-500' },
  py: { icon: FileCode, color: 'text-green-500' },
  rs: { icon: FileCode, color: 'text-orange-500' },
  go: { icon: FileCode, color: 'text-cyan-500' },
  java: { icon: FileCode, color: 'text-red-500' },
  rb: { icon: FileCode, color: 'text-red-400' },
  php: { icon: FileCode, color: 'text-purple-500' },
  c: { icon: FileCode, color: 'text-blue-400' },
  cpp: { icon: FileCode, color: 'text-blue-400' },
  h: { icon: FileCode, color: 'text-blue-300' },
  css: { icon: FileCode, color: 'text-pink-500' },
  scss: { icon: FileCode, color: 'text-pink-400' },
  html: { icon: FileCode, color: 'text-orange-400' },
  vue: { icon: FileCode, color: 'text-green-400' },
  svelte: { icon: FileCode, color: 'text-orange-500' },
  swift: { icon: FileCode, color: 'text-orange-500' },
  kt: { icon: FileCode, color: 'text-purple-400' },
  dart: { icon: FileCode, color: 'text-cyan-400' },
  cs: { icon: FileCode, color: 'text-purple-500' },
  scala: { icon: FileCode, color: 'text-red-500' },
  lua: { icon: FileCode, color: 'text-blue-400' },
  sql: { icon: FileCode, color: 'text-cyan-500' },
  sh: { icon: FileCode, color: 'text-foreground/50' },
  bash: { icon: FileCode, color: 'text-foreground/50' },
  zsh: { icon: FileCode, color: 'text-foreground/50' },
  // 数据
  json: { icon: FileJson, color: 'text-yellow-400' },
  yaml: { icon: FileJson, color: 'text-yellow-500' },
  yml: { icon: FileJson, color: 'text-yellow-500' },
  toml: { icon: FileJson, color: 'text-foreground/50' },
  ini: { icon: FileJson, color: 'text-foreground/50' },
  conf: { icon: FileJson, color: 'text-foreground/50' },
  env: { icon: FileJson, color: 'text-yellow-500' },
  xml: { icon: FileJson, color: 'text-orange-400' },
  csv: { icon: FileSpreadsheet, color: 'text-green-500' },
  // 文档
  md: { icon: FileText, color: 'text-foreground/60' },
  mdx: { icon: FileText, color: 'text-foreground/60' },
  txt: { icon: FileText, color: 'text-foreground/50' },
  pdf: { icon: FileText, color: 'text-red-500' },
  doc: { icon: FileText, color: 'text-blue-500' },
  docx: { icon: FileText, color: 'text-blue-500' },
  odt: { icon: FileText, color: 'text-blue-400' },
  ppt: { icon: Presentation, color: 'text-orange-500' },
  pptx: { icon: Presentation, color: 'text-orange-500' },
  odp: { icon: Presentation, color: 'text-orange-400' },
  xls: { icon: FileSpreadsheet, color: 'text-green-600' },
  xlsx: { icon: FileSpreadsheet, color: 'text-green-600' },
  ods: { icon: FileSpreadsheet, color: 'text-green-500' },
  // 图片
  png: { icon: FileImage, color: 'text-purple-400' },
  jpg: { icon: FileImage, color: 'text-purple-400' },
  jpeg: { icon: FileImage, color: 'text-purple-400' },
  gif: { icon: FileImage, color: 'text-purple-400' },
  svg: { icon: FileImage, color: 'text-orange-400' },
  webp: { icon: FileImage, color: 'text-purple-400' },
  bmp: { icon: FileImage, color: 'text-purple-400' },
  ico: { icon: FileImage, color: 'text-purple-400' },
  // 视频
  mp4: { icon: FileVideo, color: 'text-pink-500' },
  mov: { icon: FileVideo, color: 'text-pink-500' },
  avi: { icon: FileVideo, color: 'text-pink-500' },
  webm: { icon: FileVideo, color: 'text-pink-500' },
  mkv: { icon: FileVideo, color: 'text-pink-500' },
  m4v: { icon: FileVideo, color: 'text-pink-500' },
  // 音频
  mp3: { icon: FileAudio, color: 'text-green-400' },
  wav: { icon: FileAudio, color: 'text-green-400' },
  ogg: { icon: FileAudio, color: 'text-green-400' },
  flac: { icon: FileAudio, color: 'text-green-400' },
  m4a: { icon: FileAudio, color: 'text-green-400' },
  // 压缩
  zip: { icon: FileArchive, color: 'text-foreground/50' },
  tar: { icon: FileArchive, color: 'text-foreground/50' },
  gz: { icon: FileArchive, color: 'text-foreground/50' },
  tgz: { icon: FileArchive, color: 'text-foreground/50' },
  bz2: { icon: FileArchive, color: 'text-foreground/50' },
  '7z': { icon: FileArchive, color: 'text-foreground/50' },
  rar: { icon: FileArchive, color: 'text-foreground/50' },
  // 字体
  woff: { icon: FileType, color: 'text-foreground/40' },
  woff2: { icon: FileType, color: 'text-foreground/40' },
  ttf: { icon: FileType, color: 'text-foreground/40' },
  otf: { icon: FileType, color: 'text-foreground/40' },
}

interface FileTypeIconProps {
  filename: string
  size?: number
  className?: string
  isDirectory?: boolean
}

export function FileTypeIcon({ filename, size = 13, className, isDirectory = false }: FileTypeIconProps) {
  if (isDirectory) return <Folder size={size} className={cn('text-amber-500', 'flex-shrink-0', className)} />
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const match = EXT_MAP[ext]
  const Icon = match?.icon ?? File
  const color = match?.color ?? 'text-foreground/40'

  return <Icon size={size} className={cn(color, 'flex-shrink-0', className)} />
}
