// renderer IPC 契约单源：主进程（electron-security.ts）与 preload（preload.ts）共用。
// 必须保持零依赖纯 TS——preload 是 sandbox preload，禁止引入任何 node/electron 依赖。
// 新增/删除命令只改这里，双端自动一致。

export const ALLOWED_RENDERER_INVOKE_COMMANDS = new Set([
  'healthcheck',
  'sidecar_healthcheck',
  'sidecar_call',
  'desktop:save-plugin-package',
  'desktop:install-plugin-package',
  'desktop_sync_window_behavior',
  'desktop_renderer_ready',
  'desktop_sync_tray_state',
  'desktop_report_tray_navigation_confirmation_failed',
  'desktop_get_main_window_generation',
  'open_file_dialog',
  'stat_file_paths',
  'attachment_stage_begin',
  'attachment_stage_append',
  'attachment_stage_finish',
  'attachment_stage_abort',
  'open_folder_dialog',
  'open_external',
  'read_clipboard_text',
  'write_clipboard_text',
  'write_clipboard_image',
  'write_web_log',
  'write_web_log_batch',
  'desktop_list_log_files',
  'desktop_read_log_file',
  'desktop_open_logs_dir',
  'desktop_export_logs',
  'desktop_delete_logs',
  'desktop_log_live_subscribe',
  'desktop_log_live_unsubscribe',
  'desktop_diagnostic_status',
  'desktop_diagnostic_start',
  'desktop_diagnostic_stop',
  'desktop_diagnostic_decrypt',
  'desktop_diagnostic_delete',
  'save_text_file_dialog',
  'save_binary_file_dialog',
  'save_file_path_dialog',
  'save_path_as',
  'open_in_system',
  'reveal_path_in_system',
  'open_file_ref',
  'reveal_file_ref',
  'open_guarded_file_ref',
  'reveal_guarded_file_ref',
  'save_guarded_file_ref_as',
  'create_file_preview_scope',
  'create_guarded_file_preview_scope',
  'revoke_file_preview_scope',
  'open_weread_key_webview',
  'quick_input_hide', // Alt+L 快速输入子窗口：隐藏子窗口
  'quick_input_get_context',
  'ack_renderer_delivery',
  'data_get_storage_stats',
  'data_export_zip',
  'data_migrate_to_dir',
  'data_apply_migration',
  'browser_runtime',
  'browser_settings:get',
  'browser_settings:update',
  'browser_import:discover',
  'browser_import:start',
  'browser_import:cancel',
  'connection_vault_status',
  'connection_vault_setup',
  'connection_vault_unlock',
  'connection_vault_verify',
  'connection_vault_reveal_key',
  'agent_island_intent',
  'voice_dictation_get_settings',
  'voice_dictation_update_settings',
  'voice_dictation_test_connection',
  'voice_dictation_start',
  'voice_dictation_audio_chunk',
  'voice_dictation_stop',
  'voice_dictation_cancel',
])

export const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
  'window-state',
  'tray-action',
  'logs:live',
  'browser:event',
  'agent:island:state',
  'voice-dictation:state',
  'voice-dictation:transcript',
])

export function validateRendererInvokeCommand(command) {
  if (typeof command !== 'string' || !ALLOWED_RENDERER_INVOKE_COMMANDS.has(command)) {
    throw new Error(`unsupported desktop command: ${String(command)}`)
  }
  return command
}

export function validateRendererEventChannel(channel) {
  if (typeof channel !== 'string' || !ALLOWED_RENDERER_EVENT_CHANNELS.has(channel)) {
    throw new Error(`unsupported desktop event channel: ${String(channel)}`)
  }
  return channel
}
