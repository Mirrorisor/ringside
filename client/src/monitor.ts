/**
 * Keeper monitoring: alert conditions, deduplicated, posted to a webhook
 * (Slack and Discord both accept the payload), plus a /health endpoint for
 * uptime checks.
 *
 * Conditions (each alerts once when it starts and once when it clears; a
 * condition still active is repeated at most hourly):
 *   - stale SOL price (vault price older than 90 s)
 *   - fill lag (an order waiting more than 30 slots past its fill delay)
 *   - a market in reduce-only or ADL
 *   - low SOL on the keeper or relayer (below 0.2 SOL)
 *   - the keeper loop failing repeatedly
 *   - a forfeit, migrate or graduate_market send failing 3 times in a row for one account
 *   - a migrated curve whose market is still tier 0 more than 10 minutes after the migration
 */
import { createServer } from "node:http";

export interface Condition { key: string; active: boolean; message: string }

const REPEAT_MS = 3_600_000;

export class Monitor {
  private open = new Map<string, number>(); // key -> last alert time
  lastTickOk = 0;
  lastTickError = "";
  failures = 0;
  readonly sent: string[] = [];

  constructor(private webhook?: string, private fetchImpl: typeof fetch = fetch, private name = "ringside keeper") {}

  /** Feeds this tick's conditions; returns the alerts it posted. */
  async update(conditions: Condition[]): Promise<string[]> {
    const out: string[] = [];
    const now = Date.now();
    for (const c of conditions) {
      const last = this.open.get(c.key);
      if (c.active && (last === undefined || now - last >= REPEAT_MS)) {
        this.open.set(c.key, now);
        out.push(`⚠️ ${c.message}`);
      } else if (!c.active && last !== undefined) {
        this.open.delete(c.key);
        out.push(`✅ resolved: ${c.message}`);
      }
    }
    for (const text of out) await this.post(text);
    return out;
  }

  private async post(text: string) {
    this.sent.push(text);
    console.log(`[alert] ${text}`);
    if (!this.webhook) return;
    try {
      await this.fetchImpl(this.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[${this.name}] ${text}`, content: `[${this.name}] ${text}` }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      console.warn(`[alert] webhook failed: ${(e as Error).message}`);
    }
  }

  tickSucceeded() {
    this.lastTickOk = Date.now();
    this.failures = 0;
  }
  tickFailed(e: Error) {
    this.failures++;
    this.lastTickError = e.message;
  }

  /** GET /health → 200 while the loop has succeeded in the last `maxAgeMs`, else 503. */
  serve(port: number, maxAgeMs = 60_000) {
    return createServer((req, res) => {
      if (req.url !== "/health") {
        res.writeHead(404).end();
        return;
      }
      const age = Date.now() - this.lastTickOk;
      const healthy = this.lastTickOk > 0 && age < maxAgeMs;
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy, lastTickAgeMs: this.lastTickOk ? age : null, failures: this.failures, lastError: this.lastTickError || null, openAlerts: [...this.open.keys()] }));
    }).listen(port);
  }
}

export const LOW_SOL_LAMPORTS = 200_000_000n;
export const STALE_PRICE_S = 90;
export const FILL_LAG_SLOTS = 30n;

/** Consecutive failures of one crank send before it alerts. */
export const CRANK_FAIL_THRESHOLD = 3;
/** How long a migrated curve's market may stay at tier 0 before it alerts. */
export const MARKET_TIER0_GRACE_MS = 10 * 60_000;

export interface Failure { count: number; error: string }
export type Failures = Map<string, Failure>;

/** Records one attempt of `key` (e.g. "forfeit:<account>"): a success resets the streak to 0, a failure extends it. */
export function recordAttempt(f: Failures, key: string, ok: boolean, error = ""): void {
  f.set(key, ok ? { count: 0, error: "" } : { count: (f.get(key)?.count ?? 0) + 1, error });
}

/** Resets entries with this prefix whose account is no longer a target (e.g. someone else forfeited it): their alert clears. */
export function clearGone(f: Failures, prefix: string, live: ReadonlySet<string>): void {
  for (const [k, v] of f) if (k.startsWith(prefix) && !live.has(k.slice(prefix.length)) && v.count > 0) f.set(k, { count: 0, error: "" });
}

const WHAT: Record<string, string> = { "forfeit:": "forfeit_creator_fees", "migrate:": "migrate", "graduate:": "graduate_market" };

/** One condition per tracked key: active from CRANK_FAIL_THRESHOLD failures in a row, inactive (clears) after a success. */
export function crankConditions(f: Failures): Condition[] {
  return [...f].map(([key, v]) => {
    const prefix = Object.keys(WHAT).find((p) => key.startsWith(p)) ?? "";
    return { key: `crank:${key}`, active: v.count >= CRANK_FAIL_THRESHOLD, message: `${WHAT[prefix] ?? key} for ${key.slice(prefix.length)} failed ${v.count} times in a row${v.error ? `: ${v.error}` : ""}` };
  });
}

/** Drops entries that are back to 0 once their "resolved" alert has been delivered (call after Monitor.update). */
export function pruneCleared(f: Failures): void {
  for (const [k, v] of f) if (v.count === 0) f.delete(k);
}

/**
 * Markets still at tier 0 whose curve migrated more than MARKET_TIER0_GRACE_MS ago. `migratedAt` maps a curve key to
 * when the keeper first saw it migrated (ms); `seen` is updated for newly seen migrated curves.
 */
export function stuckTier0(markets: { key: string; curve: string; tier: number }[], migratedCurves: ReadonlySet<string>, migratedAt: Map<string, number>, nowMs: number): { key: string; active: boolean; sinceMs: number }[] {
  for (const c of migratedCurves) if (!migratedAt.has(c)) migratedAt.set(c, nowMs);
  return markets.filter((m) => migratedAt.has(m.curve)).map((m) => {
    const since = migratedAt.get(m.curve)!;
    return { key: m.key, active: m.tier === 0 && nowMs - since > MARKET_TIER0_GRACE_MS, sinceMs: since };
  });
}

export function tier0Conditions(stuck: { key: string; active: boolean; sinceMs: number }[], nowMs: number): Condition[] {
  return stuck.map((s) => ({ key: `tier0:${s.key}`, active: s.active, message: `market ${s.key} is still tier 0 ${Math.round((nowMs - s.sinceMs) / 60_000)} min after its curve migrated` }));
}
