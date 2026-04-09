/**
 * FileTypeIcon — 根据文件名渲染对应的语义图标
 *
 * 用 lucide-react 图标提供文件类型可视化，
 * 供工具结果渲染器（Grep、Glob 等）和文件浏览器使用。
 */
import * as React from "react";
import {
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Globe,
  Settings,
} from "lucide-react";

interface FileTypeIconProps {
  name: string;
  isDirectory: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
}

const EXT_MAP: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  // 代码类
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  py: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  cs: FileCode,
  cpp: FileCode,
  c: FileCode,
  rb: FileCode,
  php: FileCode,
  swift: FileCode,
  kt: FileCode,
  // 配置类
  json: FileJson,
  yaml: Settings,
  yml: Settings,
  toml: Settings,
  env: Settings,
  config: Settings,
  // 文档类
  md: FileText,
  mdx: FileText,
  txt: FileText,
  // 图片类
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  ico: FileImage,
  // 网络
  html: Globe,
  htm: Globe,
  css: FileType,
  scss: FileType,
  // 字体
  ttf: FileType,
  woff: FileType,
};

export const FileTypeIcon = React.memo(function FileTypeIcon({
  name,
  isDirectory,
  isOpen = false,
  size = 14,
  className,
}: FileTypeIconProps): React.ReactElement {
  if (isDirectory) {
    const Icon = isOpen ? FolderOpen : Folder;
    return (
      <Icon
        className={className}
        style={{ width: size, height: size, flexShrink: 0 }}
      />
    );
  }

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = EXT_MAP[ext] ?? File;

  return (
    <Icon
      className={className}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
});
