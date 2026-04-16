import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useSetAtom } from 'jotai';
import { ShieldAlert, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import { agentPendingInteractiveAtom } from '@/atoms';
import { sidecarCall } from '@/lib/desktop-api';
const riskIcon = { low: Shield, medium: ShieldAlert, high: ShieldAlert };
const riskColor = {
    low: 'border-blue-500/30 bg-blue-500/5',
    medium: 'border-yellow-500/30 bg-yellow-500/5',
    high: 'border-red-500/30 bg-red-500/5',
};
export function PermissionBanner({ threadId, request }) {
    const setPending = useSetAtom(agentPendingInteractiveAtom);
    const respond = async (decision) => {
        await sidecarCall('agent:submit-tool-permission', { threadId, requestId: request.requestId, decision });
        setPending((prev) => {
            const next = { ...prev };
            if (next[threadId])
                next[threadId] = { ...next[threadId], toolPermission: undefined };
            return next;
        });
    };
    const Icon = riskIcon[request.risk];
    return (_jsxs("div", { className: cn('animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 rounded-xl border bg-card shadow-lg', riskColor[request.risk]), children: [_jsxs("div", { className: "flex items-start gap-3 p-3", children: [_jsx(Icon, { size: 16, className: "mt-0.5 flex-shrink-0 text-foreground/60" }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("p", { className: "text-[13px] font-medium text-foreground", children: request.toolName }), _jsx("p", { className: "text-[12px] text-foreground/60 mt-0.5", children: request.reason })] })] }), _jsxs("div", { className: "flex items-center gap-2 px-3 pb-3", children: [_jsx("button", { onClick: () => respond('allow_once'), className: "px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity", children: "\u5141\u8BB8\u4E00\u6B21" }), _jsx("button", { onClick: () => respond('allow_always'), className: "px-3 py-1.5 rounded-lg bg-muted text-foreground/70 text-[12px] hover:bg-muted/80 transition-colors", children: "\u59CB\u7EC8\u5141\u8BB8" }), _jsx("button", { onClick: () => respond('deny'), className: "px-3 py-1.5 rounded-lg text-destructive text-[12px] hover:bg-destructive/10 transition-colors", children: "\u62D2\u7EDD" })] })] }));
}
