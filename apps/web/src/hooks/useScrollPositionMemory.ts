import { useRef, useCallback } from 'react'

export function useScrollPositionMemory() {
  const positions = useRef<Record<string, number>>({})

  const save = useCallback((id: string, el: HTMLElement | null) => {
    if (el) positions.current[id] = el.scrollTop
  }, [])

  const restore = useCallback((id: string, el: HTMLElement | null) => {
    if (el && positions.current[id] !== undefined) {
      el.scrollTop = positions.current[id]
    }
  }, [])

  return { save, restore }
}
