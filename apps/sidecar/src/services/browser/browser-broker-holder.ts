import type { BrowserBroker } from "./browser-broker";

let activeBroker: BrowserBroker | null = null;

export function setActiveBrowserBroker(broker: BrowserBroker | null): void {
  activeBroker = broker;
}

export function getActiveBrowserBroker(): BrowserBroker | null {
  return activeBroker;
}
