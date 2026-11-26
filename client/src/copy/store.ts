/** node:sqlite store for copy intents and per-follower copy positions. */
import { DatabaseSync } from "node:sqlite";
import type { CopyIntent } from "./ports.js";

/** An intent plus the follower's slippage, which is internal (not part of the shared contract). */
export type StoredIntent = CopyIntent & { slippageBps: number; signature?: string };
export interface CopyPosition { tokens: bigint; costLamports: bigint }

type Row = Record<string, unknown>;
const toIntent = (r: Row): StoredIntent => {
  const i: StoredIntent = {
    id: r.id as string, follower: r.follower as string, leader: r.leader as string, sourceSignature: r.source_sig as string,
    kind: r.kind as CopyIntent["kind"], mint: r.mint as string, side: r.side as CopyIntent["side"], venue: r.venue as CopyIntent["venue"],
    createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), status: r.status as CopyIntent["status"], slippageBps: Number(r.slippage_bps),
  };
  if (r.lamports !== null) i.lamports = Number(r.lamports);
  if (r.tokens !== null) i.tokens = r.tokens as string;
  if (r.leverage !== null) i.leverage = Number(r.leverage);
  if (r.skip_reason !== null) i.skipReason = r.skip_reason as string;
  if (r.signature !== null) i.signature = r.signature as string;
  return i;
};
/** The shape returned to callers outside the service. */
export const publicIntent = ({ slippageBps: _s, signature: _g, ...i }: StoredIntent): CopyIntent => i;

