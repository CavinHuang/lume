import { describe, expect, test } from "bun:test";
import { agentSendInputSchema } from "./schemas";
import { validateInput } from "./validation";

describe("agentSendInputSchema messageAttachments", () => {
  test("accepts thread-relative message attachment references", () => {
    const parsed = agentSendInputSchema.parse({
      threadId: "thread-1",
      userMessage: "read this",
      messageAttachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 1200,
        threadPath: "files/brief.md"
      }]
    });

    expect(parsed.messageAttachments).toHaveLength(1);
    expect(parsed.messageAttachments?.[0]?.threadPath).toBe("files/brief.md");
  });

  test("rejects invalid message attachment references", () => {
    const base = {
      threadId: "thread-1",
      userMessage: "read this",
      messageAttachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 1200,
        threadPath: "files/brief.md"
      }]
    };

    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], threadPath: undefined }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], size: -1 }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], filename: "" }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], threadPath: "/tmp/a.txt" }]
    })).toThrow();
    expect(() => agentSendInputSchema.parse({
      ...base,
      messageAttachments: [{ ...base.messageAttachments[0], threadPath: "../a.txt" }]
    })).toThrow();
  });
});

// 三态路由契约:经 validateInput(RPC 入口)提交 followUpQueueMode 时不可被 strip。
// 回归:zod 默认 unknownKeys='strip' + schema 未声明字段会被丢弃 → agent-service 三态路由恒走 queue。
describe("agentSendInputSchema followUpQueueMode (RPC contract)", () => {
  test("validateInput 保留 followUpQueueMode='steer'(不被 strip)", () => {
    const parsed = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "steer" },
      "agent.send",
    );
    expect(parsed.followUpQueueMode).toBe("steer");
  });

  test("validateInput 保留 followUpQueueMode='interrupt'(不被 strip)", () => {
    const parsed = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "interrupt" },
      "agent.append",
    );
    expect(parsed.followUpQueueMode).toBe("interrupt");
  });

  test("validateInput 接受 followUpQueueMode='queue' 与缺省(undefined)", () => {
    const queued = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "queue" },
      "agent.send",
    );
    expect(queued.followUpQueueMode).toBe("queue");

    const omitted = validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi" },
      "agent.send",
    );
    expect(omitted.followUpQueueMode).toBeUndefined();
  });

  test("validateInput 拒绝非法 followUpQueueMode 值", () => {
    expect(() => validateInput(
      agentSendInputSchema,
      { threadId: "t1", userMessage: "hi", followUpQueueMode: "bogus" },
      "agent.send",
    )).toThrow();
  });

});
