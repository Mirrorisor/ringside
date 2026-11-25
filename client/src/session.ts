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

export type Authenticated = { userId: string };
export type Authenticator = (req: IncomingMessage) => Promise<Authenticated | null>;

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
export function createSessionToken(secret: string | Uint8Array, userId: string, ttlSeconds = 3600, now = Date.now()): string {
  if (!userId) throw new Error("userId is required");
  const key = keyOf(secret);
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + ttlSeconds })).toString("base64url");
  const body = `v1.${payload}`;
  return `${body}.${mac(key, body).toString("base64url")}`;
}

/** The user a token names, or null if it is malformed, forged or expired. Compares the MAC in constant time. */
export function verifySessionToken(secret: string | Uint8Array, token: string, now = Date.now()): Authenticated | null {
  const key = keyOf(secret);
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const given = Buffer.from(parts[2], "base64url");
  const want = mac(key, `${parts[0]}.${parts[1]}`);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let claims: { sub?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const nowS = Math.floor(now / 1000);
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256) return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowS || claims.exp > nowS + MAX_TOKEN_TTL_SECONDS) return null;
  return { userId: claims.sub };
}

/** Authenticator reading `Authorization: Bearer <session token>`. */
export function hmacSessionAuth(secret: string | Uint8Array): Authenticator {
  keyOf(secret); // fail at startup, not per request
  return async (req) => {
    const h = req.headers.authorization;
    const m = typeof h === "string" ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    return m ? verifySessionToken(secret, m[1]) : null;
  };
}
