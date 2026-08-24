import { describe, expect, test } from "bun:test";
import { resolveImGroupAccess } from "./im-group-policy";

describe("resolveImGroupAccess", () => {
  test("精确 @ 机器人优先放行（即使多人群）", () => {
    const result = resolveImGroupAccess({ hasMentionMarkup: true, botMentioned: true, chatUserCount: 50 });
    expect(result).toEqual({ accepted: true, reason: "bot-mentioned" });
  });

  test("单人群免 @（权威 user_count=1），且优先于未提及拒绝", () => {
    expect(
      resolveImGroupAccess({ hasMentionMarkup: false, botMentioned: null, chatUserCount: 1 })
    ).toEqual({ accepted: true, reason: "single-user-group" });
    // 精确判定 @ 了别人，但单人群仍豁免
    expect(
      resolveImGroupAccess({ hasMentionMarkup: true, botMentioned: false, chatUserCount: 1 })
    ).toEqual({ accepted: true, reason: "single-user-group" });
  });

  test("精确判定 @ 了别人 → 拒绝（not-addressed）", () => {
    const result = resolveImGroupAccess({ hasMentionMarkup: true, botMentioned: false, chatUserCount: 5 });
    expect(result).toEqual({ accepted: false, reason: "not-addressed" });
    expect(
      resolveImGroupAccess({ hasMentionMarkup: false, botMentioned: false, chatUserCount: 5 }).reason
    ).toBe("needs-mention");
  });

  test("身份不可得退回启发式：有 @ 标记放行，无标记拒绝", () => {
    expect(
      resolveImGroupAccess({ hasMentionMarkup: true, botMentioned: null, chatUserCount: 8 })
    ).toEqual({ accepted: true, reason: "mention-heuristic" });
    expect(
      resolveImGroupAccess({ hasMentionMarkup: false, botMentioned: null, chatUserCount: null })
    ).toEqual({ accepted: false, reason: "needs-mention" });
  });
});
