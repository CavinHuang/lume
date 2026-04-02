import { describe, expect, test } from "bun:test";
import {
  AGENT_MINIMAP_RIGHT_GAP_PX,
  AGENT_SIDE_PANEL_COLLAPSED_WIDTH_PX,
  AGENT_SIDE_PANEL_WIDTH_PX,
  getAgentMinimapRightPx
} from "./AgentSidePanel";

describe("AgentSidePanel", () => {
  test("getAgentMinimapRightPx 应基于侧边面板宽度计算 minimap 偏移", () => {
    expect(getAgentMinimapRightPx(true)).toBe(AGENT_SIDE_PANEL_WIDTH_PX + AGENT_MINIMAP_RIGHT_GAP_PX);
    expect(getAgentMinimapRightPx(false)).toBe(AGENT_SIDE_PANEL_COLLAPSED_WIDTH_PX + AGENT_MINIMAP_RIGHT_GAP_PX);
  });
});
