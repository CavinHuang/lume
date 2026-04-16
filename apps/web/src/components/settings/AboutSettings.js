import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * AboutSettings - 关于页面
 *
 * 显示应用版本号、运行时信息、开源协议等基本信息。
 */
import { ExternalLink } from 'lucide-react';
import { openExternal } from '@/lib/desktop-api';
import { Separator } from '@/components/ui/separator';
const APP_VERSION = '0.1.0';
const GITHUB_URL = 'https://github.com/anthropics/lume';
export function AboutSettings() {
    return (_jsxs("div", { className: "p-6 space-y-6", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-[15px] font-semibold", children: "\u5173\u4E8E Lume" }), _jsx("p", { className: "text-[12px] text-muted-foreground mt-0.5", children: "\u5F00\u6E90 AI Agent \u684C\u9762\u5BA2\u6237\u7AEF" })] }), _jsxs("div", { className: "rounded-xl border divide-y", children: [_jsx(InfoRow, { label: "\u7248\u672C", value: _jsx("span", { className: "font-mono", children: APP_VERSION }) }), _jsx(InfoRow, { label: "\u8FD0\u884C\u65F6", value: "Tauri 2.0 + React" }), _jsx(InfoRow, { label: "\u5F00\u6E90\u534F\u8BAE", value: "MIT" }), _jsx(InfoRow, { label: "\u9879\u76EE\u5730\u5740", value: _jsxs("button", { onClick: () => openExternal(GITHUB_URL), className: "text-primary hover:underline inline-flex items-center gap-1", children: ["GitHub", _jsx(ExternalLink, { size: 11 })] }) })] }), _jsx(Separator, {}), _jsxs("div", { children: [_jsx("h3", { className: "text-[13px] font-medium mb-3", children: "\u6280\u672F\u6808" }), _jsx("div", { className: "grid grid-cols-2 gap-2", children: [
                            { name: 'Tauri', desc: '桌面框架' },
                            { name: 'React', desc: 'UI 框架' },
                            { name: 'TypeScript', desc: '类型系统' },
                            { name: 'Tailwind CSS', desc: '样式方案' },
                            { name: 'Jotai', desc: '状态管理' },
                            { name: 'shadcn/ui', desc: '组件库' },
                        ].map((tech) => (_jsxs("div", { className: "px-3 py-2 rounded-lg bg-muted/30 text-[12px]", children: [_jsx("span", { className: "font-medium text-foreground/80", children: tech.name }), _jsx("span", { className: "text-muted-foreground/60 ml-1.5", children: tech.desc })] }, tech.name))) })] }), _jsx(Separator, {}), _jsx("div", { className: "text-[12px] text-muted-foreground/60 text-center py-4", children: "Made with Lume Agent SDK" })] }));
}
function InfoRow({ label, value }) {
    return (_jsxs("div", { className: "flex items-center justify-between px-4 py-3", children: [_jsx("span", { className: "text-[13px] text-muted-foreground", children: label }), _jsx("span", { className: "text-[13px] text-foreground", children: value })] }));
}
