import { describe, expect, test } from "bun:test";
import {
  shouldBlockDesktopAutomationFallback,
  withDesktopAutomationFallbackGuard,
} from "./desktop-automation-fallback-guard";

describe("desktop automation fallback guard", () => {
  test("blocks shell-driven desktop input after the sky surface is selected", () => {
    for (const command of [
      "powershell -Command \"[System.Windows.Forms.SendKeys]::SendWait('hello')\"",
      "powershell -Command \"$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('x')\"",
      "python -c \"import pyautogui; pyautogui.click(10, 20)\"",
      "python -c \"import ctypes; ctypes.windll.user32.keybd_event(65,0,0,0)\"",
      "node -e \"require('robotjs').keyTap('enter')\"",
    ]) {
      expect(shouldBlockDesktopAutomationFallback({
        command,
        computerUseActive: true,
        originalUserInstruction: "在微信输入 hello",
      })).toBeTrue();
    }
  });

  test("does not block normal build/search commands or inactive Computer Use", () => {
    expect(shouldBlockDesktopAutomationFallback({
      command: "rg SendInput crates/lume-desktop-host",
      computerUseActive: true,
      originalUserInstruction: "在微信输入 hello",
    })).toBeFalse();
    expect(shouldBlockDesktopAutomationFallback({
      command: "python -c \"import pyautogui; pyautogui.click(1, 2)\"",
      computerUseActive: false,
      originalUserInstruction: "运行这个脚本",
    })).toBeFalse();
  });

  test("allows explicit development and debugging of desktop automation code", () => {
    for (const originalUserInstruction of [
      "调试 Windows Computer Use 底层自动化代码",
      "Computer Use 底层自动化代码需要调试",
    ]) {
      expect(shouldBlockDesktopAutomationFallback({
        command: "python -c \"import ctypes; ctypes.windll.user32.SendInput(...)\"",
        computerUseActive: true,
        originalUserInstruction,
      })).toBeFalse();
    }
  });

  test("returns a tool error before invoking Bash", async () => {
    let calls = 0;
    const guarded = withDesktopAutomationFallbackGuard({
      name: "Bash",
      description: "",
      inputSchema: { type: "object", properties: {} },
      async call() {
        calls += 1;
        return { type: "tool_result", tool_use_id: "", content: "ok" };
      },
    }, {
      computerUseActive: true,
      originalUserInstruction: "在微信输入 hello",
    });

    const result = await guarded.call(
      { command: "python -c \"import pyautogui; pyautogui.click(1, 2)\"" },
      { cwd: "C:/workspace", toolUseId: "tool-1" },
    );

    expect(result).toMatchObject({ is_error: true, tool_use_id: "tool-1" });
    expect(calls).toBe(0);
  });
});
