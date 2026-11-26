import { social } from "./api";

/** What main.ts gives us: the active signer (connected wallet, else the local devnet key). */
export interface Signer {
  address(): string;
  signMessage(msg: Uint8Array): Promise<Uint8Array>;
  /** Signs a serialized transaction and returns the serialized signed transaction. */
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
}

const KEY = "ringside.social.token";
let token: string | null = null;
let tokenWallet: string | null = null;
try {
  const raw = sessionStorage.getItem(KEY);
  if (raw) { const o = JSON.parse(raw) as { t?: string; w?: string }; if (o.t && o.w) { token = o.t; tokenWallet = o.w; } }
} catch { /* sessionStorage unavailable */ }

export const getToken = () => token;
export const tokenFor = () => tokenWallet;
export function clearToken() {
  token = null; tokenWallet = null;
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
function setToken(t: string, w: string) {
  token = t; tokenWallet = w;
  try { sessionStorage.setItem(KEY, JSON.stringify({ t, w })); } catch { /* memory only */ }
}

export const b64 = (u: Uint8Array) => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Signed in as the signer's current wallet? */
export const signedIn = (s: Signer) => !!token && tokenWallet === s.address();

/** Sign-in with a wallet signature over the server's message; keeps the token in memory and sessionStorage. */
export async function signIn(s: Signer): Promise<void> {
  const wallet = s.address();
  const { message } = await social.nonce(wallet);
  const sig = await s.signMessage(new TextEncoder().encode(message));
  setToken(await social.verify(wallet, message, b64(sig)), wallet);
}
