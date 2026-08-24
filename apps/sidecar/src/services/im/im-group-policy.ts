/**
 * IM 群聊消息准入策略（纯函数）。
 *
 * 判定优先级：
 * 1. 精确 @ 机器人（open_id 匹配，#405）→ 放行
 * 2. 单人群豁免（权威 user_count === 1，机器人+一人私聊群免 @ 续聊）→ 放行
 * 3. 精确判定「@ 了别人/没人」→ 拒绝（防误触发与回复风暴）
 * 4. 机器人身份不可得时退回提及标记启发式（有 @ 痕迹才放行）
 */

export type ImGroupAccessReason =
  | "bot-mentioned"
  | "single-user-group"
  | "mention-heuristic"
  | "not-addressed"
  | "needs-mention";

export interface ImGroupAccessInput {
  /** 原始文本含任何 @ 提及标记（廉价线索，无需 API） */
  hasMentionMarkup: boolean;
  /**
   * 精确判定是否 @ 了本机器人：true/false 为确定结论；
   * null 表示机器人身份不可得（API 失败），无法精确判定
   */
  botMentioned: boolean | null;
  /** 群成员数（权威值）；null 表示不可得 */
  chatUserCount: number | null;
}

export interface ImGroupAccessResult {
  accepted: boolean;
  reason: ImGroupAccessReason;
}

export function resolveImGroupAccess(input: ImGroupAccessInput): ImGroupAccessResult {
  if (input.botMentioned === true) {
    return { accepted: true, reason: "bot-mentioned" };
  }
  if (input.chatUserCount !== null && input.chatUserCount <= 1) {
    return { accepted: true, reason: "single-user-group" };
  }
  if (input.botMentioned === false) {
    return { accepted: false, reason: input.hasMentionMarkup ? "not-addressed" : "needs-mention" };
  }
  // 机器人身份不可得：退回启发式
  return input.hasMentionMarkup
    ? { accepted: true, reason: "mention-heuristic" }
    : { accepted: false, reason: "needs-mention" };
}
