import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useAtom } from 'jotai';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tabsAtom, activeTabIdAtom } from '@/atoms';
export function TabBar() {
    const [tabs, setTabs] = useAtom(tabsAtom);
    const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);
    const closeTab = (id, e) => {
        e.stopPropagation();
        setTabs((prev) => prev.filter((t) => t.id !== id));
        if (activeTabId === id) {
            const remaining = tabs.filter((t) => t.id !== id);
            setActiveTabId(remaining.at(-1)?.id ?? null);
        }
    };
    if (tabs.length === 0)
        return null;
    return (_jsx("div", { className: "flex items-center gap-1 px-2 pt-2 overflow-x-auto scrollbar-none", children: tabs.map((tab) => (_jsxs("button", { onClick: () => setActiveTabId(tab.id), className: cn('flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-[13px] whitespace-nowrap transition-colors', activeTabId === tab.id
                ? 'bg-white dark:bg-zinc-800 text-foreground shadow-sm'
                : 'text-foreground/60 hover:text-foreground hover:bg-white/50 dark:hover:bg-zinc-800/50'), children: [_jsx("span", { className: "max-w-[140px] truncate", children: tab.title }), _jsx("span", { role: "button", onClick: (e) => closeTab(tab.id, e), className: "size-4 flex items-center justify-center rounded hover:bg-foreground/10 text-foreground/40 hover:text-foreground/70", children: _jsx(X, { size: 11 }) })] }, tab.id))) }));
}
