import { jsx as _jsx } from "react/jsx-runtime";
export function GrepResult({ result }) {
    const output = String(result?.output ?? result ?? '');
    const lines = output.split('\n').filter(Boolean);
    return (_jsx("div", { className: "bg-muted/30 rounded-lg p-3 font-mono text-[12px] space-y-0.5 max-h-60 overflow-y-auto", children: lines.map((line, i) => (_jsx("div", { className: "text-foreground/70 leading-relaxed", children: line }, i))) }));
}
