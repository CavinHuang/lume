import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 可折叠长内容包装器
 *
 * - 短内容直接展示
 * - 长内容默认折叠，显示前 N 行 + 长度指示器
 * - 点击展开/收起全部内容
 */
import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
export function CollapsibleResult({ content, threshold = 3000, previewLines = 15, renderContent, className, }) {
    const [expanded, setExpanded] = React.useState(false);
    const needsCollapse = content.length > threshold;
    const displayContent = React.useMemo(() => {
        if (!needsCollapse || expanded)
            return content;
        const lines = content.split('\n');
        if (lines.length <= previewLines)
            return content;
        return lines.slice(0, previewLines).join('\n');
    }, [content, needsCollapse, expanded, previewLines]);
    return (_jsxs("div", { className: cn('relative', className), children: [renderContent(displayContent), needsCollapse && (_jsx("button", { type: "button", onClick: () => setExpanded(!expanded), className: "flex items-center gap-1 mt-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground/80 transition-colors", children: expanded ? (_jsxs(_Fragment, { children: [_jsx(ChevronUp, { className: "size-3" }), "\u6536\u8D77"] })) : (_jsxs(_Fragment, { children: [_jsx(ChevronDown, { className: "size-3" }), "\u663E\u793A\u5168\u90E8 (", content.length.toLocaleString(), " \u5B57\u7B26, ", content.split('\n').length, " \u884C)"] })) }))] }));
}
