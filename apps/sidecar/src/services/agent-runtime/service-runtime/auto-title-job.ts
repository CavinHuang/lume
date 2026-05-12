import {
  getAgentThreadMessages,
  getAgentThreadMeta,
  updateAgentThreadMeta
} from "../../agent/agent-thread-manager";
import {
  deriveFallbackAgentTitleFromSourceText,
  resolveAgentTitleSourceText,
  sanitizeGeneratedTitle,
  shouldAutoGenerateThreadTitle
} from "../../agent/session-title-summarizer";
import { createLogger } from "../../infra/logger";
import type { ServiceRuntimeJob } from "./service-runtime";

const log = createLogger("auto-title-job");

export function createAutoTitleJob(input: {
  threadId: string;
  fallbackUserMessage: string;
  onTitleUpdated?: (title: string) => void;
}): ServiceRuntimeJob | null {
  const meta = getAgentThreadMeta(input.threadId);
  if (!meta) {
    log.debug("自动标题跳过：线程不存在", { threadId: input.threadId });
    return null;
  }
  if (!shouldAutoGenerateThreadTitle(meta.title)) {
    log.debug("自动标题跳过：线程标题不是默认值", {
      threadId: input.threadId,
      currentTitle: meta.title
    });
    return null;
  }

  return {
    id: `title.generate:${input.threadId}`,
    type: "title.generate",
    run: async () => {
      const threadMessages = getAgentThreadMessages(input.threadId);
      const sourceText = resolveAgentTitleSourceText(threadMessages, input.fallbackUserMessage);
      const fallbackTitle = sanitizeGeneratedTitle(deriveFallbackAgentTitleFromSourceText(sourceText) ?? "");
      if (!fallbackTitle) {
        log.debug("自动标题跳过：未能生成可用标题", { threadId: input.threadId });
        return;
      }
      updateAgentThreadMeta(input.threadId, { title: fallbackTitle });
      log.info("自动标题更新成功（临时）", {
        threadId: input.threadId,
        title: fallbackTitle,
        source: "fallback"
      });
      input.onTitleUpdated?.(fallbackTitle);
    }
  };
}
