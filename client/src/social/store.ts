/** SQLite storage for the social backend (node:sqlite) and the SocialPort implementation. */
import { DatabaseSync } from "node:sqlite";
import type { CopyIntent, CopySettings, RiskFlag, SocialPort } from "./ports.js";

export const RISK_FLAGS: readonly RiskFlag[] = ["sniper", "bundle", "insider", "concentrated"];
const MAX_NOTIFICATIONS_PER_USER = 1_000;
const MAX_LIVE_NONCES_PER_WALLET = 5;

export interface Profile { wallet: string; displayName: string; bio: string; avatarUrl: string | null; public: boolean }
export type FollowResult = "ok" | "limit" | "self";
export interface StoredNotification { seq: number; intent: CopyIntent }

export class SocialStore implements SocialPort {
  private db: DatabaseSync;
  private listeners = new Set<(follower: string, n: StoredNotification) => void>();

  constructor(path = ":memory:", private maxFollows = 500) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS profiles (wallet TEXT PRIMARY KEY, display_name TEXT NOT NULL, bio TEXT NOT NULL, avatar_url TEXT, public INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS follows (id INTEGER PRIMARY KEY AUTOINCREMENT, follower TEXT NOT NULL, leader TEXT NOT NULL, UNIQUE (follower, leader));
      CREATE INDEX IF NOT EXISTS follows_leader ON follows (leader, id);
      CREATE TABLE IF NOT EXISTS copy_settings (follower TEXT NOT NULL, leader TEXT NOT NULL, json TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (follower, leader));
      CREATE INDEX IF NOT EXISTS copy_leader ON copy_settings (leader, enabled);
      CREATE TABLE IF NOT EXISTS notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, follower TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notif_follower ON notifications (follower, seq);
    `);
  }

  close() { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---- nonces ----
  issueNonce(wallet: string, nonce: string, message: string, expiresAt: number, now: number) {
    this.tx(() => {
      this.db.prepare("DELETE FROM nonces WHERE expires_at < ? OR used = 1").run(now);
      this.db.prepare(`DELETE FROM nonces WHERE wallet = ? AND nonce NOT IN
        (SELECT nonce FROM nonces WHERE wallet = ? ORDER BY expires_at DESC LIMIT ?)`).run(wallet, wallet, MAX_LIVE_NONCES_PER_WALLET - 1);
      this.db.prepare("INSERT INTO nonces (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)").run(nonce, wallet, message, expiresAt);
    });
  }

  /** Atomically burns the nonce; returns its issued record only the first time. */
  consumeNonce(nonce: string): { wallet: string; message: string; expiresAt: number } | null {
    const r = this.db.prepare("UPDATE nonces SET used = 1 WHERE nonce = ? AND used = 0 RETURNING wallet, message, expires_at").get(nonce) as
      { wallet: string; message: string; expires_at: number } | undefined;
    return r ? { wallet: r.wallet, message: r.message, expiresAt: r.expires_at } : null;
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

  following(follower: string): string[] {
    return (this.db.prepare("SELECT leader FROM follows WHERE follower = ? ORDER BY id").all(follower) as { leader: string }[]).map((r) => r.leader);
  }

  followers(leader: string, limit: number, after: number): { wallets: string[]; next: number | null } {
    const rows = this.db.prepare("SELECT id, follower FROM follows WHERE leader = ? AND id > ? ORDER BY id LIMIT ?").all(leader, after, limit) as { id: number; follower: string }[];
    return { wallets: rows.map((r) => r.follower), next: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  counts(wallet: string): { followers: number; following: number } {
    const c = (sql: string) => (this.db.prepare(sql).get(wallet) as { n: number }).n;
    return {
      followers: c("SELECT COUNT(*) AS n FROM follows WHERE leader = ?"),
      following: c("SELECT COUNT(*) AS n FROM follows WHERE follower = ?"),
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
