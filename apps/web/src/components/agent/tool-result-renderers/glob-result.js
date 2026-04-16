import { jsx as _jsx } from "react/jsx-runtime";
export function GlobResult({ result }) {
    const files = result?.files ?? result?.paths ?? [];
    return (_jsx("div", { className: "bg-muted/30 rounded-lg p-3 font-mono text-[12px] space-y-0.5 max-h-60 overflow-y-auto", children: files.map((f, i) => (_jsx("div", { className: "text-foreground/70", children: f }, i))) }));
}
