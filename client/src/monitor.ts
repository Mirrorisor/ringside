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
