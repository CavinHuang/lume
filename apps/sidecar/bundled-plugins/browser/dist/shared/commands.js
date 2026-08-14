export const READ_ONLY_CDP_METHODS = new Set([
    "DOMSnapshot.captureSnapshot", "DOM.getDocument", "DOM.describeNode", "DOM.getBoxModel", "Runtime.evaluate", "Page.captureScreenshot", "Page.getLayoutMetrics", "Page.getNavigationHistory", "Log.enable", "Log.clear", "Network.getResponseBody"
]);
export const MUTATING_CDP_METHODS = new Set([
    "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.navigate", "Page.navigateToHistoryEntry", "Page.reload", "Page.setInterceptFileChooserDialog", "DOM.setFileInputFiles", "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride"
]);
export const HIGH_RISK_COMMANDS = [
    "browser_user_history", "bookmarks_create", "downloads_remove", "tab_clipboard_write", "tab_clipboard_write_text", "playwright_file_chooser_set_files", "playwright_locator_set_checked", "playwright_locator_check", "playwright_locator_uncheck", "cua_download_media", "dom_cua_download_media", "playwright_locator_download_media"
];
