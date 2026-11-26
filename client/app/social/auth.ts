import { social } from "./api";
import { checkSiwsMessage } from "../../src/appcheck";

/** What main.ts gives us: the active signer (connected wallet, else the local devnet key). */
export interface Signer {
  address(): string;
  signMessage(msg: Uint8Array): Promise<Uint8Array>;
  /** Signs a serialized transaction and returns the serialized signed transaction. */
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
}

const KEY = "ringside.social.token";
/** Each service only accepts a token issued for it (its audience). */
export type Aud = "social" | "copy" | "sponsor";
export type Tokens = Record<Aud, string>;
let tokens: Tokens | null = null;
let tokenWallet: string | null = null;
try {
  const raw = sessionStorage.getItem(KEY);
  if (raw) {
    const o = JSON.parse(raw) as { t?: Partial<Tokens>; w?: string };
    if (o.t?.social && o.t.copy && o.t.sponsor && o.w) { tokens = o.t as Tokens; tokenWallet = o.w; }
  }
} catch { /* sessionStorage unavailable */ }

export const getToken = (aud: Aud = "social") => tokens?.[aud] ?? null;
export const tokenFor = () => tokenWallet;
export function clearToken() {
  tokens = null; tokenWallet = null;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
function setTokens(t: Tokens, w: string) {
  tokens = t; tokenWallet = w;
  try { sessionStorage.setItem(KEY, JSON.stringify({ t, w })); } catch { /* memory only */ }
}

export const b64 = (u: Uint8Array) => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Signed in as the signer's current wallet? */
export const signedIn = (s: Signer) => !!tokens && tokenWallet === s.address();

/** Sign-in with a wallet signature over the server's message; keeps the token in memory and sessionStorage. */
export async function signIn(s: Signer): Promise<void> {
  const wallet = s.address();
  const { message } = await social.nonce(wallet);
  // Never sign a message another site could replay: it must name this site and this wallet, in the SIWS layout.
  checkSiwsMessage(message, { host: location.host, wallet });
  const sig = await s.signMessage(new TextEncoder().encode(message));
  setTokens(await social.verify(wallet, message, b64(sig)), wallet);
}
