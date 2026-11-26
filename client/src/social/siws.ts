/** Sign-in-with-Solana helpers: base58, wallet checks, message layout, Ed25519 verification (node:crypto). */
import { createPublicKey, randomBytes, verify } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function base58Decode(s: string): Uint8Array | null {
  if (!s || s.length > 100 || !B58_RE.test(s)) return null;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out: number[] = [];
  while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  for (const c of s) { if (c === "1") zeros++; else break; }
  return Uint8Array.from([...Array(zeros).fill(0), ...out.reverse()]);
}

/** A 32-byte base58 Solana address (canonical encoding only). */
export function isWallet(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  const b = base58Decode(s);
  return b !== null && b.length === 32;
}

/** A 64-byte signature in base58 or base64. */
export function decodeSignature(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length < 64 || s.length > 100) return null;
  const b58 = base58Decode(s);
  if (b58 && b58.length === 64) return b58;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    const b = Buffer.from(s, "base64");
    if (b.length === 64) return new Uint8Array(b);
  }
  return null;
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function verifyEd25519(wallet: string, message: string, signature: Uint8Array): boolean {
  const pub = base58Decode(wallet);
  if (!pub || pub.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export const newNonce = () => randomBytes(16).toString("hex");
export const NONCE_RE = /^[0-9a-f]{32}$/;

export function buildMessage(p: { domain: string; wallet: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.wallet,
    "",
    "Sign in to Ringside. This request will not trigger a transaction or cost any fee.",
    "",
    `Nonce: ${p.nonce}`,
    `Issued At: ${new Date(p.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(p.expiresAt).toISOString()}`,
  ].join("\n");
}

/** Pulls the nonce out of a message so the issued record can be looked up. */
export function nonceOf(message: string): string | null {
  const m = /\nNonce: ([0-9a-f]{32})\n/.exec(message);
  return m ? m[1] : null;
}
