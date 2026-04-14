import { describe, expect, test } from "bun:test";
import type { AgentSavedFile } from "@lume/shared";
import {
  buildAttachedFilesReferenceBlock,
  canSubmitAgentComposerInput,
  shouldDispatchPendingPrompt,
  shouldQueueAgentTitleGeneration
} from "./agent-composer";

describe("agent-composer", () => {
  test("buildAttachedFilesReferenceBlock 应按约定格式输出 attached_files 块", () => {
    const files: AgentSavedFile[] = [
      {
        filename: "a.txt",
        targetPath: "workspace/a.txt"
      },
      {
        filename: "b.md",
        targetPath: "workspace/docs/b.md"
      }
    ] as AgentSavedFile[];

    expect(buildAttachedFilesReferenceBlock(files)).toBe(
      "<attached_files>\n- a.txt: workspace/a.txt\n- b.md: workspace/docs/b.md\n</attached_files>\n\n"
    );
  });

  test("buildAttachedFilesReferenceBlock 在空输入时应返回空字符串", () => {
    expect(buildAttachedFilesReferenceBlock([])).toBe("");
  });

  test("shouldQueueAgentTitleGeneration 仅在默认标题且输入有效时返回 true", () => {
    expect(shouldQueueAgentTitleGeneration({
      currentTitle: "新 Agent 线程",
      userMessage: "实现新的动作拆分",
      channelId: "channel-1",
      modelId: "model-1",
      hasPendingTitle: false
    })).toBe(true);

    expect(shouldQueueAgentTitleGeneration({
      currentTitle: "已经有标题了",
      userMessage: "实现新的动作拆分",
      channelId: "channel-1",
      modelId: "model-1",
      hasPendingTitle: false
    })).toBe(false);

    expect(shouldQueueAgentTitleGeneration({
      currentTitle: "新 Agent 线程",
      userMessage: "   ",
      channelId: "channel-1",
      modelId: "model-1",
      hasPendingTitle: false
    })).toBe(false);
  });

  test("shouldDispatchPendingPrompt 仅在会话匹配且运行条件满足时返回 true", () => {
    expect(shouldDispatchPendingPrompt({
      pendingPromptThreadId: "session-1",
      threadId: "session-1",
      backendReady: true,
      isAgentBusy: false
    })).toBe(true);

    expect(shouldDispatchPendingPrompt({
      pendingPromptThreadId: "session-2",
      threadId: "session-1",
      backendReady: true,
      isAgentBusy: false
    })).toBe(false);

    expect(shouldDispatchPendingPrompt({
      pendingPromptThreadId: "session-1",
      threadId: "session-1",
      backendReady: false,
      isAgentBusy: false
    })).toBe(false);
  });

  test("canSubmitAgentComposerInput 在 streaming/审批前置之外只校验发送基本条件", () => {
    expect(canSubmitAgentComposerInput({
      backendReady: true,
      channelId: "channel-1",
      modelId: "model-1",
      text: "继续执行",
      pendingFileCount: 0,
      pendingFolderRefCount: 0
    })).toBe(true);

    expect(canSubmitAgentComposerInput({
      backendReady: true,
      channelId: "channel-1",
      modelId: "model-1",
      text: "   ",
      pendingFileCount: 1,
      pendingFolderRefCount: 0
    })).toBe(true);

    expect(canSubmitAgentComposerInput({
      backendReady: true,
      channelId: "channel-1",
      modelId: "model-1",
      text: "   ",
      pendingFileCount: 0,
      pendingFolderRefCount: 0
    })).toBe(false);
  });
});


