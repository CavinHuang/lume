import { getRuntimeHostPorts } from "../host-ports";
import {
  deriveFallbackAgentTitleFromSourceText,
  resolveAgentTitleConversationText,
  resolveAgentTitleSourceText,
  sanitizeGeneratedTitle,
  shouldAutoGenerateThreadTitle
} from "./session-title-summarizer";
import { createLogger } from "../../infra/logger";
import type { ServiceRuntimeJob } from "./service-runtime";

const log = createLogger("auto-title-job");

export function createAutoTitleJob(input: {
  threadId: string;
  fallbackUserMessage: string;
  generateTitle?: (sourceText: string) => Promise<string | null>;
  onTitleUpdated?: (title: string) => void;
}): ServiceRuntimeJob | null {
  const meta = getRuntimeHostPorts().getThreadMeta(input.threadId);
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
      const threadMessages = getRuntimeHostPorts().getThreadMessages(input.threadId);
      const sourceText = resolveAgentTitleSourceText(threadMessages, input.fallbackUserMessage);
      const generatedTitle = input.generateTitle
        ? sanitizeGeneratedTitle(
          await input.generateTitle(
            resolveAgentTitleConversationText(threadMessages, input.fallbackUserMessage)
          ) ?? ""
        )
        : "";
      const fallbackTitle = sanitizeGeneratedTitle(deriveFallbackAgentTitleFromSourceText(sourceText) ?? "");
      const title = generatedTitle || fallbackTitle;
      if (!title) {
        log.debug("自动标题跳过：未能生成可用标题", { threadId: input.threadId });
        return;
      }
      getRuntimeHostPorts().tryUpdateThreadMeta(input.threadId, { title });
      log.info("自动标题更新成功（临时）", {
        threadId: input.threadId,
        title,
        source: generatedTitle ? "llm" : "fallback"
      });
      input.onTitleUpdated?.(title);
    }
  };
}
