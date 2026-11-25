/**
 * Indexer storage: an interface and a `node:sqlite` implementation.
 * Ingest is idempotent on transaction signature: a signature already seen
 * is skipped as a whole.
 */
import { DatabaseSync } from "node:sqlite";
import type { Launch, ParsedTx, SolTransfer, Trade } from "./types.js";

export interface Store {
  /** Stores one parsed transaction; false if its signature was already ingested. */
  ingest(tx: ParsedTx): boolean;
  /** Most recent trades of any of `wallets`, newest first. */
  feed(wallets: string[], limit: number, beforeTimestamp?: number): Trade[];
  /** All trades of one wallet, oldest first. */
  walletTrades(wallet: string): Trade[];
  /** All trades of one mint, oldest first. */
  mintTrades(mint: string): Trade[];
  launch(mint: string): Launch | undefined;
  /** SOL transfers from `from` to any of `to`. */
  transfersFrom(from: string, to: string[]): SolTransfer[];
  /** Wallets with a trade at or after `sinceTimestamp`. */
  activeWallets(sinceTimestamp: number, limit: number): string[];
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
CREATE INDEX IF NOT EXISTS trades_mint_slot ON trades (mint, slot);
CREATE INDEX IF NOT EXISTS trades_time ON trades (timestamp);
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
`;

type Row = Record<string, unknown>;
const toTrade = (r: Row): Trade => ({
  signature: r.signature as string, wallet: r.wallet as string, mint: r.mint as string, side: r.side as Trade["side"],
  tokenAmount: r.token_amount as number, quote: r.quote as Trade["quote"], quoteAmount: r.quote_amount as number,
  slot: r.slot as number, timestamp: r.timestamp as number, source: r.source as string,
});
const TRADE_COLS = "signature, wallet, mint, side, token_amount, quote, quote_amount, slot, timestamp, source";

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  ingest(tx: ParsedTx): boolean {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = db.prepare("INSERT OR IGNORE INTO transactions (signature, slot, timestamp, ingested_at) VALUES (?, ?, ?, ?)").run(tx.signature, tx.slot, tx.timestamp, Date.now());
      if (Number(r.changes) === 0) {
        db.exec("ROLLBACK");
        return false;
      }
      const ins = db.prepare(`INSERT OR IGNORE INTO trades (${TRADE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const t of tx.trades) ins.run(t.signature, t.wallet, t.mint, t.side, t.tokenAmount, t.quote, t.quoteAmount, t.slot, t.timestamp, t.source);
      const tr = db.prepare("INSERT OR IGNORE INTO sol_transfers (signature, idx, from_addr, to_addr, lamports, slot, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)");
      tx.transfers.forEach((t, i) => tr.run(t.signature, i, t.from, t.to, t.lamports, t.slot, t.timestamp));
      const la = db.prepare("INSERT OR IGNORE INTO launches (mint, creator, slot, timestamp, signature) VALUES (?, ?, ?, ?, ?)");
      for (const l of tx.launches) la.run(l.mint, l.creator, l.slot, l.timestamp, l.signature);
      db.exec("COMMIT");
      return true;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  feed(wallets: string[], limit: number, beforeTimestamp = Number.MAX_SAFE_INTEGER): Trade[] {
    if (wallets.length === 0) return [];
    const marks = wallets.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT ${TRADE_COLS} FROM trades WHERE wallet IN (${marks}) AND timestamp < ? ORDER BY timestamp DESC, slot DESC, signature LIMIT ?`)
      .all(...wallets, beforeTimestamp, limit)
      .map(toTrade);
  }

  walletTrades(wallet: string): Trade[] {
    return this.db.prepare(`SELECT ${TRADE_COLS} FROM trades WHERE wallet = ? ORDER BY timestamp, slot, signature`).all(wallet).map(toTrade);
  }

  mintTrades(mint: string): Trade[] {
    return this.db.prepare(`SELECT ${TRADE_COLS} FROM trades WHERE mint = ? ORDER BY slot, timestamp, signature`).all(mint).map(toTrade);
  }

  launch(mint: string): Launch | undefined {
    const r = this.db.prepare("SELECT mint, creator, slot, timestamp, signature FROM launches WHERE mint = ?").get(mint) as Row | undefined;
    return r ? { mint: r.mint as string, creator: r.creator as string, slot: r.slot as number, timestamp: r.timestamp as number, signature: r.signature as string } : undefined;
  }

  transfersFrom(from: string, to: string[]): SolTransfer[] {
    if (to.length === 0) return [];
    const marks = to.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT signature, from_addr, to_addr, lamports, slot, timestamp FROM sol_transfers WHERE from_addr = ? AND to_addr IN (${marks}) ORDER BY slot`)
      .all(from, ...to)
      .map((r) => ({ signature: r.signature as string, from: r.from_addr as string, to: r.to_addr as string, lamports: r.lamports as number, slot: r.slot as number, timestamp: r.timestamp as number }));
  }

  activeWallets(sinceTimestamp: number, limit: number): string[] {
    return this.db.prepare("SELECT DISTINCT wallet FROM trades WHERE timestamp >= ? LIMIT ?").all(sinceTimestamp, limit).map((r) => r.wallet as string);
  }

  close() {
    this.db.close();
  }
}
