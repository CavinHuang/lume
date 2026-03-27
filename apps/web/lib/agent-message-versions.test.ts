import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import {
  canMoveToNextVersion,
  canMoveToPreviousVersion,
  getDisplayedAgentMessage,
  getLatestVersionIndex,
  getVersionLabel
} from "./agent-message-versions";

const latestMessage: AgentMessage = {
  id: "message-2",
  role: "user",
  content: "第二版",
  createdAt: 2,
  versionGroupId: "group-1",
  versionIndex: 2,
  versionCount: 2,
  isLatestVersion: true
};

const historicalMessage: AgentMessage = {
  id: "message-1",
  role: "user",
  content: "第一版",
  createdAt: 1,
  versionGroupId: "group-1",
  versionIndex: 1,
  versionCount: 2,
  isLatestVersion: false
};

describe("agent-message-versions", () => {
  test("getLatestVersionIndex 应返回 latest 标记位置", () => {
    expect(getLatestVersionIndex([historicalMessage, latestMessage])).toBe(1);
  });

  test("getDisplayedAgentMessage 应返回选中的历史版本", () => {
    const displayed = getDisplayedAgentMessage(
      latestMessage,
      { "group-1": [historicalMessage, latestMessage] },
      { "group-1": 0 }
    );

    expect(displayed.id).toBe("message-1");
  });

  test("版本标签与切换边界应正确", () => {
    const versionsByGroup = { "group-1": [historicalMessage, latestMessage] };

    expect(getVersionLabel(latestMessage, historicalMessage, versionsByGroup)).toBe("1/2");
    expect(canMoveToPreviousVersion(latestMessage, historicalMessage, versionsByGroup)).toBeFalse();
    expect(canMoveToNextVersion(latestMessage, historicalMessage, versionsByGroup)).toBeTrue();
    expect(canMoveToPreviousVersion(latestMessage, latestMessage, versionsByGroup)).toBeTrue();
    expect(canMoveToNextVersion(latestMessage, latestMessage, versionsByGroup)).toBeFalse();
  });
});
