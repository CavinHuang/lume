import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { ChevronRight, Bot } from 'lucide-react';
import { XMarkdown } from '@ant-design/x-markdown';
import { useSmoothStream } from '@lume/ui';
import { cn } from '@/lib/utils';
import { ToolResultRenderer } from './tool-result-renderers';
/** 从消息流中构建 tool_use_id → tool_result 映射 */
function buildToolResultMap(messages) {
    const map = new Map();
    for (const msg of messages) {
        if (msg.type === 'tool_result' && msg.result) {
            map.set(msg.result.tool_use_id, {
                output: msg.result.output,
                toolName: msg.result.tool_name,
            });
        }
    }
    return map;
}
export function SDKContentBlock({ message, index, animate, allMessages, isStreaming }) {
    const style = animate ? { animationDelay: `${index * 30}ms` } : undefined;
    const cls = animate ? 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both' : '';
    const toolResultMap = useMemo(() => allMessages ? buildToolResultMap(allMessages) : new Map(), [allMessages]);
    if (message.type === 'user') {
        const content = message.message?.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
                ? content.find((b) => b.type === 'text')?.text ?? ''
                : '';
        if (!text)
            return null;
        return (_jsx("div", { className: cn('flex justify-end', cls), style: style, children: _jsx("div", { className: "max-w-[80%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap", children: text }) }));
    }
    if (message.type === 'assistant') {
        const blocks = (message.message?.content ?? []);
        return (_jsxs("div", { className: cn('flex gap-3', cls), style: style, children: [_jsx("div", { className: "size-7 rounded-full bg-foreground/10 flex items-center justify-center flex-shrink-0 mt-0.5", children: _jsx(Bot, { size: 14, className: "text-foreground/60" }) }), _jsx("div", { className: "flex-1 min-w-0 space-y-2", children: blocks.map((block, i) => (_jsx(ContentBlockItem, { block: block, toolResultMap: toolResultMap, isStreaming: animate && isStreaming }, `${block.type}-${i}`))) })] }));
    }
    if (message.type === 'tool_result') {
        return null;
    }
    if (message.type === 'system') {
        const subtype = message.subtype;
        if (subtype === 'compact_boundary') {
            return (_jsxs("div", { className: "flex items-center gap-3 my-4", children: [_jsx("div", { className: "flex-1 h-px bg-border/40" }), _jsx("span", { className: "text-[11px] text-muted-foreground/60 px-2 py-0.5 rounded-full border border-border/30 bg-muted/20", children: "\u4E0A\u4E0B\u6587\u5DF2\u538B\u7F29" }), _jsx("div", { className: "flex-1 h-px bg-border/40" })] }));
        }
        return null;
    }
    return null;
}
function ContentBlockItem({ block, toolResultMap, isStreaming, }) {
    const [collapsed, setCollapsed] = useState(true);
    if (block.type === 'text') {
        return _jsx(SmoothText, { text: block.text, isStreaming: isStreaming });
    }
    if (block.type === 'thinking') {
        return (_jsxs("div", { className: "border-l-2 border-dashed border-foreground/20 pl-3", children: [_jsxs("button", { onClick: () => setCollapsed((v) => !v), className: "flex items-center gap-1 text-[12px] text-foreground/40 hover:text-foreground/60 transition-colors", children: [_jsx(ChevronRight, { size: 12, className: cn('transition-transform', !collapsed && 'rotate-90') }), "\u601D\u8003\u8FC7\u7A0B"] }), !collapsed && (_jsx("p", { className: "mt-1 text-[12px] text-foreground/50 whitespace-pre-wrap leading-relaxed", children: block.thinking }))] }));
    }
    if (block.type === 'tool_use') {
        const toolResult = toolResultMap.get(block.id);
        const hasResult = toolResult !== undefined;
        let resultData = undefined;
        if (toolResult) {
            try {
                resultData = JSON.parse(toolResult.output);
            }
            catch {
                resultData = toolResult.output;
            }
        }
        return (_jsxs("div", { className: "rounded-xl border border-border/50 overflow-hidden bg-muted/20", children: [_jsxs("button", { onClick: () => setCollapsed((v) => !v), className: "w-full flex items-center gap-2 px-3 py-2 text-[12px] text-foreground/60 hover:bg-muted/30 transition-colors", children: [_jsx(ChevronRight, { size: 12, className: cn('transition-transform', !collapsed && 'rotate-90') }), _jsx("span", { className: "font-mono font-medium text-foreground/70", children: block.name }), hasResult && (_jsx("span", { className: "ml-auto text-[10px] text-green-500/70", children: "\u5B8C\u6210" })), !hasResult && (_jsx("span", { className: "ml-auto text-[10px] text-blue-500/70 animate-pulse", children: "\u8FD0\u884C\u4E2D..." }))] }), !collapsed && (_jsx("div", { className: "border-t border-border/30 p-3", children: _jsx(ToolResultRenderer, { toolName: block.name, input: block.input, result: resultData }) }))] }));
    }
    return null;
}
/** 流式文本平滑渲染组件 */
function SmoothText({ text, isStreaming }) {
    const { displayedContent } = useSmoothStream({
        content: text,
        isStreaming: !!isStreaming,
    });
    return (_jsx(XMarkdown, { className: "x-markdown text-[14px] leading-relaxed", children: displayedContent }));
}