export class CopyStore {
  private db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        id TEXT PRIMARY KEY, follower TEXT NOT NULL, leader TEXT NOT NULL, source_sig TEXT NOT NULL,
        kind TEXT NOT NULL, mint TEXT NOT NULL, side TEXT NOT NULL, venue TEXT NOT NULL,
        lamports INTEGER, tokens TEXT, leverage REAL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        status TEXT NOT NULL, skip_reason TEXT, slippage_bps INTEGER NOT NULL DEFAULT 100, signature TEXT,
        UNIQUE (follower, source_sig)
      );
      CREATE INDEX IF NOT EXISTS intents_follower ON intents (follower, status, created_at);
      CREATE TABLE IF NOT EXISTS positions (
        follower TEXT NOT NULL, mint TEXT NOT NULL, tokens TEXT NOT NULL, cost_lamports TEXT NOT NULL,
        PRIMARY KEY (follower, mint)
      );
    `);
  }

  /** Inserts the intent, or returns the existing one for the same (follower, sourceSignature). */
  insert(i: StoredIntent): { intent: StoredIntent; created: boolean } {
    const r = this.db.prepare(`INSERT OR IGNORE INTO intents
      (id, follower, leader, source_sig, kind, mint, side, venue, lamports, tokens, leverage, created_at, expires_at, status, skip_reason, slippage_bps)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      i.id, i.follower, i.leader, i.sourceSignature, i.kind, i.mint, i.side, i.venue, i.lamports ?? null, i.tokens ?? null, i.leverage ?? null,
      i.createdAt, i.expiresAt, i.status, i.skipReason ?? null, i.slippageBps);
    if (Number(r.changes) === 1) return { intent: i, created: true };
    return { intent: toIntent(this.db.prepare("SELECT * FROM intents WHERE follower=? AND source_sig=?").get(i.follower, i.sourceSignature) as Row), created: false };
  }

  findBySource(follower: string, sourceSignature: string): StoredIntent | undefined {
    const r = this.db.prepare("SELECT * FROM intents WHERE follower=? AND source_sig=?").get(follower, sourceSignature) as Row | undefined;
    return r ? toIntent(r) : undefined;
  }

  get(id: string): StoredIntent | undefined {
    const r = this.db.prepare("SELECT * FROM intents WHERE id=?").get(id) as Row | undefined;
    return r ? toIntent(r) : undefined;
  }

  /** Marks pending intents past their expiry as expired. */
  expireDue(now: number): number {
    return Number(this.db.prepare("UPDATE intents SET status='expired' WHERE status='pending' AND expires_at<=?").run(now).changes);
  }

  list(follower: string, status: CopyIntent["status"] | undefined, now: number, limit = 100): StoredIntent[] {
    this.expireDue(now);
    const rows = (status
      ? this.db.prepare("SELECT * FROM intents WHERE follower=? AND status=? ORDER BY created_at DESC LIMIT ?").all(follower, status, limit)
      : this.db.prepare("SELECT * FROM intents WHERE follower=? ORDER BY created_at DESC LIMIT ?").all(follower, limit)) as Row[];
    return rows.map(toIntent);
  }

  /** Lamports committed since `sinceMs` by intents that can still execute (pending, built, sent). */
  committedSince(follower: string, sinceMs: number, now: number): number {
    this.expireDue(now);
    const r = this.db.prepare(`SELECT COALESCE(SUM(lamports),0) AS s FROM intents
      WHERE follower=? AND created_at>=? AND status IN ('pending','built','sent') AND side IN ('buy','long','short')`).get(follower, sinceMs) as Row;
    return Number(r.s);
  }

  /** Tokens in sells that are pending or built (not yet sent), so they are not sold twice. */
  reservedSellTokens(follower: string, mint: string): bigint {
    const rows = this.db.prepare("SELECT tokens FROM intents WHERE follower=? AND mint=? AND side='sell' AND status IN ('pending','built') AND tokens IS NOT NULL").all(follower, mint) as Row[];
    return rows.reduce((s, r) => s + BigInt(r.tokens as string), 0n);
  }

  position(follower: string, mint: string): CopyPosition {
    const r = this.db.prepare("SELECT tokens, cost_lamports FROM positions WHERE follower=? AND mint=?").get(follower, mint) as Row | undefined;
    return r ? { tokens: BigInt(r.tokens as string), costLamports: BigInt(r.cost_lamports as string) } : { tokens: 0n, costLamports: 0n };
  }

  /** Perp opens minus closes the follower has sent for a mint. */
  openPerps(follower: string, mint: string): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN side='close' THEN -1 ELSE 1 END),0) AS n FROM intents
      WHERE follower=? AND mint=? AND kind='perp' AND status='sent'`).get(follower, mint) as Row;
    return Number(r.n);
  }

  /** pending -> built, recording what the builder quoted. */
  markBuilt(id: string, q: { venue: CopyIntent["venue"]; lamports?: number; tokens?: string }): boolean {
    return Number(this.db.prepare("UPDATE intents SET status='built', venue=?, lamports=COALESCE(?,lamports), tokens=COALESCE(?,tokens) WHERE id=? AND status='pending'")
      .run(q.venue, q.lamports ?? null, q.tokens ?? null, id).changes) === 1;
  }

  /**
   * built -> sent, and updates the follower's copy position (spot only). If
   * `follower` is given it must own the intent. Returns false if the intent
   * is missing, not the follower's or not in `built`.
   */
  markSent(id: string, signature: string, follower?: string): boolean {
    const i = this.get(id);
    if (!i || i.status !== "built" || (follower !== undefined && i.follower !== follower)) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE intents SET status='sent', signature=? WHERE id=? AND status='built'").run(signature, id);
      if (i.kind === "spot" && i.tokens) {
        const p = this.position(i.follower, i.mint);
        const t = BigInt(i.tokens);
        let next: CopyPosition;
        if (i.side === "buy") next = { tokens: p.tokens + t, costLamports: p.costLamports + BigInt(i.lamports ?? 0) };
        else {
          const sold = t > p.tokens ? p.tokens : t;
          const costOut = p.tokens > 0n ? (p.costLamports * sold) / p.tokens : 0n;
          next = { tokens: p.tokens - sold, costLamports: p.costLamports - costOut };
        }
        this.db.prepare("INSERT INTO positions (follower, mint, tokens, cost_lamports) VALUES (?,?,?,?) ON CONFLICT(follower, mint) DO UPDATE SET tokens=excluded.tokens, cost_lamports=excluded.cost_lamports")
          .run(i.follower, i.mint, next.tokens.toString(), next.costLamports.toString());
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  close() { this.db.close(); }
}
