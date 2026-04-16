import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Radio, Cpu, Puzzle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChannelSettings } from './ChannelSettings';
import { AgentSettings } from './AgentSettings';
import { McpSettings } from './McpSettings';
import { AboutSettings } from './AboutSettings';
const NAV = [
    { id: 'channels', label: '渠道', icon: _jsx(Radio, { size: 15 }) },
    { id: 'agent', label: 'Agent', icon: _jsx(Cpu, { size: 15 }) },
    { id: 'mcp', label: 'MCP', icon: _jsx(Puzzle, { size: 15 }) },
    { id: 'about', label: '关于', icon: _jsx(Info, { size: 15 }) },
];
export function SettingsView() {
    const [tab, setTab] = useState('channels');
    return (_jsxs("div", { className: "flex-1 flex min-h-0", children: [_jsxs("div", { className: "w-48 flex-shrink-0 border-r border-border/50 p-3 space-y-0.5", children: [_jsx("p", { className: "px-3 py-2 text-[11px] font-semibold text-foreground/40 uppercase tracking-wider", children: "\u8BBE\u7F6E" }), NAV.map((item) => (_jsxs("button", { onClick: () => setTab(item.id), className: cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-[13px] transition-colors', tab === item.id
                            ? 'bg-foreground/[0.08] text-foreground font-medium'
                            : 'text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground'), children: [item.icon, item.label] }, item.id)))] }), _jsxs("div", { className: "flex-1 min-w-0 overflow-y-auto", children: [tab === 'channels' && _jsx(ChannelSettings, {}), tab === 'agent' && _jsx(AgentSettings, {}), tab === 'mcp' && _jsx(McpSettings, {}), tab === 'about' && _jsx(AboutSettings, {})] })] }));
}
