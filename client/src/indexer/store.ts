/**
 * Indexer storage: an interface and a `node:sqlite` implementation.
 * Ingest is idempotent on transaction signature: a signature already seen
 * is skipped as a whole.
 *
 * Leaderboard aggregates are maintained incrementally, in the same
 * transaction as the trades they come from:
 *  - `positions`: average-cost state per (wallet, mint, quote), applied in
 *    trade order (timestamp, slot, signature). A trade that arrives older
 *    than the last one applied rebuilds just that position from `trades`.
 *  - `agg_hourly`: per (wallet, mint, quote, hour) volume, trade counts and
 *    realised PnL (attributed to the sell's hour). Leaderboard windows are
 *    therefore aligned down to the hour (a "24h" board covers 24-25 hours).
 *  - `funding_links` / `wash_positions`: the wash-trading dampener, below.
 *
 * Wash-trading dampener: two wallets are linked when one sent the other at
 * least WASH_MIN_FUNDING_LAMPORTS in a single stored SOL transfer (either
 * direction, any time). When linked wallets both trade the same mint, that
 * mint's positions of both wallets are marked and their PnL, volume and
 * trades are left out of the leaderboard (and reported per entry as
 * `washExcluded`). Limits, honestly:
 *  - one hop only: wallets funded through an intermediary, a CEX, a bridge,
 *    a token transfer or a swap are not linked;
 *  - funding below the threshold, or split into smaller transfers, is not
 *    seen; transfers inside trade transactions and those touching our
 *    sponsor are not stored at all;
 *  - it does not detect actual round trips (A sells to B), only "linked
 *    wallets traded the same mint", so it can over-exclude;
 *  - it can be griefed: anyone can send a top trader the threshold amount
 *    from a wallet that then trades the same mints, excluding those mints.
 *    The attacker pays the threshold per victim; the victim is excluded,
 *    not promoted, so this cannot push an attacker up the board.
 *  - /wallet stats are unaffected (they show the wallet's raw history).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { applyTrade, compareTrades, type LeaderboardMetric } from "./stats.js";
import { DEAD_PRICE_DROP, DEAD_QUIET_AFTER_SECONDS, DEAD_WINDOW_SECONDS, GRADUATED_SOURCE, isSerialRugger, type CoinStatus, type CreatorCoin, type CreatorStats } from "./creators.js";
import type { Launch, ParsedTx, Quote, SolTransfer, Trade } from "./types.js";

/** A single SOL transfer at least this large links two wallets for the wash dampener (0.05 SOL). */
export const WASH_MIN_FUNDING_LAMPORTS = 50_000_000;
/** Leaderboard bucket size (seconds). */
export const AGG_BUCKET_SECONDS = 3_600;
const AGG_VERSION = "2";

export interface LeaderboardQuery {
  sinceTimestamp: number;
  by: LeaderboardMetric;
  limit: number;
  /** Minimum SOL volume (non-wash) in the window to be ranked. */
  minVolumeSol: number;
  /** Minimum trade count (non-wash) in the window to be ranked. */
  minTrades: number;
}

export interface LeaderboardRow {
  wallet: string;
  value: number;
  realisedPnl: Record<Quote, number>;
  volume: Record<Quote, number>;
  trades: number;
  buys: number;
  sells: number;
  winRate: number | null;
  tokensTraded: number;
  /** Activity left out by the wash dampener. */
  washExcluded: { positions: number; trades: number; volumeSol: number; pnlSol: number };
}

