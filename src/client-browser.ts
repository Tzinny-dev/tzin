/**
 * tzin channels client for browsers and Node >= 22.
 *
 * Zero dependencies: uses the platform's EventSource and fetch.
 *
 *   import { joinChannel } from 'tzin/client-browser'
 *
 *   const chat = joinChannel('https://api.example.com', 'lobby', { member: 'ada' })
 *   chat.on('message', (data) => console.log(data))
 *   await chat.push('message', { text: 'hello' })
 */

interface SSELike {
  addEventListener(type: string, listener: (ev: MessageEventLike) => void): void
  close(): void
}

interface MessageEventLike {
  data: unknown
}

export interface JoinOptions {
  /** Appear in presence under this name. */
  member?: string
  /** Metadata attached to your presence entry. */
  meta?: unknown
  /** Presence refresh interval. Must stay below the server's presence TTL. Default 15s. */
  heartbeatMs?: number
  /**
   * Custom EventSource implementation. Browsers provide one globally;
   * Node >= 22 needs a polyfill (e.g. from the 'eventsource' package).
   */
  eventSource?: new (url: string) => SSELike
}

export type Unsubscribe = () => void

export interface Channel {
  readonly topic: string
  /** Listen to a named event; returns an unsubscribe function. */
  on(event: string, cb: (data: unknown) => void): Unsubscribe
  /** Broadcast to every subscriber of this channel. */
  push(event: string, data?: unknown): Promise<{ delivered: number }>
  /** Refresh your presence immediately (the client also does this automatically). */
  heartbeat(): void
  /** Close the subscription and leave presence. */
  close(): void
}

function parseData(raw: unknown): unknown {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return raw
  }
}

export function joinChannel(baseUrl: string, topic: string, options: JoinOptions = {}): Channel {
  const base = baseUrl.replace(/\/$/, '')
  const { member, meta } = options
  const heartbeatMs = options.heartbeatMs ?? 15_000

  const EsCtor = options.eventSource ??
    ((globalThis as Record<string, unknown>).EventSource as
      | (new (url: string) => SSELike)
      | undefined)
  if (!EsCtor) throw new Error('EventSource is not available in this runtime')

  const qs = member !== undefined ? `?member=${encodeURIComponent(member)}` : ''
  const es = new EsCtor(`${base}/channels/${encodeURIComponent(topic)}${qs}`)

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}/channels/${encodeURIComponent(topic)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const dispatch = (event: string, data: unknown): void => {
    const set = listeners.get(event)
    if (set) for (const cb of set) cb(data)
  }

  // Known presence events plus any event registered later via .on().
  es.addEventListener('presence_state', (ev) => dispatch('presence_state', parseData(ev.data)))
  es.addEventListener('presence_diff', (ev) => dispatch('presence_diff', parseData(ev.data)))
  es.addEventListener('message', (ev) => dispatch('message', parseData(ev.data)))

  let timer: ReturnType<typeof setInterval> | undefined
  if (member !== undefined && heartbeatMs > 0) {
    timer = setInterval(() => {
      void post('/heartbeat', { member, meta }).catch(() => {})
    }, heartbeatMs)
  }

  return {
    topic,
    on(event, cb) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
        if (event !== 'message' && event !== 'presence_state' && event !== 'presence_diff') {
          es.addEventListener(event, (ev) => dispatch(event, parseData(ev.data)))
        }
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
      }
    },
    async push(event, data) {
      const res = await post('', { event, data })
      if (!res.ok) throw new Error(`push failed: HTTP ${res.status}`)
      return (await res.json()) as { delivered: number }
    },
    heartbeat() {
      if (member === undefined) return
      void post('/heartbeat', { member, meta }).catch(() => {})
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
      es.close()
      if (member !== undefined) void post('/leave', { member }).catch(() => {})
    },
  }
}
