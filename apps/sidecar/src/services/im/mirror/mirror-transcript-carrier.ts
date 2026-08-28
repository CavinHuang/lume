import type { LumeRuntimeEvent } from "@lume/shared";
import type { ImRunCardFinishStatus } from "../im-run-card-session";
import { createLogger } from "../../infra/logger";

const log = createLogger("im-mirror-transcript");

/**
 * #544 镜像文本档载体（无可编辑消息渠道的降级形态）。
 *
 * 两段式防刷屏：首个内容类事件发开工条（一次性），终态发收尾条——正文取本次
 * 运行最后一条 assistant.final 的文本块；无正文则给状态占位。不做中间里程碑播报。
 */
export function createMirrorTranscriptCarrier(input: {
  threadTitle: string;
  send: (text: string) => Promise<void>;
}): {
  handleEvent: (event: LumeRuntimeEvent) => void;
  finish: (status: ImRunCardFinishStatus) => void;
  isEnabled: () => boolean;
  isDegraded: () => boolean;
  settleOpen: () => Promise<boolean>;
} {
  const START_TRIGGER_EVENTS = new Set([
    "assistant.delta",
    "assistant.thinking_delta",
    "assistant.final",
    "tool.started"
  ]);

  let startedSent = false;
  let finished = false;
  let finalText = "";

  const deliver = (text: string): void => {
    void input.send(text).catch((error: unknown) => {
      log.info("镜像文本投递失败", { error: error instanceof Error ? error.message : String(error) });
    });
  };

  const sendStartOnce = (): void => {
    if (startedSent || finished) return;
    startedSent = true;
    deliver(`▶ ${input.threadTitle || "任务"} 开始执行`);
  };

  return {
    handleEvent: (event) => {
      if (finished) return;
      if (START_TRIGGER_EVENTS.has(event.type)) {
        sendStartOnce();
      }
      if (event.type === "assistant.final") {
        // 只保留最后一条完整回复（两段式的第二段），多轮运行避免重复堆叠
        finalText = event.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
      }
    },
    finish: (status) => {
      if (finished) return;
      finished = true;
      switch (status.kind) {
        case "completed":
        case "turn_limited":
          deliver(finalText ? `✅ 完成\n${finalText}` : `✅ ${input.threadTitle || "任务"} 执行完成`);
          break;
        case "interrupted":
          deliver(`⏹ 已停止${finalText ? `\n${finalText}` : ""}`);
          break;
        case "failed":
          deliver(`❌ 运行失败${status.error ? `：${status.error}` : ""}`);
          break;
      }
    },
    isEnabled: () => true,
    isDegraded: () => false,
    settleOpen: async () => true
  };
}
