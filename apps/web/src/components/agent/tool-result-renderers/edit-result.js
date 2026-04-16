import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function EditResult({ input, result }) {
    const filePath = String(input.file_path ?? '');
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    // 如果后端返回了 patch，直接用 patch
    const patch = result?.patch;
    return (_jsxs("div", { className: "rounded-lg overflow-hidden border border-border/40", children: [_jsx("div", { className: "px-3 py-1.5 text-[11px] text-foreground/50 bg-muted/40 font-mono truncate", children: filePath }), patch ? (_jsx(DiffView, { lines: patch.split('\n') })) : (_jsxs("div", { className: "divide-y divide-border/30", children: [oldStr && (_jsxs("div", { className: "bg-red-500/5", children: [_jsx("div", { className: "px-3 py-1 text-[10px] font-medium text-red-500/60", children: "\u5220\u9664" }), _jsx("pre", { className: "px-3 pb-2 text-[12px] font-mono leading-relaxed text-red-600 dark:text-red-400 whitespace-pre-wrap", children: oldStr })] })), newStr && (_jsxs("div", { className: "bg-green-500/5", children: [_jsx("div", { className: "px-3 py-1 text-[10px] font-medium text-green-500/60", children: "\u6DFB\u52A0" }), _jsx("pre", { className: "px-3 pb-2 text-[12px] font-mono leading-relaxed text-green-600 dark:text-green-400 whitespace-pre-wrap", children: newStr })] }))] }))] }));
}
function DiffView({ lines }) {
    return (_jsx("pre", { className: "p-3 text-[12px] font-mono leading-relaxed overflow-x-auto", style: { backgroundColor: '#24292e' }, children: lines.map((line, i) => (_jsx("div", { className: line.startsWith('+') ? 'text-green-400 bg-green-500/10' :
                line.startsWith('-') ? 'text-red-400 bg-red-500/10' :
                    line.startsWith('@@') ? 'text-blue-400' :
                        'text-zinc-400', children: line }, i))) }));
}
