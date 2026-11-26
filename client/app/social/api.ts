import { COPY, INDEXER, SOCIAL, SPONSOR } from "./config";
import { getToken, clearToken, type Aud, type Tokens } from "./auth";
import type { CopyIntent, CopySettings, LeaderRow, TokenFlags, Trade, Window, WalletStats } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function call(base: string, path: string, opts: { method?: string; body?: unknown; auth?: Aud } = {}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const token = opts.auth ? getToken(opts.auth) : null;
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: opts.method ?? "GET", headers, signal: AbortSignal.timeout(20_000),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError("Service unreachable. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (res.status === 401 && opts.auth) clearToken();
  if (!res.ok) {
    const d = (data ?? {}) as { error?: unknown; message?: unknown; code?: unknown };
    const msg = typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, typeof d.code === "string" ? d.code : undefined);
  }
  return data;
}

const list = (d: unknown, key: string): unknown[] =>
  Array.isArray(d) ? d : Array.isArray((d as Record<string, unknown>)?.[key]) ? ((d as Record<string, unknown>)[key] as unknown[]) : [];
const obj = (d: unknown): Record<string, unknown> => (d && typeof d === "object" ? (d as Record<string, unknown>) : {});
const enc = encodeURIComponent;

// --- Indexer (public) ---------------------------------------------------------
export const indexer = {
  feed: async (wallets: string[], limit = 50) =>
    list(await call(INDEXER, `/feed?wallets=${enc(wallets.join(","))}&limit=${limit}`), "trades") as Trade[],
  wallet: async (addr: string) => (await call(INDEXER, `/wallet/${enc(addr)}`)) as WalletStats,
  flags: async (mint: string) => (await call(INDEXER, `/token/${enc(mint)}/flags`)) as TokenFlags,
  leaderboard: async (window: Window) =>
    list(await call(INDEXER, `/leaderboard?window=${window}&by=pnl&limit=50`), "entries") as LeaderRow[],
};

// --- Social (bearer token) ----------------------------------------------------
export const social = {
  nonce: async (wallet: string) => {
    const d = obj(await call(SOCIAL, "/auth/nonce", { method: "POST", body: { wallet } }));
    if (typeof d.message !== "string") throw new ApiError("Unexpected sign-in response.", 0);
    return { nonce: String(d.nonce ?? ""), message: d.message };
  },
  verify: async (wallet: string, message: string, signature: string) => {
    const d = obj(await call(SOCIAL, "/auth/verify", { method: "POST", body: { wallet, message, signature } }));
    const t = obj(d.tokens);
    if (typeof t.social !== "string" || typeof t.copy !== "string" || typeof t.sponsor !== "string") throw new ApiError("Sign-in was refused.", 0);
    return { social: t.social, copy: t.copy, sponsor: t.sponsor } as Tokens;
  },
  me: async () => obj(await call(SOCIAL, "/me", { auth: "social" })),
  putMe: async (body: Record<string, unknown>) => obj(await call(SOCIAL, "/me", { method: "PUT", body, auth: "social" })),
  user: async (wallet: string) => obj(await call(SOCIAL, `/users/${enc(wallet)}`, { auth: "social" })),
  follows: async (): Promise<string[]> => {
    const rows = list(await call(SOCIAL, "/follows", { auth: "social" }), "follows");
    return rows.map((r) => typeof r === "string" ? r : String(obj(r).wallet ?? obj(r).leader ?? obj(r).following ?? "")).filter(Boolean);
  },
  follow: (w: string) => call(SOCIAL, `/follows/${enc(w)}`, { method: "POST", auth: "social" }),
  unfollow: (w: string) => call(SOCIAL, `/follows/${enc(w)}`, { method: "DELETE", auth: "social" }),
  getCopy: async (leader: string): Promise<CopySettings | null> => {
    try { return (await call(SOCIAL, `/copy-settings/${enc(leader)}`, { auth: "social" })) as CopySettings | null; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
  },
  putCopy: async (leader: string, s: CopySettings) =>
    (await call(SOCIAL, `/copy-settings/${enc(leader)}`, { method: "PUT", body: s, auth: "social" })) as CopySettings,
  notifications: async () => list(await call(SOCIAL, "/notifications", { auth: "social" }), "notifications"),
};

// --- Copy engine (bearer token) ----------------------------------------------
export const copy = {
  pending: async (): Promise<CopyIntent[]> =>
    list(await call(COPY, "/intents?status=pending", { auth: "copy" }), "intents") as CopyIntent[],
  /** Unsigned transaction (base64) plus any extra fields the engine returns (e.g. fees). */
  build: async (id: string) => {
    const d = obj(await call(COPY, `/intents/${enc(id)}/build`, { method: "POST", auth: "copy" }));
    if (typeof d.transaction !== "string") throw new ApiError("The copy engine returned no transaction.", 0);
    return d as { transaction: string } & Record<string, unknown>;
  },
  sent: (id: string, signature: string) => call(COPY, `/intents/${enc(id)}/sent`, { method: "POST", body: { signature }, auth: "copy" }),
};

// --- Sponsor ------------------------------------------------------------------
export async function sponsorSend(transaction: string): Promise<{ signature: string; spentLamports?: string }> {
  const d = obj(await call(SPONSOR, "/sponsor", { method: "POST", body: { transaction }, auth: "sponsor" }));
  if (typeof d.signature !== "string") throw new ApiError("The sponsor returned no signature.", 0);
  return { signature: d.signature, spentLamports: d.spentLamports === undefined ? undefined : String(d.spentLamports) };
}

/** Streams /notifications/stream (SSE) with the bearer header; calls onEvent per event. Returns a stop function. */
export function streamNotifications(onEvent: () => void): () => void {
  let stopped = false;
  const ctrl = new AbortController();
  (async () => {
    while (!stopped) {
      try {
        const token = getToken("social");
        if (!token) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        const res = await fetch(`${SOCIAL}/notifications/stream`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (buf.length > 1_000_000) buf = "";
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            if (/^data:/m.test(block)) onEvent();
          }
        }
      } catch { /* reconnect below */ }
      if (!stopped) await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  return () => { stopped = true; ctrl.abort(); };
}
