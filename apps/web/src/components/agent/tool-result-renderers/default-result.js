import { jsx as _jsx } from "react/jsx-runtime";
export function DefaultResult({ input, result }) {
    const text = result === undefined ? JSON.stringify(input, null, 2) : JSON.stringify(result, null, 2);
    return (_jsx("pre", { className: "bg-muted/30 rounded-lg p-3 text-[12px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap", children: text }));
}
