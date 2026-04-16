import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { sidecarCall } from '@/lib/desktop-api';
import { CheckCheck, X } from 'lucide-react';
export function ExitPlanModeBanner({ threadId }) {
    const approve = () => sidecarCall('agent:send-thread-message', { threadId, userMessage: '', permissionMode: 'acceptEdits' });
    const cancel = () => sidecarCall('agent:stop-thread', { threadId });
    return (_jsx("div", { className: "animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 rounded-xl border border-primary/30 bg-primary/5 shadow-lg", children: _jsxs("div", { className: "flex items-center justify-between px-3 py-2.5", children: [_jsx("p", { className: "text-[13px] text-foreground/80", children: "Plan \u5DF2\u5C31\u7EEA\uFF0C\u662F\u5426\u5F00\u59CB\u6267\u884C\uFF1F" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("button", { onClick: approve, className: "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity", children: [_jsx(CheckCheck, { size: 13 }), "\u6279\u51C6\u6267\u884C"] }), _jsx("button", { onClick: cancel, className: "p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors", children: _jsx(X, { size: 14 }) })] })] }) }));
}
