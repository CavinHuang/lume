import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { ChevronRight, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
export function SubagentCard({ run }) {
    const [expanded, setExpanded] = useState(false);
    const isRunning = run.status === 'running' || run.status === 'accepted';
    const isError = run.status === 'errored' || run.status === 'timed_out' || run.status === 'aborted';
    const isDone = run.status === 'completed';
    return (_jsxs("div", { className: "rounded-xl border border-border/50 bg-muted/20 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-200", children: [_jsxs("button", { onClick: () => setExpanded((v) => !v), className: "w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left", children: [_jsx(ChevronRight, { size: 13, className: cn('text-foreground/40 transition-transform flex-shrink-0', expanded && 'rotate-90') }), _jsx("span", { className: "flex-1 text-[13px] text-foreground/80 truncate", children: run.label ?? run.task }), isRunning && _jsx(Loader2, { size: 13, className: "animate-spin text-blue-500 flex-shrink-0" }), isDone && _jsx(CheckCircle, { size: 13, className: "text-green-500 flex-shrink-0" }), isError && _jsx(XCircle, { size: 13, className: "text-destructive flex-shrink-0" })] }), expanded && run.outcome && (_jsxs("div", { className: "border-t border-border/30 px-3 py-2", children: [run.outcome.output && (_jsx("p", { className: "text-[12px] text-foreground/60 whitespace-pre-wrap leading-relaxed", children: run.outcome.output })), run.outcome.error && (_jsx("p", { className: "text-[12px] text-destructive whitespace-pre-wrap leading-relaxed", children: run.outcome.error }))] }))] }));
}
