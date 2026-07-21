import { contextBridge, ipcRenderer, webUtils } from 'electron'

const ALLOWED_RENDERER_INVOKE_COMMANDS = new Set([
  'healthcheck',
  'sidecar_healthcheck',
  'sidecar_call',
  'desktop:save-plugin-package',
  'desktop:install-plugin-package',
  'desktop_wiki_get_proposal_summary',
  'desktop_wiki_apply_draft',
  'desktop_wiki_resolve_pending',
  'desktop_wiki_get_undo_summary',
  'desktop_wiki_undo_batch',
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
  'read_text_file',
  'save_text_file_dialog',
  'save_file_path_dialog',
  'write_binary_file',
  'copy_file',
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
])

const ALLOWED_RENDERER_EVENT_CHANNELS = new Set([
  'sidecar:event',
  'data:migrate-progress',
  'update:download',
  'window-state',
  'tray-action',
  'logs:live',
])

function validateRendererInvokeCommand(command) {
  if (typeof command !== 'string' || !ALLOWED_RENDERER_INVOKE_COMMANDS.has(command)) {
    throw new Error(`unsupported desktop command: ${String(command)}`)
  }
  return command
}

function validateRendererEventChannel(channel) {
  if (typeof channel !== 'string' || !ALLOWED_RENDERER_EVENT_CHANNELS.has(channel)) {
    throw new Error(`unsupported desktop event channel: ${String(channel)}`)
  }
  return channel
}

function filePathToFileUrl(path) {
  if (/^(data:|https?:|file:)/i.test(path)) return path
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return encodeURI(`file://${withLeadingSlash}`)
}

function createWindowBridge() {
  return {
    async startDragging() {
      // Electron window dragging is driven by -webkit-app-region: drag.
      // Keep this API as a no-op bridge so the current renderer contract stays stable.
      return null
    },
    async onDragDropEvent(listener) {
      const emit = (payload) => listener(payload)

      const dragEnter = (event: DragEvent) => {
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter(Boolean)
        emit({ type: 'enter', paths })
      }

      const dragOver = (event: DragEvent) => {
        event.preventDefault()
        emit({ type: 'over' })
      }

      const dragLeave = () => {
        emit({ type: 'leave' })
      }

      const drop = (event: DragEvent) => {
        event.preventDefault()
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter(Boolean)
        emit({ type: 'drop', paths })
      }

      window.addEventListener('dragenter', dragEnter)
      window.addEventListener('dragover', dragOver)
      window.addEventListener('dragleave', dragLeave)
      window.addEventListener('drop', drop)

      return () => {
        window.removeEventListener('dragenter', dragEnter)
        window.removeEventListener('dragover', dragOver)
        window.removeEventListener('dragleave', dragLeave)
        window.removeEventListener('drop', drop)
      }
    },
    async minimize() {
      return ipcRenderer.invoke('lume:window-control', 'minimize')
    },
    async toggleMaximize() {
      return ipcRenderer.invoke('lume:window-control', 'toggleMaximize')
    },
    async close() {
      return ipcRenderer.invoke('lume:window-control', 'close')
    },
    async isMaximized() {
      return ipcRenderer.invoke('lume:window-control', 'isMaximized')
    },
    onMaximizeStateChange(listener) {
      const handler = (_event, payload) => listener(payload)
      ipcRenderer.on('lume:event:window-state', handler)
      return () => {
        ipcRenderer.removeListener('lume:event:window-state', handler)
      }
    },
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  invoke(command, payload) {
    return ipcRenderer.invoke('lume:invoke', validateRendererInvokeCommand(command), payload)
  },
  listen(channel, listener) {
    const safeChannel = validateRendererEventChannel(channel)
    const eventName = `lume:event:${safeChannel}`
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on(eventName, handler)
    return () => {
      ipcRenderer.removeListener(eventName, handler)
    }
  },
  convertFileSrc(path) {
    return filePathToFileUrl(path)
  },
  relaunch() {
    return ipcRenderer.invoke('lume:relaunch')
  },
  async checkForUpdate() {
    const info = await ipcRenderer.invoke('lume:update:check')
    if (!info) return null
    return {
      ...info,
      async download(onEvent) {
        const handler = (_event, payload) => onEvent?.(payload)
        ipcRenderer.on('lume:event:update:download', handler)
        try {
          await ipcRenderer.invoke('lume:update:download')
        } finally {
          ipcRenderer.removeListener('lume:event:update:download', handler)
        }
      },
      async install() {
        await ipcRenderer.invoke('lume:update:install')
      },
    }
  },
  async downloadUpdateAsset(url, onEvent) {
    const handler = (_event, payload) => onEvent?.(payload)
    ipcRenderer.on('lume:event:update:download', handler)
    try {
      await ipcRenderer.invoke('lume:update:download-asset', { url })
    } finally {
      ipcRenderer.removeListener('lume:event:update:download', handler)
    }
  },
  async installUpdate() {
    await ipcRenderer.invoke('lume:update:install')
  },
  window: createWindowBridge(),
})
