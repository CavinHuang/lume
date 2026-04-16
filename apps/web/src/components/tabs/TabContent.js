import { jsx as _jsx } from "react/jsx-runtime";
import { useAtomValue } from 'jotai';
import { tabsAtom, activeTabIdAtom } from '@/atoms';
import { AgentView } from '@/components/agent/AgentView';
import { SettingsView } from '@/components/settings/SettingsView';
export function TabContent() {
    const tabs = useAtomValue(tabsAtom);
    const activeTabId = useAtomValue(activeTabIdAtom);
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center text-foreground/30 text-sm", children: "\u70B9\u51FB\u5DE6\u4FA7\u300C\u65B0\u4F1A\u8BDD\u300D\u5F00\u59CB" }));
    }
    if (activeTab.type === 'agent' && activeTab.threadId) {
        return _jsx(AgentView, { threadId: activeTab.threadId });
    }
    if (activeTab.type === 'settings') {
        return _jsx(SettingsView, {});
    }
    return null;
}
