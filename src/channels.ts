import { t } from './schema.js'
import { contract, impl, type AnyRoute } from './contract.js'
import type { Hub } from './hub.js'
import type { Presence } from './presence.js'
import { sse } from './sse.js'

export interface ChannelOptions {
  presence?: Presence
}

/**
 * Batteries-included realtime endpoints:
 *   GET  /channels/:topic            subscribe (SSE); ?member= enables presence
 *   POST /channels/:topic            publish { event, data? }
 *   POST /channels/:topic/heartbeat  presence join/refresh { member, meta? }
 *   POST /channels/:topic/leave      presence leave { member }
 */
export function channelRoutes(hub: Hub, options: ChannelOptions = {}): AnyRoute[] {
  const presence = options.presence

  const subscribe = contract({
    name: 'subscribe_channel',
    description: 'Subscribe to a channel via SSE. Pass ?member=NAME to appear in presence.',
    method: 'GET',
    path: '/channels/:topic',
    params: t.Object({ topic: t.String() }),
    query: t.Object({ member: t.Optional(t.String()) }),
    responses: {
      200: t.Object({ ok: t.Boolean() }),
      404: t.Object({ error: t.String() }),
    },
  })

  const publish = contract({
    name: 'publish_channel',
    description: 'Broadcast an event to every subscriber of a channel.',
    method: 'POST',
    path: '/channels/:topic',
    params: t.Object({ topic: t.String() }),
    body: t.Object({ event: t.String(), data: t.Optional(t.Unknown()) }),
    responses: { 200: t.Object({ delivered: t.Number() }) },
  })

  const heartbeat = contract({
    name: 'channel_heartbeat',
    description: 'Join a channel or refresh presence for a member.',
    method: 'POST',
    path: '/channels/:topic/heartbeat',
    params: t.Object({ topic: t.String() }),
    body: t.Object({ member: t.String(), meta: t.Optional(t.Unknown()) }),
    responses: { 200: t.Object({ ok: t.Boolean() }) },
  })

  const leave = contract({
    name: 'channel_leave',
    description: 'Leave a channel; triggers a presence_diff broadcast.',
    method: 'POST',
    path: '/channels/:topic/leave',
    params: t.Object({ topic: t.String() }),
    body: t.Object({ member: t.String() }),
    responses: { 200: t.Object({ ok: t.Boolean() }) },
  })

  const routes: AnyRoute[] = [
    impl(subscribe, ({ params, query, ctx }) => {
      const topic = params.topic
      const member = query?.member

      return sse(async (send) => {
        send.comment(`subscribed ${topic}`)
        const unsub = hub.subscribe(topic, (e) => send.event(e.event, e.data))
        if (member && presence) presence.join(topic, member)
        // Initial full view (Phoenix parity): anonymous subscribers get the
        // room state here; members just got their join broadcast above.
        if (presence) send.event('presence_state', { members: presence.snapshot(topic) })

        const cleanup = (): void => {
          unsub()
          if (member && presence) presence.leave(topic, member)
        }

        const signal = ctx.signal
        if (!signal) {
          return
        }
        if (signal.aborted) {
          cleanup()
          return
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            cleanup()
            resolve()
          }, { once: true }),
        )
      }, ctx.signal)
    }),

    impl(publish, ({ params, body }) => ({
      status: 200 as const,
      body: { delivered: hub.publish(params.topic, body.event, body.data ?? null) },
    })),
  ]

  if (presence) {
    routes.push(
      impl(heartbeat, ({ params, body }) => {
        presence.heartbeat(params.topic, body.member, body.meta)
        return { status: 200 as const, body: { ok: true } }
      }),
      impl(leave, ({ params, body }) => {
        presence.leave(params.topic, body.member)
        return { status: 200 as const, body: { ok: true } }
      }),
    )
  }

  return routes
}
