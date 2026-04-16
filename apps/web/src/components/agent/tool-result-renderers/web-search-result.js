import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * WebSearch 工具结果渲染器
 *
 * 将搜索结果渲染为卡片列表（title + URL + snippet）
 */
import { ExternalLink, Globe } from 'lucide-react';
import { openExternal } from '@/lib/desktop-api';
function parseResults(result) {
    if (!result)
        return [];
    if (typeof result === 'string') {
        try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed))
                return parsed;
            if (parsed.results && Array.isArray(parsed.results))
                return parsed.results;
            return [parsed];
        }
        catch {
            return [];
        }
    }
    if (Array.isArray(result))
        return result;
    if (typeof result === 'object' && result !== null) {
        const obj = result;
        if (Array.isArray(obj.results))
            return obj.results;
        return [obj];
    }
    return [];
}
export function WebSearchResult({ input, result }) {
    const query = input.query ?? '';
    const items = parseResults(result);
    return (_jsxs("div", { className: "space-y-2", children: [query && (_jsxs("div", { className: "flex items-center gap-2 text-[12px] text-muted-foreground", children: [_jsx(Globe, { size: 12 }), _jsxs("span", { children: ["\u641C\u7D22: ", query] })] })), items.length === 0 ? (_jsx("div", { className: "text-[12px] text-muted-foreground/60", children: "\u65E0\u641C\u7D22\u7ED3\u679C" })) : (_jsx("div", { className: "space-y-1.5", children: items.map((item, i) => (_jsx("button", { onClick: () => item.url && openExternal(item.url), className: "w-full text-left px-3 py-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors group", children: _jsxs("div", { className: "flex items-start gap-2", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "text-[12px] font-medium text-foreground/90 truncate group-hover:text-primary transition-colors", children: item.title ?? item.url ?? `结果 ${i + 1}` }), item.url && (_jsx("div", { className: "text-[10px] text-muted-foreground/60 truncate mt-0.5", children: item.url })), (item.snippet ?? item.description) && (_jsx("div", { className: "text-[11px] text-muted-foreground mt-1 line-clamp-2", children: item.snippet ?? item.description }))] }), _jsx(ExternalLink, { size: 11, className: "text-muted-foreground/40 mt-0.5 shrink-0 group-hover:text-primary/60" })] }) }, i))) }))] }));
}
