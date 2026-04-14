import { describe, expect, mock, test } from "bun:test";
import { renderToString } from "react-dom/server";

mock.module("./components/app-shell/AppShell", () => ({
  AppShell: () => <div data-testid="app-shell">mock app shell</div>
}));

mock.module("./components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

mock.module("./lib/desktop-api/system", () => ({
  getPersistedUiState: () => new Promise(() => {}),
  updatePersistedUiState: async () => ({ ok: true })
}));

mock.module("./lib/desktop-api/agent", () => ({
  onAgentCapabilitiesChanged: async () => async () => {},
  onAgentWorkspaceFilesChanged: async () => async () => {}
}));

mock.module("./lib/desktop-api/core", () => ({
  sidecarCall: async () => ({ version: 1 }),
  onSidecarEvent: async () => async () => {},
  onSidecarMethodEvent: async () => async () => {},
  desktopHealthcheck: async () => ({ ok: true, source: "web", version: 1 }),
  sidecarHealthcheck: async () => ({ ok: true, source: "web", version: 1 }),
  openExternalUrl: async () => {}
}));

describe("App", () => {
  test("初始 render 不应因为恢复 UI 状态未完成而只渲染空白壳", async () => {
    const { default: App } = await import("./App");
    const html = renderToString(<App />);

    expect(html).toContain("mock app shell");
    expect(html).not.toContain('h-screen w-screen bg-background');
  });
});
