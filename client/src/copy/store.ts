/** node:sqlite store for copy intents and per-follower copy positions. */
import { DatabaseSync } from "node:sqlite";
import type { CopyIntent } from "./ports.js";

/** An intent plus the follower's slippage, which is internal (not part of the shared contract). */
export type StoredIntent = CopyIntent & {
  slippageBps: number; signature?: string;
  /** Slot of the leader's source trade (spot), for the leader-exit check. */
  sourceSlot?: number;
  /** While built: when the built window ends. */
  builtExpiresAt?: number;
  /** When the follower reported the signature. */
  sentAt?: number;
  /** Perp closes: the leader's side that closed. A close only ever touches this side. */
  perpSide?: "long" | "short";
};
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
  if (r.leader_price !== null) i.leaderPrice = Number(r.leader_price);
  if (r.source_slot !== null) i.sourceSlot = Number(r.source_slot);
  if (r.built_expires_at !== null) i.builtExpiresAt = Number(r.built_expires_at);
  if (r.sent_at !== null) i.sentAt = Number(r.sent_at);
  if (r.perp_side !== null && r.perp_side !== undefined) i.perpSide = r.perp_side as "long" | "short";
  return i;
};
/** The shape returned to callers outside the service. */
export const publicIntent = ({ slippageBps: _s, signature: _g, sourceSlot: _o, builtExpiresAt: _b, sentAt: _t, perpSide: _p, ...i }: StoredIntent): CopyIntent => i;

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
        leader_price REAL, source_slot INTEGER, built_expires_at INTEGER, sent_at INTEGER,
        UNIQUE (follower, source_sig)
      );
      CREATE INDEX IF NOT EXISTS intents_follower ON intents (follower, status, created_at);
      CREATE TABLE IF NOT EXISTS positions (
        follower TEXT NOT NULL, mint TEXT NOT NULL, tokens TEXT NOT NULL, cost_lamports TEXT NOT NULL,
        PRIMARY KEY (follower, mint)
      );
      CREATE TABLE IF NOT EXISTS perp_positions (
        follower TEXT NOT NULL, leader TEXT NOT NULL, mint TEXT NOT NULL, side TEXT NOT NULL,
        PRIMARY KEY (follower, leader, mint, side)
      );
      CREATE TABLE IF NOT EXISTS leader_perp_sizes (
        leader TEXT NOT NULL, mint TEXT NOT NULL, side TEXT NOT NULL, size_usd REAL NOT NULL, prev_size_usd REAL, signature TEXT NOT NULL,
        PRIMARY KEY (leader, mint, side)
      );
      CREATE TABLE IF NOT EXISTS leader_sells (
        signature TEXT PRIMARY KEY, leader TEXT NOT NULL, mint TEXT NOT NULL, slot INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS leader_sells_lm ON leader_sells (leader, mint, slot);
    `);
    // Databases created before these columns existed.
    const have = new Set((this.db.prepare("PRAGMA table_info(intents)").all() as Row[]).map((c) => c.name as string));
    for (const [col, type] of [["leader_price", "REAL"], ["source_slot", "INTEGER"], ["built_expires_at", "INTEGER"], ["sent_at", "INTEGER"], ["perp_side", "TEXT"]]) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE intents ADD COLUMN ${col} ${type}`);
    }
    // A signature can prove at most one intent.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS intents_signature ON intents (signature) WHERE signature IS NOT NULL");
  }

  /** Inserts the intent, or returns the existing one for the same (follower, sourceSignature). */
  insert(i: StoredIntent): { intent: StoredIntent; created: boolean } {
    const r = this.db.prepare(`INSERT OR IGNORE INTO intents
      (id, follower, leader, source_sig, kind, mint, side, venue, lamports, tokens, leverage, created_at, expires_at, status, skip_reason, slippage_bps, leader_price, source_slot, perp_side)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      i.id, i.follower, i.leader, i.sourceSignature, i.kind, i.mint, i.side, i.venue, i.lamports ?? null, i.tokens ?? null, i.leverage ?? null,
      i.createdAt, i.expiresAt, i.status, i.skipReason ?? null, i.slippageBps, i.leaderPrice ?? null, i.sourceSlot ?? null, i.perpSide ?? null);
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

  /**
   * Time-based transitions. A built intent whose built window ended goes back to
   * pending if the intent itself has not expired, else expires. Pending intents
   * past their expiry expire. Both release reservations and daily-cap usage.
   */
  expireDue(now: number): number {
    let n = 0;
    n += Number(this.db.prepare("UPDATE intents SET status='expired', built_expires_at=NULL WHERE status='built' AND built_expires_at IS NOT NULL AND built_expires_at<=? AND expires_at<=?").run(now, now).changes);
    n += Number(this.db.prepare("UPDATE intents SET status='pending', built_expires_at=NULL WHERE status='built' AND built_expires_at IS NOT NULL AND built_expires_at<=?").run(now).changes);
    n += Number(this.db.prepare("UPDATE intents SET status='expired' WHERE status='pending' AND expires_at<=?").run(now).changes);
    return n;
  }

  list(follower: string, status: CopyIntent["status"] | undefined, now: number, limit = 100): StoredIntent[] {
    this.expireDue(now);
    const rows = (status
      ? this.db.prepare("SELECT * FROM intents WHERE follower=? AND status=? ORDER BY created_at DESC LIMIT ?").all(follower, status, limit)
      : this.db.prepare("SELECT * FROM intents WHERE follower=? ORDER BY created_at DESC LIMIT ?").all(follower, limit)) as Row[];
    return rows.map(toIntent);
  }

  /** Lamports committed since `sinceMs` by intents that can still execute or may have executed (pending, built, sent_unconfirmed, sent). */
  committedSince(follower: string, sinceMs: number, now: number): number {
    this.expireDue(now);
    const r = this.db.prepare(`SELECT COALESCE(SUM(lamports),0) AS s FROM intents
      WHERE follower=? AND created_at>=? AND status IN ('pending','built','sent_unconfirmed','sent') AND side IN ('buy','long','short')`).get(follower, sinceMs) as Row;
    return Number(r.s);
  }

  /** Tokens in sells that are pending, built or sent but not yet confirmed (the position is not reduced yet), so they are not sold twice. */
  reservedSellTokens(follower: string, mint: string): bigint {
    const rows = this.db.prepare("SELECT tokens FROM intents WHERE follower=? AND mint=? AND side='sell' AND status IN ('pending','built','sent_unconfirmed') AND tokens IS NOT NULL").all(follower, mint) as Row[];
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

  /** Whether `follower` holds a perp position on `side` of `mint` that came from copying `leader` (confirmed on chain). */
  copiedPerp(follower: string, leader: string, mint: string, side: "long" | "short"): boolean {
    return !!this.db.prepare("SELECT 1 FROM perp_positions WHERE follower=? AND leader=? AND mint=? AND side=?").get(follower, leader, mint, side);
  }

  /**
   * Records the leader's position size after a perp open/increase event and returns the size before it, or null if
   * that is not known (first event seen for this leader/market/side, or the size did not grow, which means the
   * record is stale, for example after a liquidation that is not an event here). Replaying the same signature
   * returns the same answer. `prevSizeUsd` is the event's own previous size when the source knows it.
   */
  leaderPerpStep(leader: string, mint: string, side: "long" | "short", sizeUsd: number, signature: string, prevSizeUsd?: number): number | null {
    const r = this.db.prepare("SELECT size_usd, prev_size_usd, signature FROM leader_perp_sizes WHERE leader=? AND mint=? AND side=?").get(leader, mint, side) as Row | undefined;
    if (r && r.signature === signature) return r.prev_size_usd === null ? null : Number(r.prev_size_usd);
    let prev: number | null = prevSizeUsd !== undefined && Number.isFinite(prevSizeUsd) && prevSizeUsd >= 0 ? prevSizeUsd : r ? Number(r.size_usd) : null;
    if (prev !== null && !(sizeUsd > prev)) prev = null;
    this.db.prepare(`INSERT INTO leader_perp_sizes (leader, mint, side, size_usd, prev_size_usd, signature) VALUES (?,?,?,?,?,?)
      ON CONFLICT(leader, mint, side) DO UPDATE SET size_usd=excluded.size_usd, prev_size_usd=excluded.prev_size_usd, signature=excluded.signature`)
      .run(leader, mint, side, sizeUsd, prev, signature);
    return prev;
  }

  /** The leader closed a side: its next open starts from zero. */
  leaderPerpClosed(leader: string, mint: string, side: "long" | "short", signature: string): void {
    this.db.prepare(`INSERT INTO leader_perp_sizes (leader, mint, side, size_usd, prev_size_usd, signature) VALUES (?,?,?,0,NULL,?)
      ON CONFLICT(leader, mint, side) DO UPDATE SET size_usd=0, prev_size_usd=NULL, signature=excluded.signature`).run(leader, mint, side, signature);
  }

  /** pending -> built, recording what the builder quoted. The built state lapses at `builtExpiresAt` (ms) if given. */
  markBuilt(id: string, q: { venue: CopyIntent["venue"]; lamports?: number; tokens?: string }, builtExpiresAt?: number): boolean {
    return Number(this.db.prepare("UPDATE intents SET status='built', venue=?, lamports=COALESCE(?,lamports), tokens=COALESCE(?,tokens), built_expires_at=? WHERE id=? AND status='pending'")
      .run(q.venue, q.lamports ?? null, q.tokens ?? null, builtExpiresAt ?? null, id).changes) === 1;
  }

  /** pending -> skipped, when a build-time check refuses the intent for good. */
  markRefused(id: string, reason: string): boolean {
    return Number(this.db.prepare("UPDATE intents SET status='skipped', skip_reason=? WHERE id=? AND status='pending'").run(reason, id).changes) === 1;
  }

  /**
   * built -> sent_unconfirmed. This only records the signature the follower
   * reports; nothing is proven and no position changes until `confirmSent`.
   * The signature must be unused by any other intent. If `follower` is given
   * it must own the intent. Returns false if the intent is missing, not the
   * follower's, not in `built`, or the signature is taken.
   */
  markSent(id: string, signature: string, follower?: string, now = Date.now()): boolean {
    const i = this.get(id);
    if (!i || i.status !== "built" || (follower !== undefined && i.follower !== follower)) return false;
    try {
      return Number(this.db.prepare("UPDATE intents SET status='sent_unconfirmed', signature=?, sent_at=?, built_expires_at=NULL WHERE id=? AND status='built'").run(signature, now, id).changes) === 1;
    } catch (e) {
      if (/UNIQUE|constraint/i.test((e as Error).message)) return false;
      throw e;
    }
  }

  /**
   * sent_unconfirmed -> sent, once the chain proved it. `tokenDelta` is the
   * follower's actual token balance change in the transaction (positive for a
   * buy, the amount sold for a sell); it, not the quote, moves the position (spot only).
   */
  confirmSent(id: string, tokenDelta: bigint): boolean {
    const i = this.get(id);
    if (!i || i.status !== "sent_unconfirmed") return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE intents SET status='sent' WHERE id=? AND status='sent_unconfirmed'").run(id);
      if (i.kind === "spot") {
        const p = this.position(i.follower, i.mint);
        const t = tokenDelta < 0n ? -tokenDelta : tokenDelta;
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
      if (i.kind === "perp") {
        if (i.side === "long" || i.side === "short") {
          this.db.prepare("INSERT OR IGNORE INTO perp_positions (follower, leader, mint, side) VALUES (?,?,?,?)").run(i.follower, i.leader, i.mint, i.side);
        } else if (i.side === "close" && i.perpSide) {
          this.db.prepare("DELETE FROM perp_positions WHERE follower=? AND leader=? AND mint=? AND side=?").run(i.follower, i.leader, i.mint, i.perpSide);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  /** sent_unconfirmed -> failed: the chain refused it, or it never landed. Releases the reservation and cap usage. */
  markFailed(id: string): boolean {
    return Number(this.db.prepare("UPDATE intents SET status='failed' WHERE id=? AND status='sent_unconfirmed'").run(id).changes) === 1;
  }

  unconfirmed(limit = 200): StoredIntent[] {
    return (this.db.prepare("SELECT * FROM intents WHERE status='sent_unconfirmed' ORDER BY sent_at LIMIT ?").all(limit) as Row[]).map(toIntent);
  }

  /** Records a leader's sell, so builds of that leader's earlier buys can be refused. */
  recordLeaderSell(leader: string, mint: string, slot: number, signature: string): void {
    this.db.prepare("INSERT OR IGNORE INTO leader_sells (signature, leader, mint, slot) VALUES (?,?,?,?)").run(signature, leader, mint, slot);
  }

  /** LeaderExitPort: did the leader sell `mint` in or after the source trade's slot (another transaction)? */
  async leaderSoldSince(leader: string, mint: string, source: { signature: string; slot: number }): Promise<boolean> {
    return !!this.db.prepare("SELECT 1 FROM leader_sells WHERE leader=? AND mint=? AND slot>=? AND signature<>? LIMIT 1").get(leader, mint, source.slot, source.signature);
  }

  close() { this.db.close(); }
}
