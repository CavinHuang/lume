import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { FileTypeIcon } from './FileTypeIcon';
import { cn } from '@/lib/utils';
import { sidecarCall } from '@/lib/desktop-api';
export function FileBrowser({ threadId }) {
    const [entries, setEntries] = useState([]);
    useEffect(() => {
        sidecarCall('agent:list-directory', { threadId, path: '.' })
            .then((r) => setEntries(r.entries ?? []))
            .catch(console.error);
    }, [threadId]);
    return (_jsxs("div", { className: "flex flex-col h-full", children: [_jsx("div", { className: "px-3 py-2.5 border-b border-border/50 text-[12px] font-medium text-foreground/60", children: "\u6587\u4EF6\u6D4F\u89C8\u5668" }), _jsx("div", { className: "flex-1 overflow-y-auto px-2 py-2 scrollbar-none", children: entries.map((entry) => (_jsx(FileTreeItem, { entry: entry, depth: 0, threadId: threadId }, entry.path))) })] }));
}
function FileTreeItem({ entry, depth, threadId }) {
    const [open, setOpen] = useState(false);
    const [children, setChildren] = useState([]);
    const toggle = async () => {
        if (!entry.isDirectory)
            return;
        if (!open && children.length === 0) {
            const r = await sidecarCall('agent:list-directory', { threadId, path: entry.path });
            setChildren(r.entries ?? []);
        }
        setOpen((v) => !v);
    };
    return (_jsxs("div", { children: [_jsxs("button", { onClick: toggle, className: "w-full flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors text-left", style: { paddingLeft: `${8 + depth * 12}px` }, children: [entry.isDirectory
                        ? _jsx(ChevronRight, { size: 12, className: cn('text-foreground/40 transition-transform flex-shrink-0', open && 'rotate-90') })
                        : _jsx("span", { className: "w-3 flex-shrink-0" }), entry.isDirectory
                        ? _jsx(Folder, { size: 13, className: "text-foreground/50 flex-shrink-0" })
                        : _jsx(FileTypeIcon, { filename: entry.name, size: 13 }), _jsx("span", { className: "text-[12px] text-foreground/70 truncate", children: entry.name })] }), open && children.map((child) => (_jsx(FileTreeItem, { entry: child, depth: depth + 1, threadId: threadId }, child.path)))] }));
}
