import { jsx as _jsx } from "react/jsx-runtime";
/**
 * TitleBar - Tauri 自定义标题栏
 *
 * 使用 data-tauri-drag-region 属性实现窗口拖拽。
 * macOS 上保留左上角红绿灯按钮空间。
 */
export function TitleBar() {
    return (_jsx("div", { "data-tauri-drag-region": true, className: "fixed top-0 left-0 right-0 h-[50px] z-50 pointer-events-none select-none" }));
}
