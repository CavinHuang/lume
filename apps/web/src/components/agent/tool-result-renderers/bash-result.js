import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { HighlightedCode } from './highlighted-code';
import { CollapsibleResult } from './collapsible-result';
export function BashResult({ input, result }) {
    const output = result?.output ?? result?.stdout ?? String(result ?? '');
    const stderr = result?.stderr;
    const command = String(input.command ?? '');
    return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "bg-zinc-950 rounded-lg px-3 py-1.5 font-mono text-[11px] text-zinc-500", children: ["$ ", command] }), output && (_jsx(CollapsibleResult, { content: String(output), previewLines: 20, renderContent: (text) => (_jsx(HighlightedCode, { code: text, language: "shellscript" })) })), stderr && (_jsxs("div", { className: "rounded-lg border border-red-500/20 overflow-hidden", children: [_jsx("div", { className: "px-3 py-1 bg-red-500/10 text-[11px] text-red-400 font-medium", children: "stderr" }), _jsx("pre", { className: "p-3 text-[12px] font-mono leading-relaxed text-red-400 bg-zinc-950 whitespace-pre-wrap break-all", children: stderr })] }))] }));
}
