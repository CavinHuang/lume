import type { ToolDefinition } from "@lume/agent-sdk";

const DEVELOPMENT_ACTION = "(?:开发|调试|实现|修复|测试|编写|develop|debug|implement|fix|test)";
const AUTOMATION_SUBJECT = "(?:computer\\s*use|桌面自动化|底层自动化|sendinput|uia|wgc)";
const DEVELOPMENT_INTENT = new RegExp(
  `(?:${DEVELOPMENT_ACTION}.{0,40}${AUTOMATION_SUBJECT}|${AUTOMATION_SUBJECT}.{0,40}${DEVELOPMENT_ACTION})`,
  "iu",
);

const DESKTOP_INPUT_COMMANDS = [
  /(?:powershell|pwsh)[\s\S]*(?:System\.Windows\.Forms\.SendKeys|WScript\.Shell)[\s\S]*(?:SendWait|SendKeys|AppActivate)/iu,
  /(?:python|py)(?:\.exe)?\s[\s\S]*(?:pyautogui[\s\S]*(?:click|write|press|hotkey)|ctypes[\s\S]*(?:SendInput|keybd_event|mouse_event|SetCursorPos))/iu,
  /node(?:\.exe)?\s[\s\S]*(?:robotjs|robot-js)[\s\S]*(?:keyTap|typeString|mouseClick|moveMouse)/iu,
];

export function shouldBlockDesktopAutomationFallback(input: {
  command: string;
  computerUseActive: boolean;
  originalUserInstruction?: string;
}): boolean {
  if (!input.computerUseActive) return false;
  if (DEVELOPMENT_INTENT.test(input.originalUserInstruction ?? "")) return false;
  return DESKTOP_INPUT_COMMANDS.some((pattern) => pattern.test(input.command));
}

export function withDesktopAutomationFallbackGuard(
  tool: ToolDefinition,
  input: { computerUseActive: boolean | (() => boolean); originalUserInstruction?: string },
): ToolDefinition {
  return {
    ...tool,
    async call(rawInput, context) {
      const command = readCommand(rawInput);
      const computerUseActive = typeof input.computerUseActive === "function"
        ? input.computerUseActive()
        : input.computerUseActive;
      if (command && shouldBlockDesktopAutomationFallback({
        command,
        computerUseActive,
        originalUserInstruction: input.originalUserInstruction,
      })) {
        return {
          type: "tool_result",
          tool_use_id: context.toolUseId ?? "",
          content: "Computer Use 已启用，不能改用 shell 脚本操控桌面。请继续使用 sky，或报告 Computer Use 的明确错误。",
          is_error: true,
        };
      }
      return tool.call(rawInput, context);
    },
  };
}

function readCommand(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = (value as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
