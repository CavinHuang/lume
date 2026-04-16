import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AlertTriangle, X, RotateCcw } from 'lucide-react';
import { useAtomValue, useSetAtom } from 'jotai';
import { agentErrorMessagesAtom, agentStreamingStatesAtom } from '@/atoms';
import { agentSend } from '@/lib/desktop-api';
export function ErrorBanner({ threadId }) {
    const errorMessages = useAtomValue(agentErrorMessagesAtom);
    const setErrorMessages = useSetAtom(agentErrorMessagesAtom);
    const setStreamingStates = useSetAtom(agentStreamingStatesAtom);
    const errorMsg = errorMessages[threadId];
    const handleDismiss = () => {
        setErrorMessages((prev) => {
            const next = { ...prev };
            delete next[threadId];
            return next;
        });
        setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }));
    };
    const handleRetry = async () => {
        handleDismiss();
        await agentSend({ threadId, userMessage: '请继续' });
    };
    return (_jsx("div", { className: "mx-4 mb-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3", children: _jsxs("div", { className: "flex items-start gap-2.5", children: [_jsx(AlertTriangle, { size: 16, className: "text-destructive mt-0.5 flex-shrink-0" }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-[13px] font-medium text-destructive", children: "\u8FD0\u884C\u51FA\u9519" }), errorMsg && (_jsx("p", { className: "text-[12px] text-destructive/70 mt-0.5 break-words", children: errorMsg }))] }), _jsxs("div", { className: "flex items-center gap-1 flex-shrink-0", children: [_jsx("button", { onClick: handleRetry, className: "p-1 rounded-md text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors", title: "\u91CD\u8BD5", children: _jsx(RotateCcw, { size: 14 }) }), _jsx("button", { onClick: handleDismiss, className: "p-1 rounded-md text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors", title: "\u5173\u95ED", children: _jsx(X, { size: 14 }) })] })] }) }));
}
