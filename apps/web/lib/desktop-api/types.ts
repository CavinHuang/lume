"use client";

export interface BrowserExtensionInfo {
  installedPath: string;
  installed: boolean;
  bundledPath: string | null;
  bundledAvailable: boolean;
  relay: {
    port: number;
    httpUrl: string;
    wsUrl: string;
    tokenRequired: boolean;
  };
  links: {
    chromeExtensions: string;
    chromeLoadUnpackedHint: string;
  };
}

export interface BrowserRelayStatus {
  running: boolean;
  port: number | null;
  connected: boolean;
  connectionCount?: number;
  tokenRequired: boolean;
  diagnostics?: {
    lastRejectReason: string;
    lastCloseReason: string;
  };
  tabs: Array<{ sessionId: string; tabId: number; url?: string; title?: string }>;
}
