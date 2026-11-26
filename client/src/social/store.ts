/** SQLite storage for the social backend (node:sqlite) and the SocialPort implementation. */
import { DatabaseSync } from "node:sqlite";
import type { RevocationPort } from "../session.js";
import type { CopyIntent, CopySettings, RiskFlag, SocialPort } from "./ports.js";

export const RISK_FLAGS: readonly RiskFlag[] = ["sniper", "bundle", "insider", "concentrated"];
const MAX_NOTIFICATIONS_PER_USER = 1_000;
const MAX_LIVE_NONCES_PER_WALLET = 5;
/** A nonce younger than this is never evicted to make room; new requests are refused instead. */
export const NONCE_MIN_AGE_MS = 60_000;

export interface Profile { wallet: string; displayName: string; bio: string; avatarUrl: string | null; public: boolean }
export type FollowResult = "ok" | "limit" | "self";
export interface StoredNotification { seq: number; intent: CopyIntent }

export class SocialStore implements SocialPort, RevocationPort {
  private db: DatabaseSync;
  private listeners = new Set<(follower: string, n: StoredNotification) => void>();

  constructor(path = ":memory:", private maxFollows = 500) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, issued_at INTEGER NOT NULL DEFAULT 0, ip_hash TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS users (wallet TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revocations (user TEXT PRIMARY KEY, before INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS profiles (wallet TEXT PRIMARY KEY, display_name TEXT NOT NULL, bio TEXT NOT NULL, avatar_url TEXT, public INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, follower TEXT NOT NULL, leader TEXT NOT NULL, UNIQUE (follower, leader));
      CREATE INDEX IF NOT EXISTS follows_leader ON follows (leader, id);
      CREATE TABLE IF NOT EXISTS copy_settings (follower TEXT NOT NULL, leader TEXT NOT NULL, json TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (follower, leader));
      CREATE INDEX IF NOT EXISTS copy_leader ON copy_settings (leader, enabled);
      CREATE TABLE IF NOT EXISTS notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, follower TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notif_follower ON notifications (follower, seq);
    `);
    const cols = (this.db.prepare("PRAGMA table_info(nonces)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("issued_at")) this.db.exec("ALTER TABLE nonces ADD COLUMN issued_at INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("ip_hash")) this.db.exec("ALTER TABLE nonces ADD COLUMN ip_hash TEXT NOT NULL DEFAULT ''");
  }

  close() { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- nonces ----
  /**
   * Stores a nonce bound to the requester's IP hash. Live nonces are capped per (wallet, IP hash),
   * so one client cannot push out another's; at the cap the oldest is evicted only if it is at
   * least NONCE_MIN_AGE_MS old, otherwise the request is refused (returns false).
   */
  issueNonce(wallet: string, nonce: string, message: string, expiresAt: number, now: number, ipHash = ""): boolean {
    return this.tx(() => {
      this.db.prepare("DELETE FROM nonces WHERE expires_at < ? OR used = 1").run(now);
      const live = this.db.prepare("SELECT nonce, issued_at FROM nonces WHERE wallet = ? AND ip_hash = ? ORDER BY issued_at ASC, rowid ASC").all(wallet, ipHash) as { nonce: string; issued_at: number }[];
      if (live.length >= MAX_LIVE_NONCES_PER_WALLET) {
        const excess = live.slice(0, live.length - MAX_LIVE_NONCES_PER_WALLET + 1);
        if (excess.some((n) => now - n.issued_at < NONCE_MIN_AGE_MS)) return false;
        for (const n of excess) this.db.prepare("DELETE FROM nonces WHERE nonce = ?").run(n.nonce);
      }
      this.db.prepare("INSERT INTO nonces (nonce, wallet, message, expires_at, issued_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)").run(nonce, wallet, message, expiresAt, now, ipHash);
      return true;
    });
  }

  /** Atomically burns the nonce; returns its issued record only the first time. */
  consumeNonce(nonce: string): { wallet: string; message: string; expiresAt: number; ipHash: string } | null {
    const r = this.db.prepare("UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0 RETURNING wallet, message, expires_at, ip_hash").get(nonce) as
      { wallet: string; message: string; expires_at: number; ip_hash: string } | undefined;
    return r ? { wallet: r.wallet, message: r.message, expiresAt: r.expires_at, ipHash: r.ip_hash } : null;
  }

  // ---- users, revocation ----
  /** Records a sign-in; returns the user's first sign-in time in unix seconds (set once). */
  recordSignIn(wallet: string, nowMs: number): number {
    this.db.prepare("INSERT OR IGNORE INTO users (wallet, first_seen) VALUES (?, ?)").run(wallet, Math.floor(nowMs / 1000));
    return (this.db.prepare("SELECT first_seen FROM users WHERE wallet = ?").get(wallet) as { first_seen: number }).first_seen;
  }

  /** True if the wallet signed in before or has a profile: the only wallets that "exist". */
  userExists(wallet: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE wallet = ? UNION SELECT 1 FROM profiles WHERE wallet = ?").get(wallet, wallet);
  }

  /** Revokes every token for `userId` issued at or before `beforeSec` (unix seconds). Only ever moves forward. */
  revoke(userId: string, beforeSec: number) {
    this.db.prepare("INSERT INTO revocations (user, before) VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET before = MAX(before, excluded.before)").run(userId, beforeSec);
  }

  isRevoked(userId: string, iat: number): boolean {
    const r = this.db.prepare("SELECT before FROM revocations WHERE user = ?").get(userId) as { before: number } | undefined;
    return !!r && iat <= r.before;
  }

  // ---- profiles ----
  getProfile(wallet: string): Profile {
    const r = this.db.prepare("SELECT * FROM profiles WHERE wallet = ?").get(wallet) as
      { display_name: string; bio: string; avatar_url: string | null; public: number } | undefined;
    return r
      ? { wallet, displayName: r.display_name, bio: r.bio, avatarUrl: r.avatar_url, public: !!r.public }
      : { wallet, displayName: "", bio: "", avatarUrl: null, public: true };
  }

  putProfile(p: Profile) {
    this.db.prepare(`INSERT INTO profiles (wallet, display_name, bio, avatar_url, public) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (wallet) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio, avatar_url = excluded.avatar_url, public = excluded.public`)
      .run(p.wallet, p.displayName, p.bio, p.avatarUrl, p.public ? 1 : 0);
  }

  // ---- follows ----
  follow(follower: string, leader: string): FollowResult {
    if (follower === leader) return "self";
    return this.tx(() => {
      const has = this.db.prepare("SELECT 1 FROM follows WHERE follower = ? AND leader = ?").get(follower, leader);
      if (has) return "ok";
      const n = (this.db.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower = ?").get(follower) as { n: number }).n;
      if (n >= this.maxFollows) return "limit";
      this.db.prepare("INSERT INTO follows (follower, leader) VALUES (?, ?)").run(follower, leader);
      return "ok";
    });
  }

  unfollow(follower: string, leader: string) {
    this.tx(() => {
      this.db.prepare("DELETE FROM follows WHERE follower = ? AND leader = ?").run(follower, leader);
      this.db.prepare("DELETE FROM copy_settings WHERE follower = ? AND leader = ?").run(follower, leader);
    });
  }

  isFollowing(follower: string, leader: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM follows WHERE follower = ? AND leader = ?").get(follower, leader);
  }

  /** Who `follower` follows. Others' views (`includePrivate` false) hide private profiles. */
  following(follower: string, includePrivate = true): string[] {
    const sql = includePrivate
      ? "SELECT leader FROM follows WHERE follower = ? ORDER BY id"
      : "SELECT f.leader FROM follows f LEFT JOIN profiles p ON p.wallet = f.leader WHERE f.follower = ? AND COALESCE(p.public, 1) = 1 ORDER BY f.id";
    return (this.db.prepare(sql).all(follower) as { leader: string }[]).map((r) => r.leader);
  }

  followers(leader: string, limit: number, after: number, includePrivate = false): { wallets: string[]; next: number | null } {
    const rows = this.db.prepare(`SELECT f.id, f.follower FROM follows f LEFT JOIN profiles p ON p.wallet = f.follower
      WHERE f.leader = ? AND f.id > ? AND (? = 1 OR COALESCE(p.public, 1) = 1) ORDER BY f.id LIMIT ?`).all(leader, after, includePrivate ? 1 : 0, limit) as { id: number; follower: string }[];
    return { wallets: rows.map((r) => r.follower), next: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  /** Counts as shown to `includePrivate` false viewers exclude private profiles on the other side. */
  counts(wallet: string, includePrivate = false): { followers: number; following: number } {
    const priv = includePrivate ? 1 : 0;
    const c = (sql: string) => (this.db.prepare(sql).get(wallet, priv) as { n: number }).n;
    return {
      followers: c("SELECT COUNT(*) AS n FROM follows f LEFT JOIN profiles p ON p.wallet = f.follower WHERE f.leader = ? AND (? = 1 OR COALESCE(p.public, 1) = 1)"),
      following: c("SELECT COUNT(*) AS n FROM follows f LEFT JOIN profiles p ON p.wallet = f.leader WHERE f.follower = ? AND (? = 1 OR COALESCE(p.public, 1) = 1)"),
    };
  }

  // ---- copy settings ----
  getCopySettings(follower: string, leader: string): CopySettings | null {
    const r = this.db.prepare("SELECT json FROM copy_settings WHERE follower = ? AND leader = ?").get(follower, leader) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as CopySettings) : null;
  }

  putCopySettings(s: CopySettings) {
    this.db.prepare(`INSERT INTO copy_settings (follower, leader, json, enabled) VALUES (?, ?, ?, ?)
      ON CONFLICT (follower, leader) DO UPDATE SET json = excluded.json, enabled = excluded.enabled`)
      .run(s.follower, s.leader, JSON.stringify(s), s.enabled ? 1 : 0);
  }

  async copySettingsForLeader(leader: string): Promise<CopySettings[]> {
    const rows = this.db.prepare(`SELECT c.json FROM copy_settings c JOIN follows f ON f.follower = c.follower AND f.leader = c.leader
      WHERE c.leader = ? AND c.enabled = 1 ORDER BY c.follower`).all(leader) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as CopySettings);
  }

  // ---- notifications ----
  onNotify(fn: (follower: string, n: StoredNotification) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async notify(follower: string, intent: CopyIntent): Promise<void> {
    if (intent.follower !== follower) throw new Error("intent.follower does not match the notified follower");
    const row = this.tx(() => {
      const r = this.db.prepare("INSERT OR IGNORE INTO notifications (id, follower, json) VALUES (?, ?, ?) RETURNING seq")
        .get(intent.id, follower, JSON.stringify(intent)) as { seq: number } | undefined;
      if (!r) {
        // Same id again: a status update. Keep the sequence, replace the body.
        this.db.prepare("UPDATE notifications SET json = ? WHERE id = ? AND follower = ?").run(JSON.stringify(intent), intent.id, follower);
        const s = this.db.prepare("SELECT seq FROM notifications WHERE id = ? AND follower = ?").get(intent.id, follower) as { seq: number } | undefined;
        return s ?? null;
      }
      this.db.prepare(`DELETE FROM notifications WHERE follower = ? AND seq <= (SELECT seq FROM notifications WHERE follower = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`)
        .run(follower, follower, MAX_NOTIFICATIONS_PER_USER);
      return r;
    });
    if (row) for (const l of this.listeners) { try { l(follower, { seq: row.seq, intent }); } catch { /* a listener must not fail notify */ } }
  }

  notifications(follower: string, limit: number, before: number | null): { items: StoredNotification[]; next: number | null } {
    const rows = this.db.prepare("SELECT seq, json FROM notifications WHERE follower = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
      .all(follower, before ?? Number.MAX_SAFE_INTEGER, limit) as { seq: number; json: string }[];
    return { items: rows.map((r) => ({ seq: r.seq, intent: JSON.parse(r.json) as CopyIntent })), next: rows.length === limit ? rows[rows.length - 1].seq : null };
  }

  notificationsAfter(follower: string, after: number, limit: number): StoredNotification[] {
    const rows = this.db.prepare("SELECT seq, json FROM notifications WHERE follower = ? AND seq > ? ORDER BY seq LIMIT ?").all(follower, after, limit) as { seq: number; json: string }[];
    return rows.map((r) => ({ seq: r.seq, intent: JSON.parse(r.json) as CopyIntent }));
  }
}