export interface Store {
  /** Stores one parsed transaction; false if its signature was already ingested. */
  ingest(tx: ParsedTx): boolean;
  /** Stores many in one transaction; per-transaction result as for `ingest`. */
  ingestMany(txs: ParsedTx[]): boolean[];
  /** Most recent trades of any of `wallets`, newest first. */
  feed(wallets: string[], limit: number, beforeTimestamp?: number): Trade[];
  /** All trades of one wallet, oldest first. */
  walletTrades(wallet: string): Trade[];
  /** All trades of one mint, oldest first. */
  mintTrades(mint: string): Trade[];
  launch(mint: string): Launch | undefined;
  /**
   * Stores trades for transactions already ingested (a background signer lookup resolved who
   * traded). Idempotent per (signature, wallet, mint); returns how many were new.
   */
  addTrades(trades: Trade[]): number;
  /** A creator's launch history, as SQL aggregates over launches and per-mint stats. */
  creatorStats(creator: string, nowSec: number): CreatorStats;
  /** A creator's most recent coins, newest first. */
  creatorCoins(creator: string, nowSec: number, limit: number): CreatorCoin[];
  /** SOL transfers from `from` to any of `to` (any number of recipients). */
  transfersFrom(from: string, to: string[]): SolTransfer[];
  /** SOL transfers from `from` to any wallet that bought `mint`. */
  transfersToBuyers(from: string, mint: string): SolTransfer[];
  /** Leaderboard ranked in SQL over the stored aggregates. */
  leaderboard(q: LeaderboardQuery): LeaderboardRow[];
  /** Positions (wallet, mint) marked by the wash dampener. */
  washPositions(wallet: string): string[];
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS transactions (
  signature TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS trades (
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  token_amount REAL NOT NULL,
  quote TEXT NOT NULL CHECK (quote IN ('SOL','USDC')),
  quote_amount REAL NOT NULL,
  slot INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (signature, wallet, mint)
);
CREATE INDEX IF NOT EXISTS trades_wallet_time ON trades (wallet, timestamp DESC);
-- Position rebuilds (out-of-order trades, upgrades) look up by (wallet, mint, quote).
CREATE INDEX IF NOT EXISTS trades_wallet_mint ON trades (wallet, mint, quote);
CREATE INDEX IF NOT EXISTS trades_mint_slot ON trades (mint, slot);
CREATE TABLE IF NOT EXISTS sol_transfers (
  signature TEXT NOT NULL,
  idx INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  lamports INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS sol_transfers_from_to ON sol_transfers (from_addr, to_addr);
CREATE TABLE IF NOT EXISTS launches (
  mint TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  slot INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  signature TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS launches_creator ON launches (creator);
-- One row per traded mint, maintained with the trades: first/last trade, the 24h price window
-- (peak and last SOL price per token) and trades after the first hour. Feeds creator reputation.
CREATE TABLE IF NOT EXISTS token_stats (
  mint TEXT PRIMARY KEY,
  first_ts INTEGER NOT NULL,
  peak_price REAL,
  last_price REAL,
  last_ts INTEGER NOT NULL DEFAULT 0,
  last_slot INTEGER NOT NULL DEFAULT 0,
  last_sig TEXT NOT NULL DEFAULT '',
  late_trades INTEGER NOT NULL DEFAULT 0,
  graduated INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS positions (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote TEXT NOT NULL,
  token_amount REAL NOT NULL,
  cost_basis REAL NOT NULL,
  last_ts INTEGER NOT NULL,
  last_slot INTEGER NOT NULL,
  last_sig TEXT NOT NULL,
  PRIMARY KEY (wallet, mint, quote)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS positions_mint ON positions (mint, wallet);
CREATE TABLE IF NOT EXISTS agg_hourly (
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  quote TEXT NOT NULL,
  hour INTEGER NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  buys INTEGER NOT NULL DEFAULT 0,
  sells INTEGER NOT NULL DEFAULT 0,
  pnl REAL NOT NULL DEFAULT 0,
  realised INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, mint, quote, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS agg_hourly_hour ON agg_hourly (hour);
CREATE TABLE IF NOT EXISTS funding_links (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS wash_positions (wallet TEXT NOT NULL, mint TEXT NOT NULL, PRIMARY KEY (wallet, mint)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

/** Metric expressions over the leaderboard CTE (a fixed whitelist, never user text). */
const METRIC_SQL: Record<LeaderboardMetric, string> = {
  pnl: "pnl_sol",
  volume: "vol_sol",
  trades: "trades",
  winrate: "CASE WHEN realised > 0 THEN CAST(wins AS REAL) / realised ELSE -1 END",
};

const LEADERBOARD_SQL = (metric: string) => `
WITH pos AS (
  SELECT h.wallet AS wallet, h.mint AS mint, h.quote AS quote,
    SUM(h.volume) AS volume, SUM(h.trades) AS trades, SUM(h.buys) AS buys, SUM(h.sells) AS sells,
    SUM(h.pnl) AS pnl, MAX(h.realised) AS realised, (x.wallet IS NOT NULL) AS wash
  FROM agg_hourly h LEFT JOIN wash_positions x ON x.wallet = h.wallet AND x.mint = h.mint
  WHERE h.hour >= ?
  GROUP BY h.wallet, h.mint, h.quote
), w AS (
  SELECT wallet,
    SUM(CASE WHEN wash = 0 AND quote = 'SOL' THEN pnl ELSE 0 END) AS pnl_sol,
    SUM(CASE WHEN wash = 0 AND quote = 'USDC' THEN pnl ELSE 0 END) AS pnl_usdc,
    SUM(CASE WHEN wash = 0 AND quote = 'SOL' THEN volume ELSE 0 END) AS vol_sol,
    SUM(CASE WHEN wash = 0 AND quote = 'USDC' THEN volume ELSE 0 END) AS vol_usdc,
    SUM(CASE WHEN wash = 0 THEN trades ELSE 0 END) AS trades,
    SUM(CASE WHEN wash = 0 THEN buys ELSE 0 END) AS buys,
    SUM(CASE WHEN wash = 0 THEN sells ELSE 0 END) AS sells,
    SUM(CASE WHEN wash = 0 THEN realised ELSE 0 END) AS realised,
    SUM(CASE WHEN wash = 0 AND realised = 1 AND pnl > 0 THEN 1 ELSE 0 END) AS wins,
    COUNT(DISTINCT CASE WHEN wash = 0 THEN mint END) AS tokens,
    SUM(wash) AS wash_positions,
    SUM(CASE WHEN wash = 1 THEN trades ELSE 0 END) AS wash_trades,
    SUM(CASE WHEN wash = 1 AND quote = 'SOL' THEN volume ELSE 0 END) AS wash_vol_sol,
    SUM(CASE WHEN wash = 1 AND quote = 'SOL' THEN pnl ELSE 0 END) AS wash_pnl_sol
  FROM pos GROUP BY wallet
)
SELECT *, ${metric} AS value FROM w
WHERE trades > 0 AND vol_sol >= ? AND trades >= ?
ORDER BY value DESC, wallet ASC
LIMIT ?`;

/** A coin's verdict, over `launches l LEFT JOIN token_stats s`; params: now (for maturity), drop threshold. Shared by the aggregate and the list. */
const COIN_COLS = `
  COALESCE(s.first_ts, l.timestamp) <= ? - ${DEAD_WINDOW_SECONDS} AS mature,
  (s.mint IS NULL OR s.late_trades = 0 OR (s.peak_price > 0 AND s.last_price <= s.peak_price * (1 - ?))) AS dead,
  COALESCE(s.graduated, 0) AS graduated`;

type Row = Record<string, unknown>;
const toTrade = (r: Row): Trade => ({
  signature: r.signature as string, wallet: r.wallet as string, mint: r.mint as string, side: r.side as Trade["side"],
  tokenAmount: r.token_amount as number, quote: r.quote as Trade["quote"], quoteAmount: r.quote_amount as number,
  slot: r.slot as number, timestamp: r.timestamp as number, source: r.source as string,
});
const TRADE_COLS = "signature, wallet, mint, side, token_amount, quote, quote_amount, slot, timestamp, source";

interface PositionRow { token_amount: number; cost_basis: number; last_ts: number; last_slot: number; last_sig: string }
const toTransfer = (r: Row): SolTransfer => ({ signature: r.signature as string, from: r.from_addr as string, to: r.to_addr as string, lamports: r.lamports as number, slot: r.slot as number, timestamp: r.timestamp as number });
const hourOf = (timestamp: number) => Math.floor(timestamp / AGG_BUCKET_SECONDS);

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  /**
   * `readOnly` is for a second process (the copy service) reading a file the indexer owns: it opens the
   * file read-only, runs no schema, pragma or aggregate rebuild, and waits up to 5 s on a busy database.
   * The file must already exist (the indexer creates it, in WAL mode, so readers never block its writes
   * nor see half a transaction). Any write method then throws.
   */
  constructor(path = ":memory:", opts: { readOnly?: boolean } = {}) {
    if (opts.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      this.db.exec("PRAGMA busy_timeout = 5000");
      return;
    }
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    const v = this.db.prepare("SELECT value FROM meta WHERE key = 'agg_version'").get() as Row | undefined;
    if (v?.value !== AGG_VERSION) this.rebuildAggregates();
  }

  /** Cached prepared statement. */
  private q(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (!st) this.stmts.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  ingest(tx: ParsedTx): boolean {
    return this.ingestMany([tx])[0];
  }

  ingestMany(txs: ParsedTx[]): boolean[] {
    const db = this.db;
    const out: boolean[] = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const tx of txs) {
        db.exec("SAVEPOINT tx");
        try {
          out.push(this.ingestOne(tx));
          db.exec("RELEASE tx");
        } catch (e) {
          db.exec("ROLLBACK TO tx");
          db.exec("RELEASE tx");
          throw e;
        }
      }
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  private ingestOne(tx: ParsedTx): boolean {
    const r = this.q("INSERT OR IGNORE INTO transactions (signature, slot, timestamp, ingested_at) VALUES (?, ?, ?, ?)").run(tx.signature, tx.slot, tx.timestamp, Date.now());
    if (Number(r.changes) === 0) return false;
    const ins = this.q(`INSERT OR IGNORE INTO trades (${TRADE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of tx.trades) {
      const tr = ins.run(t.signature, t.wallet, t.mint, t.side, t.tokenAmount, t.quote, t.quoteAmount, t.slot, t.timestamp, t.source);
      if (Number(tr.changes) > 0) { this.aggregateTrade(t); this.updateTokenStats(t); }
    }
    const trs = this.q("INSERT OR IGNORE INTO sol_transfers (signature, idx, from_addr, to_addr, lamports, slot, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)");
    tx.transfers.forEach((t, i) => {
      trs.run(t.signature, i, t.from, t.to, t.lamports, t.slot, t.timestamp);
      if (t.lamports >= WASH_MIN_FUNDING_LAMPORTS) this.linkWallets(t.from, t.to);
    });
    const la = this.q("INSERT OR IGNORE INTO launches (mint, creator, slot, timestamp, signature) VALUES (?, ?, ?, ?, ?)");
    for (const l of tx.launches) la.run(l.mint, l.creator, l.slot, l.timestamp, l.signature);
    return true;
  }

  addTrades(trades: Trade[]): number {
    const db = this.db;
    let n = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const ins = this.q(`INSERT OR IGNORE INTO trades (${TRADE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of trades) {
        const tr = ins.run(t.signature, t.wallet, t.mint, t.side, t.tokenAmount, t.quote, t.quoteAmount, t.slot, t.timestamp, t.source);
        if (Number(tr.changes) > 0) { this.aggregateTrade(t); this.updateTokenStats(t); n++; }
      }
      db.exec("COMMIT");
      return n;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Folds one new (already inserted) trade into its mint's stats; an earlier first trade recomputes the mint. */
  private updateTokenStats(t: Trade) {
    const r = this.q("SELECT first_ts, peak_price, last_price, last_ts, last_slot, last_sig, late_trades, graduated FROM token_stats WHERE mint = ?").get(t.mint) as Row | undefined;
    if (!r || t.timestamp < (r.first_ts as number)) return this.rebuildTokenStats(t.mint);
    const first = r.first_ts as number;
    let peak = r.peak_price as number | null, last = r.last_price as number | null;
    let [lts, lslot, lsig] = [r.last_ts as number, r.last_slot as number, r.last_sig as string];
    if (t.quote === "SOL" && t.tokenAmount > 0 && Number.isFinite(t.quoteAmount) && t.timestamp <= first + DEAD_WINDOW_SECONDS) {
      const price = t.quoteAmount / t.tokenAmount;
      peak = peak === null ? price : Math.max(peak, price);
      if (last === null || compareTrades(t, { timestamp: lts, slot: lslot, signature: lsig }) > 0) [last, lts, lslot, lsig] = [price, t.timestamp, t.slot, t.signature];
    }
    this.q("UPDATE token_stats SET peak_price = ?, last_price = ?, last_ts = ?, last_slot = ?, last_sig = ?, late_trades = late_trades + ?, graduated = ? WHERE mint = ?")
      .run(peak, last, lts, lslot, lsig, t.timestamp > first + DEAD_QUIET_AFTER_SECONDS ? 1 : 0, (r.graduated as number) || (t.source === GRADUATED_SOURCE ? 1 : 0), t.mint);
  }

  /** Recomputes one mint's stats from its trades (new mint, out-of-order first trade, upgrades). */
  private rebuildTokenStats(mint: string) {
    const f = this.q("SELECT MIN(timestamp) AS first FROM trades WHERE mint = ?").get(mint) as Row;
    if (f.first === null || f.first === undefined) return;
    const first = f.first as number;
    const agg = this.q(`SELECT MAX(CASE WHEN quote = 'SOL' AND token_amount > 0 AND timestamp <= ?1 + ${DEAD_WINDOW_SECONDS} THEN quote_amount / token_amount END) AS peak,
        SUM(timestamp > ?1 + ${DEAD_QUIET_AFTER_SECONDS}) AS late, MAX(source = ?2) AS grad FROM trades WHERE mint = ?3`).get(first, GRADUATED_SOURCE, mint) as Row;
    const last = this.q(`SELECT quote_amount / token_amount AS price, timestamp, slot, signature FROM trades
      WHERE mint = ? AND quote = 'SOL' AND token_amount > 0 AND timestamp <= ? + ${DEAD_WINDOW_SECONDS} ORDER BY timestamp DESC, slot DESC, signature DESC LIMIT 1`).get(mint, first) as Row | undefined;
    this.q(`INSERT OR REPLACE INTO token_stats (mint, first_ts, peak_price, last_price, last_ts, last_slot, last_sig, late_trades, graduated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mint, first, (agg.peak as number | null) ?? null, (last?.price as number | undefined) ?? null, (last?.timestamp as number | undefined) ?? 0, (last?.slot as number | undefined) ?? 0, (last?.signature as string | undefined) ?? "", (agg.late as number) ?? 0, (agg.grad as number) ?? 0);
  }

  creatorStats(creator: string, nowSec: number): CreatorStats {
    const r = this.q(`SELECT COUNT(*) AS launched, COALESCE(SUM(mature), 0) AS matured, COALESCE(SUM(mature AND dead), 0) AS dead, COALESCE(SUM(graduated), 0) AS graduated
      FROM (SELECT ${COIN_COLS} FROM launches l LEFT JOIN token_stats s ON s.mint = l.mint WHERE l.creator = ?)`).get(nowSec, DEAD_PRICE_DROP, creator) as Row;
    const [matured, dead] = [r.matured as number, r.dead as number];
    return { creator, launched: r.launched as number, matured, dead, graduated: r.graduated as number, deadRate: matured > 0 ? dead / matured : null, serialRugger: isSerialRugger(matured, dead) };
  }

  creatorCoins(creator: string, nowSec: number, limit: number): CreatorCoin[] {
    return this.q(`SELECT l.mint AS mint, l.timestamp AS launched_at, s.first_ts AS first_ts, s.peak_price AS peak, s.last_price AS last, ${COIN_COLS}
      FROM launches l LEFT JOIN token_stats s ON s.mint = l.mint WHERE l.creator = ? ORDER BY l.timestamp DESC, l.mint LIMIT ?`)
      .all(nowSec, DEAD_PRICE_DROP, creator, limit)
      .map((r) => ({
        mint: r.mint as string,
        launchedAt: r.launched_at as number,
        firstTradeAt: (r.first_ts as number | null) ?? null,
        peakPrice: (r.peak as number | null) ?? null,
        lastPrice: (r.last as number | null) ?? null,
        graduated: r.graduated === 1,
        status: (r.mature ? (r.dead ? "dead" : "alive") : "pending") as CoinStatus,
      }));
  }

  /** Volume, counts and (in trade order) realised PnL of one new trade. */
  private aggregateTrade(t: Trade) {
    const hour = hourOf(t.timestamp);
    this.q(`INSERT INTO agg_hourly (wallet, mint, quote, hour, volume, trades, buys, sells) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (wallet, mint, quote, hour) DO UPDATE SET volume = volume + excluded.volume, trades = trades + 1, buys = buys + excluded.buys, sells = sells + excluded.sells`)
      .run(t.wallet, t.mint, t.quote, hour, Number.isFinite(t.quoteAmount) ? t.quoteAmount : 0, t.side === "buy" ? 1 : 0, t.side === "sell" ? 1 : 0);
    const p = this.q("SELECT token_amount, cost_basis, last_ts, last_slot, last_sig FROM positions WHERE wallet = ? AND mint = ? AND quote = ?").get(t.wallet, t.mint, t.quote) as PositionRow | undefined;
    if (p && compareTrades(t, { timestamp: p.last_ts, slot: p.last_slot, signature: p.last_sig }) < 0) {
      this.rebuildPosition(t.wallet, t.mint, t.quote);
      return;
    }
    const state = { tokenAmount: p?.token_amount ?? 0, costBasis: p?.cost_basis ?? 0 };
    const pnl = applyTrade(state, t);
    if (pnl !== null) this.addPnl(t.wallet, t.mint, t.quote, hour, pnl);
    this.savePosition(t.wallet, t.mint, t.quote, state, t);
    if (!p) this.markWashForNewPosition(t.wallet, t.mint);
  }

  private addPnl(wallet: string, mint: string, quote: string, hour: number, pnl: number) {
    this.q("UPDATE agg_hourly SET pnl = pnl + ?, realised = 1 WHERE wallet = ? AND mint = ? AND quote = ? AND hour = ?").run(pnl, wallet, mint, quote, hour);
  }

  private savePosition(wallet: string, mint: string, quote: string, s: { tokenAmount: number; costBasis: number }, last: Trade) {
    this.q(`INSERT INTO positions (wallet, mint, quote, token_amount, cost_basis, last_ts, last_slot, last_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (wallet, mint, quote) DO UPDATE SET token_amount = excluded.token_amount, cost_basis = excluded.cost_basis,
        last_ts = excluded.last_ts, last_slot = excluded.last_slot, last_sig = excluded.last_sig`)
      .run(wallet, mint, quote, s.tokenAmount, s.costBasis, last.timestamp, last.slot, last.signature);
  }

  /** Recomputes one position's realised PnL from its stored trades (out-of-order arrival). */
  private rebuildPosition(wallet: string, mint: string, quote: string) {
    this.q("UPDATE agg_hourly SET pnl = 0, realised = 0 WHERE wallet = ? AND mint = ? AND quote = ?").run(wallet, mint, quote);
    const trades = this.q(`SELECT ${TRADE_COLS} FROM trades INDEXED BY trades_wallet_mint WHERE wallet = ? AND mint = ? AND quote = ?`).all(wallet, mint, quote).map(toTrade).sort(compareTrades);
    const state = { tokenAmount: 0, costBasis: 0 };
    for (const t of trades) {
      const pnl = applyTrade(state, t);
      if (pnl !== null) this.addPnl(wallet, mint, quote, hourOf(t.timestamp), pnl);
    }
    if (trades.length) this.savePosition(wallet, mint, quote, state, trades[trades.length - 1]);
  }

  // CROSS JOIN fixes the join order (SQLite never reorders it): start from
  // the wallet's own links, never from every position of a popular mint.
  /** A wallet's first trade of `mint`: mark it and its linked wallets if any of them trade `mint`. */
  private markWashForNewPosition(wallet: string, mint: string) {
    const linked = this.q("SELECT 1 FROM funding_links f CROSS JOIN positions p ON p.wallet = f.b AND p.mint = ? WHERE f.a = ? LIMIT 1").get(mint, wallet);
    if (!linked) return;
    this.q("INSERT OR IGNORE INTO wash_positions (wallet, mint) VALUES (?, ?)").run(wallet, mint);
    this.q("INSERT OR IGNORE INTO wash_positions (wallet, mint) SELECT DISTINCT p.wallet, p.mint FROM funding_links f CROSS JOIN positions p ON p.wallet = f.b AND p.mint = ? WHERE f.a = ?").run(mint, wallet);
  }

  /** A funding transfer: link both wallets and mark the mints both trade. */
  private linkWallets(a: string, b: string) {
    if (a === b) return;
    const r = this.q("INSERT OR IGNORE INTO funding_links (a, b) VALUES (?, ?), (?, ?)").run(a, b, b, a);
    if (Number(r.changes) === 0) return;
    this.q(`INSERT OR IGNORE INTO wash_positions (wallet, mint)
      SELECT DISTINCT p.wallet, p.mint FROM positions pa CROSS JOIN positions pb ON pb.wallet = ? AND pb.mint = pa.mint
      CROSS JOIN positions p ON p.mint = pa.mint AND p.wallet IN (?, ?) WHERE pa.wallet = ?`).run(b, a, b, a);
  }

  /** Recomputes every aggregate from the raw tables (new or upgraded databases). */
  rebuildAggregates() {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM positions; DELETE FROM agg_hourly; DELETE FROM funding_links; DELETE FROM wash_positions; DELETE FROM token_stats;");
      db.exec(`INSERT INTO agg_hourly (wallet, mint, quote, hour, volume, trades, buys, sells)
        SELECT wallet, mint, quote, timestamp / ${AGG_BUCKET_SECONDS}, SUM(quote_amount), COUNT(*), SUM(side = 'buy'), SUM(side = 'sell')
        FROM trades GROUP BY wallet, mint, quote, timestamp / ${AGG_BUCKET_SECONDS}`);
      for (const r of this.db.prepare("SELECT DISTINCT wallet, mint, quote FROM trades").all()) this.rebuildPosition(r.wallet as string, r.mint as string, r.quote as string);
      for (const r of db.prepare("SELECT DISTINCT mint FROM trades").all()) this.rebuildTokenStats(r.mint as string);
      db.prepare(`INSERT OR IGNORE INTO funding_links (a, b) SELECT from_addr, to_addr FROM sol_transfers WHERE lamports >= ? AND from_addr <> to_addr
        UNION SELECT to_addr, from_addr FROM sol_transfers WHERE lamports >= ? AND from_addr <> to_addr`).run(WASH_MIN_FUNDING_LAMPORTS, WASH_MIN_FUNDING_LAMPORTS);
      db.exec(`INSERT OR IGNORE INTO wash_positions (wallet, mint)
        SELECT DISTINCT pa.wallet, pa.mint FROM funding_links f JOIN positions pa ON pa.wallet = f.a JOIN positions pb ON pb.wallet = f.b AND pb.mint = pa.mint`);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('agg_version', ?)").run(AGG_VERSION);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  feed(wallets: string[], limit: number, beforeTimestamp = Number.MAX_SAFE_INTEGER): Trade[] {
    if (wallets.length === 0) return [];
    return this.q(`SELECT ${TRADE_COLS} FROM trades WHERE wallet IN (SELECT value FROM json_each(?)) AND timestamp < ? ORDER BY timestamp DESC, slot DESC, signature LIMIT ?`)
      .all(JSON.stringify(wallets), beforeTimestamp, limit)
      .map(toTrade);
  }

  walletTrades(wallet: string): Trade[] {
    return this.q(`SELECT ${TRADE_COLS} FROM trades WHERE wallet = ? ORDER BY timestamp, slot, signature`).all(wallet).map(toTrade);
  }

  mintTrades(mint: string): Trade[] {
    return this.q(`SELECT ${TRADE_COLS} FROM trades WHERE mint = ? ORDER BY slot, timestamp, signature`).all(mint).map(toTrade);
  }

  launch(mint: string): Launch | undefined {
    const r = this.q("SELECT mint, creator, slot, timestamp, signature FROM launches WHERE mint = ?").get(mint) as Row | undefined;
    return r ? { mint: r.mint as string, creator: r.creator as string, slot: r.slot as number, timestamp: r.timestamp as number, signature: r.signature as string } : undefined;
  }

  /** One bound JSON array (json_each), not one variable per recipient: no SQLITE_MAX_VARIABLE_NUMBER limit. */
  transfersFrom(from: string, to: string[]): SolTransfer[] {
    if (to.length === 0) return [];
    return this.q("SELECT signature, from_addr, to_addr, lamports, slot, timestamp FROM sol_transfers WHERE from_addr = ? AND to_addr IN (SELECT value FROM json_each(?)) ORDER BY slot")
      .all(from, JSON.stringify(to))
      .map(toTransfer);
  }

  transfersToBuyers(from: string, mint: string): SolTransfer[] {
    return this.q(`SELECT signature, from_addr, to_addr, lamports, slot, timestamp FROM sol_transfers
      WHERE from_addr = ? AND to_addr IN (SELECT wallet FROM trades WHERE mint = ? AND side = 'buy') ORDER BY slot`)
      .all(from, mint)
      .map(toTransfer);
  }

  leaderboard(q: LeaderboardQuery): LeaderboardRow[] {
    return this.q(LEADERBOARD_SQL(METRIC_SQL[q.by]))
      .all(Math.floor(q.sinceTimestamp / AGG_BUCKET_SECONDS), q.minVolumeSol, q.minTrades, q.limit)
      .map((r) => ({
        wallet: r.wallet as string,
        value: r.value as number,
        realisedPnl: { SOL: r.pnl_sol as number, USDC: r.pnl_usdc as number },
        volume: { SOL: r.vol_sol as number, USDC: r.vol_usdc as number },
        trades: r.trades as number,
        buys: r.buys as number,
        sells: r.sells as number,
        winRate: (r.realised as number) > 0 ? (r.wins as number) / (r.realised as number) : null,
        tokensTraded: r.tokens as number,
        washExcluded: { positions: r.wash_positions as number, trades: r.wash_trades as number, volumeSol: r.wash_vol_sol as number, pnlSol: r.wash_pnl_sol as number },
      }));
  }

  washPositions(wallet: string): string[] {
    return this.q("SELECT mint FROM wash_positions WHERE wallet = ? ORDER BY mint").all(wallet).map((r) => r.mint as string);
  }

  close() {
    this.db.close();
  }
}
