import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useAtom, useAtomValue } from 'jotai';
import { FolderOpen, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import { agentSidePanelViewAtom, agentThreadsAtom } from '@/atoms';
export function AgentHeader({ threadId }) {
    const threads = useAtomValue(agentThreadsAtom);
    const thread = threads.find((t) => t.id === threadId);
    const [sidePanelViews, setSidePanelViews] = useAtom(agentSidePanelViewAtom);
    const currentView = sidePanelViews[threadId] ?? null;
    const toggle = (view) => {
        setSidePanelViews((prev) => {
            const next = { ...prev };
            // 保留最近 50 个
            const keys = Object.keys(next);
            if (keys.length > 50)
                delete next[keys[0]];
            next[threadId] = next[threadId] === view ? null : view;
            return next;
        });
    };
    return (_jsxs("div", { className: "flex items-center justify-between px-4 py-3 border-b border-border/50", children: [_jsx("span", { className: "text-[14px] font-medium text-foreground truncate", children: thread?.title ?? '新会话' }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => toggle('files'), className: cn('p-1.5 rounded-lg transition-colors', currentView === 'files'
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.04]'), title: "\u6587\u4EF6\u6D4F\u89C8\u5668", children: _jsx(FolderOpen, { size: 16 }) }), _jsx("button", { onClick: () => toggle('plan'), className: cn('p-1.5 rounded-lg transition-colors', currentView === 'plan'
                            ? 'bg-foreground/10 text-foreground'
                            : 'text-foreground/40 hover:text-foreground/70 hover:bg-foreground/[0.04]'), title: "Plan \u6B65\u9AA4", children: _jsx(ListTodo, { size: 16 }) })] })] }));
}
