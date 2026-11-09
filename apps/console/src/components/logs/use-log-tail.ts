import { useCallback, useEffect, useRef, useState } from 'react'

import { LOG_MAX_ROWS, LOG_POLL_MS, mergeLogEntries } from '../../lib/log-tail'
import { getLogsData } from '../../server/dashboard'
import type { LogEntry } from '../../server/dashboard/types'

interface TailState {
  entries: LogEntry[]
  profileName: string
  pending: boolean
  fetching: boolean
  error: boolean
  updatedAt: number | null
  added: number
}

const INITIAL: TailState = {
  entries: [],
  profileName: '',
  pending: true,
  fetching: false,
  error: false,
  updatedAt: null,
  added: 0,
}

/**
 * Appending query-log tail: each poll merges the newest window into the rows
 * already on screen instead of replacing them, so the table keeps growing
 * (up to LOG_MAX_ROWS) while the page stays open.
 */
export function useLogTail() {
  const [state, setState] = useState<TailState>(INITIAL)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setState((prev) => ({ ...prev, fetching: true }))
    try {
      const data = await getLogsData()
      setState((prev) => {
        const entries = mergeLogEntries(data.entries, prev.entries)
        return {
          entries,
          profileName: data.profileName,
          pending: false,
          fetching: false,
          error: false,
          updatedAt: Date.now(),
          added: Math.max(0, entries.length - prev.entries.length),
        }
      })
    } catch {
      setState((prev) => ({ ...prev, pending: false, fetching: false, error: true }))
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      // Background tabs do not need to poll; focus triggers an immediate load.
      if (document.visibilityState === 'visible') void load()
    }, LOG_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  return { ...state, refresh: load }
}

export { LOG_MAX_ROWS }
