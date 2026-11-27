/**
 * SocialPort for the copy service running as its own process: talks to the social backend's loopback-only
 * internal routes (see social/server.ts) with a shared secret. The copy process never opens the social
 * database, so it cannot read nonces or revocations, and the social process stays the only writer (its
 * notification streams are fed by the same notify call that stores the row).
 */
import { MIN_SECRET_BYTES } from "../session.js";
import type { CopyIntent, CopySettings, SocialPort } from "./ports.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function httpSocialPort(opts: { baseUrl: string; secret: string; timeoutMs?: number; fetch?: typeof fetch }): SocialPort {
  if (Buffer.byteLength(opts.secret ?? "", "utf8") < MIN_SECRET_BYTES) throw new Error(`SOCIAL_INTERNAL_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  const base = new URL(opts.baseUrl);
  // The secret goes only to this machine, over plain HTTP.
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(base.hostname)) throw new Error("SOCIAL_INTERNAL_URL must be an http URL on 127.0.0.1, localhost or [::1]");
  const doFetch = opts.fetch ?? fetch;
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await doFetch(new URL(path, base), {
      ...init,
      redirect: "error",
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${opts.secret}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    // Status only: the body and the request (which carries the secret) are never put into the error.
    if (!res.ok) throw new Error(`social internal ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return res.json();
  };
  return {
    async copySettingsForLeader(leader: string): Promise<CopySettings[]> {
      const body = (await call(`/internal/copy/settings?leader=${encodeURIComponent(leader)}`)) as { settings?: unknown };
      if (!body || !Array.isArray(body.settings)) throw new Error("social internal settings: unexpected response");
      return body.settings as CopySettings[];
    },
    async notify(follower: string, intent: CopyIntent): Promise<void> {
      await call("/internal/copy/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ follower, intent }) });
    },
  };
}
