import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { TabBar } from './TabBar';
import { TabContent } from './TabContent';
export function MainArea() {
    return (_jsxs("div", { className: "h-full flex flex-col bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl overflow-hidden", children: [_jsx(TabBar, {}), _jsx("div", { className: "flex-1 min-h-0 flex", children: _jsx(TabContent, {}) })] }));
}
