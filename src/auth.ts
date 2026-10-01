import { createHmac } from 'node:crypto'
import { defineContext } from './context.js'
import type { Middleware } from './middleware.js'

// ── Types ────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string
  [key: string]: unknown
}

export interface AuthConfig {
  /** Secret key for JWT signing/verification */
  secret: string
  /** Token issuer (optional) */
  issuer?: string
  /** Token audience (optional) */
  audience?: string
  /** Token expiration (default: '1h') */
  expiresIn?: string
  /** Custom token extractor (default: Bearer header) */
  extractToken?: (req: Request) => string | null
  /** Called when auth fails */
  onUnauthorized?: (req: Request, reason: string) => Response | Promise<Response>
}

export interface JwtPayload {
  sub: string
  iat: number
  exp: number
  iss?: string
  aud?: string
  [key: string]: unknown
}

// ── Context Key ──────────────────────────────────────────────────────

/** Typed key for the authenticated user */
export const AUTH_USER = defineContext<AuthUser>('auth_user')

// ── JWT Utilities (minimal, no dependencies) ────────────────────────

function base64UrlEncode(data: string): string {
  return Buffer.from(data).toString('base64url')
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString()
}

function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/**
 * Sign a JWT token.
 */
export function signJwt(payload: Record<string, unknown>, secret: string, options?: { expiresIn?: string; issuer?: string; audience?: string }): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)

  const exp = options?.expiresIn ? parseDuration(options.expiresIn) : 3600
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + exp,
    ...(options?.issuer && { iss: options.issuer }),
    ...(options?.audience && { aud: options.audience }),
  }

  const headerEncoded = base64UrlEncode(JSON.stringify(header))
  const payloadEncoded = base64UrlEncode(JSON.stringify(fullPayload))
  const signature = hmacSign(`${headerEncoded}.${payloadEncoded}`, secret)

  return `${headerEncoded}.${payloadEncoded}.${signature}`
}

/**
 * Verify a JWT token.
 */
export function verifyJwt(token: string, secret: string, options?: { issuer?: string; audience?: string }): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')

  const [headerEncoded, payloadEncoded, signature] = parts
  const expectedSig = hmacSign(`${headerEncoded}.${payloadEncoded}`, secret)

  if (signature !== expectedSig) throw new Error('Invalid JWT signature')

  const payload = JSON.parse(base64UrlDecode(payloadEncoded)) as JwtPayload

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired')
  }

  if (options?.issuer && payload.iss !== options.issuer) {
    throw new Error('Invalid issuer')
  }

  if (options?.audience && payload.aud !== options.audience) {
    throw new Error('Invalid audience')
  }

  return payload
}

function parseDuration(str: string): number {
  const match = str.match(/^(\d+)([smhd])$/)
  if (!match) return 3600

  const [, num, unit] = match
  const n = parseInt(num, 10)
  switch (unit) {
    case 's': return n
    case 'm': return n * 60
    case 'h': return n * 3600
    case 'd': return n * 86400
    default: return 3600
  }
}

// ── Middleware ────────────────────────────────────────────────────────

/**
 * Bearer token authentication middleware.
 *
 * Validates the Authorization: Bearer <token> header and attaches
 * the decoded user to ctx.set(AUTH_USER, user).
 *
 * @example
 * ```ts
 * import { bearerAuth, AUTH_USER } from '@carlos-tzin/tzin/auth'
 *
 * const app = createApp(routes, {
 *   middleware: [bearerAuth({ secret: process.env.JWT_SECRET! })],
 * })
 *
 * // In handler:
 * const user = ctx.require(AUTH_USER)
 * ```
 */
export function bearerAuth(config: AuthConfig): Middleware {
  const extract = config.extractToken ?? defaultExtractToken
  const onUnauthorized = config.onUnauthorized ?? defaultUnauthorized

  return async ({ req, ctx, next }) => {
    const token = extract(req)

    if (!token) {
      return onUnauthorized(req, 'Missing token')
    }

    try {
      const payload = verifyJwt(token, config.secret, {
        issuer: config.issuer,
        audience: config.audience,
      })

      const user: AuthUser = {
        id: payload.sub,
        ...payload,
      }

      ctx.set(AUTH_USER, user)
      return next()
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Invalid token'
      return onUnauthorized(req, reason)
    }
  }
}

/**
 * Optional auth middleware - doesn't fail if no token,
 * but validates if present.
 */
export function optionalAuth(config: AuthConfig): Middleware {
  const extract = config.extractToken ?? defaultExtractToken

  return async ({ req, ctx, next }) => {
    const token = extract(req)

    if (!token) {
      return next()
    }

    try {
      const payload = verifyJwt(token, config.secret, {
        issuer: config.issuer,
        audience: config.audience,
      })

      const user: AuthUser = {
        id: payload.sub,
        ...payload,
      }

      ctx.set(AUTH_USER, user)
    } catch {
      // Ignore invalid tokens in optional mode
    }

    return next()
  }
}

/**
 * API key authentication middleware.
 * Checks for a header like X-API-Key.
 */
export function apiKeyAuth(config: { key: string; header?: string }): Middleware {
  const headerName = config.header ?? 'x-api-key'

  return async ({ req, next }) => {
    const apiKey = req.headers.get(headerName)

    if (!apiKey || apiKey !== config.key) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }

    return next()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function defaultExtractToken(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (!auth) return null

  const parts = auth.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null

  return parts[1]
}

function defaultUnauthorized(_req: Request, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}
