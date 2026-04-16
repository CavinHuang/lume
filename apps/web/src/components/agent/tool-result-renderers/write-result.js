import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { CheckCircle } from 'lucide-react';
export function WriteResult({ input }) {
    return (_jsxs("div", { className: "flex items-center gap-2 px-3 py-2 text-[13px] text-green-600 dark:text-green-400", children: [_jsx(CheckCircle, { size: 14 }), _jsx("span", { className: "font-mono text-[12px]", children: String(input.file_path ?? '') })] }));
}
