import { describe, expect, test } from "bun:test";
import type { AgentSidePanelTab } from "./AgentSidePanel";
import { resolveNextFileBrowserPanelState } from "./agent-side-panel-state";

describe("agent-side-panel-state", () => {
  test("当前已打开 files tab 时，再次切换应关闭 side panel", () => {
    expect(resolveNextFileBrowserPanelState({
      open: true,
      tab: "files"
    })).toEqual({
      open: false,
      tab: "files"
    });
  });

  test("当前关闭或不在 files tab 时，应切到 files 并打开", () => {
    expect(resolveNextFileBrowserPanelState({
      open: false,
      tab: "team"
    })).toEqual({
      open: true,
      tab: "files"
    });

    expect(resolveNextFileBrowserPanelState({
      open: true,
      tab: "team" as AgentSidePanelTab
    })).toEqual({
      open: true,
      tab: "files"
    });
  });
});
