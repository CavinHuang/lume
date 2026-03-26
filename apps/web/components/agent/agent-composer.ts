import type { AgentSavedFile } from "@lume/shared";

const DEFAULT_AGENT_TITLES = ["新 Agent 会话", "新会话", "新对话", "new agent session"];

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] ?? "" : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

export function buildAttachedFilesReferenceBlock(files: AgentSavedFile[]): string {
  if (files.length === 0) return "";
  const refs = files.map((file) => `- ${file.filename}: ${file.targetPath}`).join("\n");
  return `<attached_files>\n${refs}\n</attached_files>\n\n`;
}

export function shouldQueueAgentTitleGeneration(input: {
  currentTitle: string;
  userMessage: string;
  channelId: string | null;
  modelId: string | undefined;
  hasPendingTitle: boolean;
}): boolean {
  const trimmedUserMessage = input.userMessage.trim();
  if (!trimmedUserMessage || !input.channelId || !input.modelId || input.hasPendingTitle) {
    return false;
  }

  const currentTitle = input.currentTitle.trim();
  return !currentTitle || DEFAULT_AGENT_TITLES.some((title) => title.toLowerCase() === currentTitle.toLowerCase());
}

export function shouldDispatchPendingPrompt(input: {
  pendingPromptSessionId: string | null;
  sessionId: string | null;
  backendReady: boolean;
  isAgentBusy: boolean;
}): boolean {
  return !!input.pendingPromptSessionId
    && !!input.sessionId
    && input.pendingPromptSessionId === input.sessionId
    && input.backendReady
    && !input.isAgentBusy;
}
