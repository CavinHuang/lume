import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * HighlightedCode - 工具结果渲染器用的代码高亮组件
 *
 * 基于 @lume/ui 的 Shiki 高亮服务，提供语法高亮和复制按钮。
 * 比 CodeBlock 更轻量，直接接收 code + language 而非 react-markdown children。
 */
import * as React from 'react';
import { highlightCode, highlightToTokens } from '@lume/ui';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
const THROTTLE_MS = 80;
const CodeLine = React.memo(function CodeLine({ tokens, rawLine }) {
    const tokenLen = tokens.reduce((sum, t) => sum + t.content.length, 0);
    return (_jsxs("span", { className: "line", children: [tokens.map((token, i) => (_jsx("span", { style: token.color ? { color: token.color } : undefined, children: token.content }, i))), tokenLen < rawLine.length && _jsx("span", { children: rawLine.slice(tokenLen) })] }));
});
export function HighlightedCode({ code, language = 'text', maxLines, showLineNumbers = false, className, }) {
    const [copied, setCopied] = React.useState(false);
    const [expanded, setExpanded] = React.useState(false);
    const trimmedCode = code.replace(/\n$/, '');
    const rawLines = React.useMemo(() => trimmedCode.split('\n'), [trimmedCode]);
    const needsTruncation = maxLines !== undefined && rawLines.length > maxLines && !expanded;
    const displayLines = needsTruncation ? rawLines.slice(0, maxLines) : rawLines;
    // Shiki token 高亮
    const [tokenResult, setTokenResult] = React.useState(() => highlightToTokens({ code: trimmedCode, language }));
    const pendingCodeRef = React.useRef(trimmedCode);
    const timerRef = React.useRef(null);
    const lastUpdateRef = React.useRef(Date.now());
    pendingCodeRef.current = trimmedCode;
    React.useEffect(() => {
        const now = Date.now();
        const elapsed = now - lastUpdateRef.current;
        const doHighlight = () => {
            const result = highlightToTokens({ code: pendingCodeRef.current, language });
            if (result) {
                lastUpdateRef.current = Date.now();
                setTokenResult(result);
            }
        };
        const syncResult = highlightToTokens({ code: trimmedCode, language });
        if (syncResult) {
            if (elapsed >= THROTTLE_MS) {
                lastUpdateRef.current = now;
                setTokenResult(syncResult);
            }
            else if (!timerRef.current) {
                timerRef.current = setTimeout(() => {
                    timerRef.current = null;
                    doHighlight();
                }, THROTTLE_MS - elapsed);
            }
            return;
        }
        let cancelled = false;
        highlightCode({ code: trimmedCode, language })
            .then(() => { if (!cancelled)
            doHighlight(); })
            .catch((err) => console.error('[HighlightedCode] 高亮失败:', err));
        return () => { cancelled = true; };
    }, [trimmedCode, language]);
    React.useEffect(() => {
        return () => { if (timerRef.current)
            clearTimeout(timerRef.current); };
    }, []);
    const handleCopy = React.useCallback(async () => {
        try {
            await navigator.clipboard.writeText(trimmedCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
        catch (err) {
            console.error('[HighlightedCode] 复制失败:', err);
        }
    }, [trimmedCode]);
    return (_jsxs("div", { className: cn('rounded-lg overflow-hidden border border-border/40 group/code', className), children: [_jsx("div", { className: "flex items-center justify-end h-[28px] px-2 bg-muted/40", children: _jsxs("button", { type: "button", onClick: handleCopy, className: "flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors", children: [copied ? _jsx(Check, { size: 12 }) : _jsx(Copy, { size: 12 }), _jsx("span", { children: copied ? '已复制' : '复制' })] }) }), _jsx("pre", { className: "overflow-x-auto p-3 m-0 text-[12px] leading-[1.6]", style: {
                    backgroundColor: tokenResult?.bgColor ?? '#24292e',
                    color: tokenResult?.fgColor ?? '#e1e4e8',
                }, children: _jsx("code", { children: displayLines.map((rawLine, i) => (_jsxs(React.Fragment, { children: [i > 0 && '\n', showLineNumbers && (_jsx("span", { className: "inline-block w-8 text-right mr-3 select-none opacity-40", children: i + 1 })), _jsx(CodeLine, { tokens: tokenResult?.lines[i] ?? [], rawLine: rawLine })] }, i))) }) }), needsTruncation && (_jsxs("button", { onClick: () => setExpanded(true), className: "w-full py-1.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 transition-colors text-center", children: ["\u663E\u793A\u5269\u4F59 ", rawLines.length - maxLines, " \u884C"] }))] }));
}
