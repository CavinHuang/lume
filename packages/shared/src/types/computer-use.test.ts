import { describe, expect, test } from "bun:test";
import {
  DESKTOP_ACTION_STATUSES,
  desktopProposalSuggestedAction,
  isDesktopActionStatus,
  requiresDesktopActionConfirmation,
} from "./computer-use";

describe("computer-use shared contracts", () => {
  test("accepts only stable desktop action statuses", () => {
    expect(DESKTOP_ACTION_STATUSES).toEqual([
      "ok",
      "unavailable",
      "permission_denied",
      "stale_target",
      "blocked",
      "cancelled",
      "timeout",
      "failed",
    ]);
    expect(isDesktopActionStatus("stale_target")).toBeTrue();
    expect(isDesktopActionStatus("silently_ignored")).toBeFalse();
  });

  test("always confirms externally consequential actions", () => {
    expect(requiresDesktopActionConfirmation({ kind: "click", targetLabel: "发送" })).toBeTrue();
    expect(requiresDesktopActionConfirmation({ kind: "press_key", keys: ["ENTER"], targetLabel: "付款" })).toBeTrue();
    expect(requiresDesktopActionConfirmation({ kind: "press_key", keys: ["ENTER"] })).toBeTrue();
    expect(requiresDesktopActionConfirmation({ kind: "press_key", keys: ["Return"] })).toBeTrue();
    expect(requiresDesktopActionConfirmation({ kind: "click", targetLabel: "展开详情" })).toBeFalse();
    expect(requiresDesktopActionConfirmation({
      kind: "perform_secondary_action",
      secondaryAction: "AXDelete",
    })).toBeTrue();
    expect(requiresDesktopActionConfirmation({
      kind: "perform_secondary_action",
      secondaryAction: "AXShowMenu",
    })).toBeFalse();
    expect(requiresDesktopActionConfirmation({ kind: "press_key", keys: ["TAB"] })).toBeFalse();
  });

  test("maps every proactive proposal kind to one explicit next action", () => {
    expect([
      desktopProposalSuggestedAction("reply"),
      desktopProposalSuggestedAction("conflict"),
      desktopProposalSuggestedAction("prompt_rescue"),
      desktopProposalSuggestedAction("daily_wrap"),
      desktopProposalSuggestedAction("follow_up"),
    ]).toEqual([
      "reply_draft",
      "review_conflict",
      "apply_fix",
      "review_summary",
      "create_follow_up",
    ]);
  });
});
