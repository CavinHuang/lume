import type { AgentMessage } from "@lume/shared";

export function getLatestVersionIndex(messages: AgentMessage[]): number {
  const latestIndex = messages.findIndex((message) => message.isLatestVersion === true);
  return latestIndex === -1 ? Math.max(0, messages.length - 1) : latestIndex;
}

export function getDisplayedAgentMessage(
  latestMessage: AgentMessage,
  versionsByGroup: Record<string, AgentMessage[]>,
  selectedVersionIndexByGroup: Record<string, number>
): AgentMessage {
  const groupId = latestMessage.versionGroupId;
  if (!groupId) {
    return latestMessage;
  }
  const versions = versionsByGroup[groupId];
  if (!versions || versions.length === 0) {
    return latestMessage;
  }
  const selectedIndex = selectedVersionIndexByGroup[groupId];
  if (typeof selectedIndex !== "number" || selectedIndex < 0 || selectedIndex >= versions.length) {
    return latestMessage;
  }
  return versions[selectedIndex] ?? latestMessage;
}

export function getVersionLabel(
  latestMessage: AgentMessage,
  displayedMessage: AgentMessage,
  versionsByGroup: Record<string, AgentMessage[]>
): string | null {
  const total = latestMessage.versionCount ?? displayedMessage.versionCount ?? 1;
  if (total <= 1) {
    return null;
  }
  const groupId = latestMessage.versionGroupId;
  if (!groupId) {
    return `${latestMessage.versionIndex ?? total}/${total}`;
  }
  const versions = versionsByGroup[groupId];
  if (!versions || versions.length === 0) {
    return `${latestMessage.versionIndex ?? total}/${total}`;
  }
  const current = versions.findIndex((message) => message.id === displayedMessage.id);
  return `${current === -1 ? total : current + 1}/${total}`;
}

export function canMoveToPreviousVersion(
  latestMessage: AgentMessage,
  displayedMessage: AgentMessage,
  versionsByGroup: Record<string, AgentMessage[]>
): boolean {
  const groupId = latestMessage.versionGroupId;
  if (!groupId) {
    return false;
  }
  const versions = versionsByGroup[groupId];
  if (!versions || versions.length <= 1) {
    return (displayedMessage.versionIndex ?? latestMessage.versionIndex ?? 1) > 1;
  }
  const current = versions.findIndex((message) => message.id === displayedMessage.id);
  return current > 0;
}

export function canMoveToNextVersion(
  latestMessage: AgentMessage,
  displayedMessage: AgentMessage,
  versionsByGroup: Record<string, AgentMessage[]>
): boolean {
  const groupId = latestMessage.versionGroupId;
  if (!groupId) {
    return false;
  }
  const versions = versionsByGroup[groupId];
  if (!versions || versions.length <= 1) {
    return false;
  }
  const current = versions.findIndex((message) => message.id === displayedMessage.id);
  return current !== -1 && current < versions.length - 1;
}
