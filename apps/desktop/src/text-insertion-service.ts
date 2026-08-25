/**
 * 系统文本插入服务
 *
 * 通过临时写入剪贴板 + 系统级粘贴快捷键，把听写文本送入当前前台应用的光标位置。
 * 粘贴前备份剪贴板全部可读格式，完成后延迟恢复；自动粘贴失败时文本保留在剪贴板兜底。
 *
 * 平台差异：
 * - Windows：PowerShell 内嵌 C# SendInput 注入 Ctrl+V（无需额外依赖）
 * - macOS：osascript System Events 按键（需在系统设置授予辅助功能权限）
 * - Linux：暂不支持
 */

import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { clipboard, systemPreferences, type NativeImage } from 'electron'

const CLIPBOARD_READY_DELAY_MS = 80
// 延迟恢复：给目标应用完成粘贴留出窗口；期间用户若复制了新内容则放弃恢复。
const CLIPBOARD_RESTORE_DELAY_MS = 10_000
const MAC_PASTE_TIMEOUT_MS = 2_000
const WINDOWS_PASTE_TIMEOUT_MS = 3_000

interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  image: NativeImage | null
  buffers: ClipboardBufferSnapshot[]
}

interface ClipboardBufferSnapshot {
  format: string
  buffer: Buffer
}

interface ExecError extends Error {
  code?: unknown
  signal?: unknown
  killed?: boolean
  stderr?: string
}

export interface TextInsertionResult {
  success: boolean
  mode: 'cursor' | 'clipboard'
  message: string
  error?: string
}

/** 优先粘贴到当前光标位置，失败时保留文本在剪贴板。 */
export async function pasteTextAtCurrentCursor(text: string): Promise<TextInsertionResult> {
  const snapshot = captureClipboardSnapshot()
  clipboard.writeText(text)

  try {
    await sleep(CLIPBOARD_READY_DELAY_MS)
    await triggerSystemPaste()
    scheduleClipboardRestore(snapshot, text)
    return {
      success: true,
      mode: 'cursor',
      message: '已写入当前光标位置',
    }
  } catch (error) {
    const message = getErrorMessage(error)
    console.warn('[语音输入] 自动粘贴失败，已保留文本到剪贴板:', message)
    return {
      success: false,
      mode: 'clipboard',
      message: '自动粘贴失败，已复制到剪贴板',
      error: message,
    }
  }
}

function captureClipboardSnapshot(): ClipboardSnapshot {
  const image = clipboard.readImage()
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? null : image,
    buffers: captureClipboardBuffers(),
  }
}

function captureClipboardBuffers(): ClipboardBufferSnapshot[] {
  const snapshots: ClipboardBufferSnapshot[] = []
  for (const format of clipboard.availableFormats()) {
    try {
      const buffer = clipboard.readBuffer(format)
      if (buffer.byteLength > 0) {
        snapshots.push({ format, buffer })
      }
    } catch {
      // 某些系统私有格式无法通过 Electron 读取，跳过即可。
    }
  }
  return snapshots
}

function scheduleClipboardRestore(snapshot: ClipboardSnapshot, insertedText: string): void {
  const timer = setTimeout(() => {
    try {
      // 用户在恢复前复制了别的内容：尊重最新数据，放弃恢复。
      if (clipboard.readText() !== insertedText) return
      restoreClipboardSnapshot(snapshot)
    } catch (error) {
      console.warn('[语音输入] 恢复剪贴板失败:', getErrorMessage(error))
    }
  }, CLIPBOARD_RESTORE_DELAY_MS)
  timer.unref?.()
}

function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): void {
  if (!snapshot.text && !snapshot.html && !snapshot.rtf && !snapshot.image) {
    if (restoreClipboardBuffers(snapshot.buffers)) return
    clipboard.clear()
    return
  }

  clipboard.write({
    text: snapshot.text || undefined,
    html: snapshot.html || undefined,
    rtf: snapshot.rtf || undefined,
    image: snapshot.image || undefined,
  })
}

function restoreClipboardBuffers(buffers: ClipboardBufferSnapshot[]): boolean {
  if (buffers.length === 0) return false

  // Windows 上每次独立的剪贴板写入都是完整 Empty/Set 序列，逐格式写回会互相
  // 清空——只能保住一种：挑最大的 buffer 单次写入，其余格式放弃。
  const largest = buffers.reduce((a, b) => (b.buffer.length > a.buffer.length ? b : a))
  clipboard.clear()
  try {
    clipboard.writeBuffer(largest.format, largest.buffer)
    return true
  } catch {
    return false
  }
}

async function triggerSystemPaste(): Promise<void> {
  if (process.platform === 'darwin') {
    await triggerMacPaste()
    return
  }

  if (process.platform === 'win32') {
    await triggerWindowsPaste()
    return
  }

  throw new Error('当前系统暂不支持自动粘贴')
}

async function triggerMacPaste(): Promise<void> {
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    throw new Error('需要在 macOS 系统设置中允许 Lume 使用辅助功能')
  }

  await execFileAsync(
    '/usr/bin/osascript',
    ['-e', 'tell application "System Events" to keystroke "v" using command down'],
    MAC_PASTE_TIMEOUT_MS,
  )
}

async function triggerWindowsPaste(): Promise<void> {
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_SEND_INPUT_SCRIPT,
    ],
    WINDOWS_PASTE_TIMEOUT_MS,
  )
}

function execFileAsync(file: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const execError = error as ExecError
        execError.stderr = stderr
        reject(execError)
        return
      }
      resolve()
    })
  })
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const execError = error as ExecError
    return execError.stderr?.trim() || error.message
  }
  return String(error)
}

const WINDOWS_SEND_INPUT_SCRIPT = String.raw`
$signature = @"
using System;
using System.Runtime.InteropServices;

public static class LumeKeyboardPaste
{
    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_V = 0x56;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public int type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void Paste()
    {
        INPUT[] inputs = new INPUT[4];

        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki.wVk = VK_CONTROL;

        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki.wVk = VK_V;

        inputs[2].type = INPUT_KEYBOARD;
        inputs[2].U.ki.wVk = VK_V;
        inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;

        inputs[3].type = INPUT_KEYBOARD;
        inputs[3].U.ki.wVk = VK_CONTROL;
        inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;

        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
        {
            throw new InvalidOperationException("SendInput failed: " + Marshal.GetLastWin32Error());
        }
    }
}
"@

Add-Type -TypeDefinition $signature
[LumeKeyboardPaste]::Paste()
`

// 已知限制：前台是高完整性级别（管理员权限）窗口时，UIPI 会静默拦截非提升
// 进程的 SendInput 且返回值仍为"成功"——无法可靠探测。曾尝试用剪贴板序列号
// 验证，但目标应用读取剪贴板粘贴不会递增序列号（只有内容变更才递增），必然
// 误判正常粘贴为失败，已撤销。此场景退化为：文本保留在剪贴板可手动粘贴。
