import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { FileBrowser } from '@/components/file-browser/FileBrowser';
import { FileDropZone } from '@/components/file-browser/FileDropZone';
import { PlanPanel } from './PlanPanel';
export function SidePanel({ threadId, view }) {
    return (_jsxs("div", { className: "w-72 flex-shrink-0 border-l border-border/50 flex flex-col overflow-hidden", children: [view === 'files' && (_jsxs(_Fragment, { children: [_jsx("div", { className: "flex-1 min-h-0 overflow-y-auto", children: _jsx(FileBrowser, { threadId: threadId }) }), _jsx(FileDropZone, { threadId: threadId })] })), view === 'plan' && _jsx(PlanPanel, { threadId: threadId })] }));
}
