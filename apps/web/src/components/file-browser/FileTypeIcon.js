import { jsx as _jsx } from "react/jsx-runtime";
/**
 * FileTypeIcon - 根据文件扩展名返回对应图标
 */
import { File, FileCode, FileJson, FileText, FileImage, FileVideo, FileAudio, FileArchive, FileSpreadsheet, FileType, } from 'lucide-react';
import { cn } from '@/lib/utils';
const EXT_MAP = {
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
    sh: { icon: FileCode, color: 'text-foreground/50' },
    bash: { icon: FileCode, color: 'text-foreground/50' },
    zsh: { icon: FileCode, color: 'text-foreground/50' },
    // 数据
    json: { icon: FileJson, color: 'text-yellow-400' },
    yaml: { icon: FileJson, color: 'text-yellow-500' },
    yml: { icon: FileJson, color: 'text-yellow-500' },
    toml: { icon: FileJson, color: 'text-foreground/50' },
    xml: { icon: FileJson, color: 'text-orange-400' },
    csv: { icon: FileSpreadsheet, color: 'text-green-500' },
    // 文档
    md: { icon: FileText, color: 'text-foreground/60' },
    mdx: { icon: FileText, color: 'text-foreground/60' },
    txt: { icon: FileText, color: 'text-foreground/50' },
    pdf: { icon: FileText, color: 'text-red-500' },
    doc: { icon: FileText, color: 'text-blue-500' },
    docx: { icon: FileText, color: 'text-blue-500' },
    // 图片
    png: { icon: FileImage, color: 'text-purple-400' },
    jpg: { icon: FileImage, color: 'text-purple-400' },
    jpeg: { icon: FileImage, color: 'text-purple-400' },
    gif: { icon: FileImage, color: 'text-purple-400' },
    svg: { icon: FileImage, color: 'text-orange-400' },
    webp: { icon: FileImage, color: 'text-purple-400' },
    ico: { icon: FileImage, color: 'text-purple-400' },
    // 视频
    mp4: { icon: FileVideo, color: 'text-pink-500' },
    mov: { icon: FileVideo, color: 'text-pink-500' },
    avi: { icon: FileVideo, color: 'text-pink-500' },
    webm: { icon: FileVideo, color: 'text-pink-500' },
    // 音频
    mp3: { icon: FileAudio, color: 'text-green-400' },
    wav: { icon: FileAudio, color: 'text-green-400' },
    ogg: { icon: FileAudio, color: 'text-green-400' },
    // 压缩
    zip: { icon: FileArchive, color: 'text-foreground/50' },
    tar: { icon: FileArchive, color: 'text-foreground/50' },
    gz: { icon: FileArchive, color: 'text-foreground/50' },
    // 字体
    woff: { icon: FileType, color: 'text-foreground/40' },
    woff2: { icon: FileType, color: 'text-foreground/40' },
    ttf: { icon: FileType, color: 'text-foreground/40' },
    otf: { icon: FileType, color: 'text-foreground/40' },
};
export function FileTypeIcon({ filename, size = 13, className }) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const match = EXT_MAP[ext];
    const Icon = match?.icon ?? File;
    const color = match?.color ?? 'text-foreground/40';
    return _jsx(Icon, { size: size, className: cn(color, 'flex-shrink-0', className) });
}
