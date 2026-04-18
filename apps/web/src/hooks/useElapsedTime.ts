import { useState, useEffect, useRef } from 'react'

export function useElapsedTime(startedAt: number | undefined, active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    if (!active || !startedAt) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (startedAt) setElapsed(Date.now() - startedAt)
      return
    }
    setElapsed(Date.now() - startedAt)
    intervalRef.current = setInterval(() => setElapsed(Date.now() - startedAt), 200)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [startedAt, active])

  return elapsed
}

export function formatElapsed(ms: number): string {
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const rem = (sec % 60).toFixed(0)
  return `${min}m${rem}s`
}
