import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * MentionSuggestion - AgentInput 的 mention 下拉建议列表
 *
 * 支持三种 mention 触发：
 * - @ → 文件 mention（从当前线程工作目录列出文件）
 * - / → Skill mention（命令提示）
 * - # → MCP 工具 mention
 */
import { forwardRef, useEffect, useImperativeHandle, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { File, Slash, Hash } from 'lucide-react';
export const MentionList = forwardRef(function MentionList({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    useEffect(() => setSelectedIndex(0), [items]);
    const selectItem = useCallback((index) => {
        const item = items[index];
        if (item)
            command({ id: item.id, label: item.label });
    }, [items, command]);
    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }) => {
            if (event.key === 'ArrowUp') {
                setSelectedIndex((i) => (i + items.length - 1) % items.length);
                return true;
            }
            if (event.key === 'ArrowDown') {
                setSelectedIndex((i) => (i + 1) % items.length);
                return true;
            }
            if (event.key === 'Enter') {
                selectItem(selectedIndex);
                return true;
            }
            return false;
        },
    }));
    if (items.length === 0) {
        return (_jsx("div", { className: "rounded-lg border border-border/60 bg-popover shadow-lg p-2 text-[12px] text-muted-foreground", children: "\u65E0\u5339\u914D\u7ED3\u679C" }));
    }
    const iconMap = {
        file: _jsx(File, { size: 13, className: "text-blue-500" }),
        skill: _jsx(Slash, { size: 13, className: "text-orange-500" }),
        mcp: _jsx(Hash, { size: 13, className: "text-purple-500" }),
    };
    return (_jsx("div", { className: "rounded-lg border border-border/60 bg-popover shadow-lg py-1 max-h-[200px] overflow-y-auto min-w-[200px]", children: items.map((item, index) => (_jsxs("button", { className: cn('w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors', index === selectedIndex
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground/70 hover:bg-muted/50'), onClick: () => selectItem(index), children: [iconMap[item.type], _jsx("span", { className: "truncate", children: item.label })] }, item.id))) }));
});
