export function isHeartbeatContentEffectivelyEmpty(
  content: string | undefined | null
): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }

    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }

    return false;
  }

  return true;
}
