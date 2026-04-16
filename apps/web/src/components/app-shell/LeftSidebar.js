import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useAtom, useAtomValue } from 'jotai';
import { Plus, Settings, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { agentThreadsAtom, agentStreamingStatesAtom, sidebarCollapsedAtom, tabsAtom, activeTabIdAtom, } from '@/atoms';
import { sidecarCall } from '@/lib/desktop-api';
import { useEffect } from 'react';
function groupByDate(items) {
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const yesterdayStart = todayStart - 86400000;
    const today = [];
    const yesterday = [];
    const earlier = [];
    for (const item of items) {
        if (item.updatedAt >= todayStart)
            today.push(item);
        else if (item.updatedAt >= yesterdayStart)
            yesterday.push(item);
        else
            earlier.push(item);
    }
    return [
        ...(today.length ? [{ label: '今天', items: today }] : []),
        ...(yesterday.length ? [{ label: '昨天', items: yesterday }] : []),
        ...(earlier.length ? [{ label: '更早', items: earlier }] : []),
    ];
}
export function LeftSidebar() {
    const [threads, setThreads] = useAtom(agentThreadsAtom);
    const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);
    const [tabs, setTabs] = useAtom(tabsAtom);
    const streamingStates = useAtomValue(agentStreamingStatesAtom);
    const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
    useEffect(() => {
        sidecarCall('agent:list-threads', {})
            .then((r) => setThreads(r.threads ?? []))
            .catch(console.error);
    }, [setThreads]);
    const openThread = (thread) => {
        setActiveTabId(thread.id);
        if (!tabs.find((t) => t.id === thread.id)) {
            setTabs((prev) => [...prev, { id: thread.id, type: 'agent', title: thread.title, threadId: thread.id }]);
        }
    };
    const handleNewThread = async () => {
        const meta = await sidecarCall('agent:create-thread', {});
        setThreads((prev) => [meta, ...prev]);
        setTabs((prev) => [...prev, { id: meta.id, type: 'agent', title: meta.title, threadId: meta.id }]);
        setActiveTabId(meta.id);
    };
    const openSettings = () => {
        const id = '__settings__';
        setActiveTabId(id);
        if (!tabs.find((t) => t.id === id)) {
            setTabs((prev) => [...prev, { id, type: 'settings', title: '设置' }]);
        }
    };
    const groups = groupByDate(threads);
    if (collapsed) {
        return (_jsxs("div", { className: "h-full flex flex-col items-center bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl", style: { width: 48, flexShrink: 0 }, children: [_jsx("div", { className: "pt-[50px]" }), _jsx("button", { onClick: () => setCollapsed(false), className: "p-2 mt-2 rounded-[10px] text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground transition-colors", children: _jsx(PanelLeftOpen, { size: 18 }) }), _jsx("button", { onClick: handleNewThread, className: "p-2 mt-2 rounded-[10px] text-foreground/70 bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors border border-dashed border-foreground/10", children: _jsx(Plus, { size: 16 }) }), _jsx("div", { className: "flex-1" }), _jsx("button", { onClick: openSettings, className: "p-2 mb-3 rounded-[10px] text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground transition-colors", children: _jsx(Settings, { size: 16 }) })] }));
    }
    return (_jsxs("div", { className: "h-full flex flex-col bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl", style: { width: 260, minWidth: 180, flexShrink: 1 }, children: [_jsxs("div", { className: "pt-[50px] flex items-center justify-between px-3 pr-1", children: [_jsx("span", { className: "text-[13px] font-semibold text-foreground/70", children: "Lume" }), _jsx("button", { onClick: () => setCollapsed(true), className: "size-8 flex items-center justify-center rounded-[10px] text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/60 transition-colors", children: _jsx(PanelLeftClose, { size: 16 }) })] }), _jsx("div", { className: "px-3 pt-2", children: _jsxs("button", { onClick: handleNewThread, className: "w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-medium text-foreground/70 bg-foreground/[0.04] hover:bg-foreground/[0.08] transition-colors border border-dashed border-foreground/10 hover:border-foreground/20", children: [_jsx(Plus, { size: 14 }), _jsx("span", { children: "\u65B0\u4F1A\u8BDD" })] }) }), _jsx("div", { className: "flex-1 overflow-y-auto px-3 pt-2 pb-3 scrollbar-none", children: groups.map((group) => (_jsxs("div", { className: "mb-1", children: [_jsx("div", { className: "px-3 pt-2 pb-1 text-[11px] font-medium text-foreground/40 select-none", children: group.label }), group.items.map((thread) => {
                            const isActive = activeTabId === thread.id;
                            const isRunning = streamingStates[thread.id] === 'streaming';
                            return (_jsxs("button", { onClick: () => openThread(thread), className: cn('w-full flex items-center gap-2 px-3 py-[7px] rounded-[10px] transition-colors duration-100 text-left text-[13px]', isActive
                                    ? 'bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]'
                                    : 'text-foreground/80 hover:bg-foreground/[0.04]'), children: [isRunning && (_jsxs("span", { className: "relative flex-shrink-0 size-2", children: [_jsx("span", { className: "absolute inset-0 rounded-full bg-blue-500/60 animate-ping" }), _jsx("span", { className: "relative block size-2 rounded-full bg-blue-500" })] })), _jsx("span", { className: "truncate", children: thread.title })] }, thread.id));
                        })] }, group.label))) }), _jsx("div", { className: "px-3 pb-3", children: _jsxs("button", { onClick: openSettings, className: "w-full flex items-center gap-3 px-3 py-2 rounded-[10px] transition-colors text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground text-[13px]", children: [_jsx(Settings, { size: 15 }), _jsx("span", { children: "\u8BBE\u7F6E" })] }) })] }));
}
