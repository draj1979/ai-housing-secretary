/**
 * gateway/adminAuth.ts
 *
 * JWT-based auth + role-based access control for internal/admin HTTP
 * endpoints (HLD Sec 15) — e.g. gateway/adminRoutes.ts's escalation
 * dashboard, the "future committee dashboard" the HLD anticipates. This is
 * entirely separate from gateway/webhook.ts's WhatsApp signature
 * verification: that's Meta authenticating to us over a webhook; this is a
 * human (the Secretary, or a future read-only committee viewer) calling an
 * HTTP endpoint directly, authenticated with a bearer JWT.
 *
 * Two roles (`ADMIN_ROLES`): `secretary` (full access — can act on
 * escalations) and `read_only` (can view, never mutate). Token issuance is
 * deliberately out-of-band — `mintAdminToken` is a building block for
 * however tokens actually get handed out (an ops script, a future proper
 * login flow), not an HTTP login endpoint itself; the HLD doesn't specify
 * an identity provider, so this doesn't invent one.
 */
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';

export const ADMIN_ROLES = ['secretary', 'read_only'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export interface AdminTokenPayload {
  /** Identifies who this token was issued to — e.g. the Secretary's phone_e164. Not a resident lookup key; purely for audit_logs actor_id (see gateway/adminRoutes.ts). */
  sub: string;
  role: AdminRole;
}

export interface AdminAuthConfig {
  secret: string;
  expiresIn: string;
}

/** Builds an AdminAuthConfig from env — the one place this module reads env. */
export function adminAuthConfigFromEnv(env: Env): AdminAuthConfig {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required for admin auth.');
  }
  return { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN };
}

/**
 * Signs an admin JWT. Used out-of-band to issue credentials (see module
 * doc comment) — never called from an HTTP route in this codebase.
 */
export function mintAdminToken(config: AdminAuthConfig, payload: AdminTokenPayload): string {
  // jsonwebtoken's `expiresIn` is a branded string type (e.g. "12h"), not
  // plain `string` — config/env.ts's JWT_EXPIRES_IN is validated as a
  // non-empty string but not against that exact brand, hence the cast.
  const expiresIn = config.expiresIn as NonNullable<jwt.SignOptions['expiresIn']>;
  return jwt.sign(payload, config.secret, { expiresIn });
}

export class AdminAuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

/** Verifies a bearer token string and returns its payload. Throws `AdminAuthError` (401) if missing/invalid/expired/malformed. */
export function verifyAdminToken(config: AdminAuthConfig, token: string): AdminTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.secret);
  } catch (err) {
    throw new AdminAuthError(
      `Invalid or expired admin token: ${err instanceof Error ? err.message : String(err)}`,
      401,
    );
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new AdminAuthError('Malformed admin token payload.', 401);
  }
  const { sub, role } = decoded as Record<string, unknown>;
  if (typeof sub !== 'string' || !isAdminRole(role)) {
    throw new AdminAuthError('Malformed admin token payload.', 401);
  }
  return { sub, role };
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminTokenPayload;
  }
}

/**
 * Fastify `preHandler`: verifies `Authorization: Bearer <jwt>`, attaches
 * `request.admin` on success, replies 401 otherwise (and short-circuits
 * the route — the handler never runs for an unauthenticated request).
 */
export function requireAdminAuth(config: AdminAuthConfig) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      await reply.code(401).send({ error: 'Missing Authorization: Bearer <token> header.' });
      return;
    }

    try {
      request.admin = verifyAdminToken(config, token);
    } catch (err) {
      const status = err instanceof AdminAuthError ? err.status : 401;
      await reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Fastify `preHandler`: replies 403 unless `request.admin.role` is one of
 * `roles` — role-based access control (HLD Sec 15), chained after
 * `requireAdminAuth` so `request.admin` is already set. Distinguishes
 * `secretary` (can act) from `read_only` (can only view) per route.
 */
export function requireRole(...roles: AdminRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.admin || !roles.includes(request.admin.role)) {
      await reply.code(403).send({ error: `Requires role: ${roles.join(' or ')}.` });
    }
  };
}
