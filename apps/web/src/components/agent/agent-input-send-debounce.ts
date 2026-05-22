import { debounce } from 'throttle-debounce'

export type DebouncedAgentInputSend = (() => void) & {
  cancel: (options?: { upcomingOnly?: boolean }) => void
}

export function createDebouncedAgentInputSend(
  send: () => void,
  delay = 600,
): DebouncedAgentInputSend {
  return debounce(delay, send, { atBegin: true }) as DebouncedAgentInputSend
}

export function cancelPendingDebouncedAgentInputSend(send: DebouncedAgentInputSend) {
  send.cancel({ upcomingOnly: true })
}
