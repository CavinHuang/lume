import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { LeftSidebar } from './LeftSidebar';
import { TitleBar } from './TitleBar';
import { MainArea } from '@/components/tabs/MainArea';
export function AppShell() {
    return (_jsxs("div", { className: "h-screen w-screen flex overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900", children: [_jsx(TitleBar, {}), _jsx("div", { className: "p-2 pr-0 relative z-[60]", children: _jsx(LeftSidebar, {}) }), _jsx("div", { className: "flex-1 min-w-0 p-2 relative z-[60]", children: _jsx(MainArea, {}) })] }));
}
