import type { MessageBus } from '@carlos-tzin/tzin/bus'

/**
 * Optional Redis bus for multi-node deployments.
 *
 * Enable with `REDIS_URL=redis://host:6379`. When unset, the app runs
 * standalone (single node) — no dependency, no connection attempted.
 * Install only if you use it: `npm i ioredis`.
 *
 * Wiring (in app.ts, where you create the Hub for channelRoutes):
 *
 *   import { Hub } from '@carlos-tzin/tzin'
 *   import { redisBus } from './bus.js'
 *
 *   const bus = await redisBus()          // undefined when REDIS_URL is unset
 *   const hub = new Hub(bus ? { bus } : {})
 */
export async function redisBus(): Promise<MessageBus | undefined> {
  const url = process.env.REDIS_URL
  if (!url) return undefined

  // Lazy import so apps without ioredis installed still typecheck and run.
  // Structural typing on purpose: no ioredis types needed at compile time.
  // Only the runtime package is required, and only when REDIS_URL is set.
  // `as string` keeps tsc from resolving the module at compile time.
  interface RedisLike {
    connect(): Promise<unknown>
    publish(channel: string, message: string): Promise<unknown>
    duplicate(): RedisLike
    subscribe(channel: string): Promise<unknown>
    on(event: 'message', cb: (channel: string, message: string) => void): void
    unsubscribe(channel: string): Promise<unknown>
    disconnect(): void
  }
  const mod = (await import('ioredis' as string)) as unknown as {
    Redis: new (url: string, opts?: Record<string, unknown>) => RedisLike
  }
  const pub = new mod.Redis(url, { lazyConnect: true })
  await pub.connect()

  return {
    publish: (channel, message) => {
      void pub.publish(channel, message)
    },
    subscribe: (channel, handler) => {
      const sub = pub.duplicate()
      let off = () => {}
      void (async () => {
        await sub.connect()
        await sub.subscribe(channel)
        const onMsg = (c: string, m: string) => {
          if (c === channel) handler(m)
        }
        sub.on('message', onMsg)
        off = () => {
          void (async () => {
            try {
              await sub.unsubscribe(channel)
            } catch {}
            sub.disconnect()
          })()
        }
      })()
      return () => off()
    },
  }
}
