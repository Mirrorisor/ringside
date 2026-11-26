/**
 * App session tokens for the gas sponsor: HMAC-SHA256 over a small JSON
 * payload, `v1.<base64url {sub, exp}>.<base64url mac>`, sent as
 * `Authorization: Bearer <token>`.
 *
 * A stand-in until the sponsor verifies the embedded-wallet provider's JWT:
 * the app backend that signs users in mints these with the shared
 * SPONSOR_SESSION_SECRET. Any authenticator with the same shape plugs into
 * createSponsorServer's `authenticate` option.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type Authenticated = {
  userId: string;
  /** Issued-at, seconds. Absent only for tokens from before iat existed (never accepted by revocation-aware auth). */
  iat?: number;
  /** Expiry, seconds. */
  exp?: number;
  /** Audience the token was minted for. */
  aud?: string;
  /** Unix seconds of the user's first sign-in (sponsor tokens only). */
  firstSeen?: number;
};
export type Authenticator = (req: IncomingMessage) => Promise<Authenticated | null>;

/** Services a token can be minted for. A token only works at the service named in its `aud`. */
export type Audience = "social" | "copy" | "sponsor";

/**
 * Revocation lookup shared by the services. `isRevoked(userId, iat)` is true when the user
 * logged out (or was revoked) at or after the token's issue time.
 *
 * MULTI-PROCESS GAP: the shipped implementation (SocialStore) is in-process / local SQLite, so a
 * copy or sponsor running in another process cannot see logouts. Until a shared store (or a
 * revocation feed) is wired, revocation is only enforced where the port is injected, and the
 * 12 h token TTL bounds the exposure elsewhere.
 */
export interface RevocationPort {
  isRevoked(userId: string, iat: number): boolean | Promise<boolean>;
}

export const MIN_SECRET_BYTES = 32;
/** Longest lifetime a token may claim, so a leaked token cannot be minted "forever". */
export const MAX_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

function keyOf(secret: string | Uint8Array): Buffer {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (key.length < MIN_SECRET_BYTES) throw new Error(`The session secret must be at least ${MIN_SECRET_BYTES} bytes.`);
  return key;
}

const mac = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest();

/** Mints a token for `userId`, valid for `ttlSeconds`. */
export function createSessionToken(
  secret: string | Uint8Array, userId: string, ttlSeconds = 3600, now = Date.now(), aud?: string, extra: { firstSeen?: number } = {},
): string {
  if (!userId) throw new Error("userId is required");
  const key = keyOf(secret);
  const payload = Buffer.from(JSON.stringify({
    sub: userId, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds,
    ...(aud ? { aud } : {}), ...(extra.firstSeen !== undefined ? { firstSeen: Math.floor(extra.firstSeen) } : {}),
  })).toString("base64url");
  const body = `v1.${payload}`;
  return `${body}.${mac(key, body).toString("base64url")}`;
}

/**
 * The user a token names, or null if it is malformed, forged, expired or minted for another
 * audience. `opts.aud` must equal the token's `aud` exactly; with no `aud`, only audience-less
 * (legacy) tokens verify. Compares the MAC in constant time.
 */
export function verifySessionToken(secret: string | Uint8Array, token: string, now = Date.now(), opts: { aud?: string } = {}): Authenticated | null {
  const key = keyOf(secret);
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const given = Buffer.from(parts[2], "base64url");
  const want = mac(key, `${parts[0]}.${parts[1]}`);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let claims: { sub?: unknown; exp?: unknown; iat?: unknown; aud?: unknown; firstSeen?: unknown };
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const nowS = Math.floor(now / 1000);
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowS || claims.exp > nowS + MAX_TOKEN_TTL_SECONDS) return null;
  if (claims.aud !== undefined && typeof claims.aud !== "string") return null;
  if (claims.aud !== opts.aud) return null;
  const out: Authenticated = { userId: claims.sub, exp: claims.exp };
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > nowS + 60) return null;
    out.iat = claims.iat;
  }
  if (claims.aud !== undefined) out.aud = claims.aud;
  if (claims.firstSeen !== undefined) {
    if (typeof claims.firstSeen !== "number" || !Number.isFinite(claims.firstSeen)) return null;
    out.firstSeen = claims.firstSeen;
  }
  return out;
}

/**
 * Authenticator reading `Authorization: Bearer <session token>`. Refuses tokens whose audience is
 * not `opts.aud`. With `opts.revocation`, refuses revoked tokens (and tokens with no iat).
 */
export function hmacSessionAuth(secret: string | Uint8Array, opts: { aud?: string; revocation?: RevocationPort } = {}): Authenticator {
  keyOf(secret); // fail at startup, not per request
  return async (req) => {
    const h = req.headers.authorization;
    const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    const who = m ? verifySessionToken(secret, m[1], Date.now(), { aud: opts.aud }) : null;
    if (!who) return null;
    if (opts.revocation && (who.iat === undefined || (await opts.revocation.isRevoked(who.userId, who.iat)))) return null;
    return who;
  };
}
