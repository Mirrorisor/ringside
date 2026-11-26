/**
 * Copy engine: turns a leader's trade into one pending, one-tap intent per
 * follower, or a recorded skip with a reason. It never signs and never
 * trades; building the follower's transaction happens when they tap
 * (build.ts).
 *
 * Skip reasons (CopyIntent.skipReason): disabled, bad_settings, leader_trade_stale,
 * unsupported_quote, perps_gate_off, perps_disabled, no_perp_market, no_price,
 * token_age_unknown, token_too_young, flagged:<flag>, over_per_trade_cap,
 * over_daily_cap, sells_disabled, no_copy_position, sell_too_small,
 * leader_trade_too_small (buys only), perp_size_unknown (ratio mode, the leader's size change cannot be determined).
 * Build-time refusals (build.ts): price_moved, leader_exited.
 *
 * Caps and the token filters (flags, age) apply to entries (buys, opens).
 * Exits (sells, closes) are never blocked by them: a follower must be able to
 * leave a position. Sells are limited to the follower's copy position.
 */
import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL, type Trade } from "../indexer/types.js";
import { cappedLeverage, perpsGateFromEnv } from "./perps.js";
import type { CopyIntent, CopySettings, FlagsPort, PerpEvent, PerpTierPort, RiskFlag, SocialPort } from "./ports.js";
import { CopyStore, publicIntent, type StoredIntent } from "./store.js";

export const MAX_LEADER_AGE_SEC = 30;
export const DEFAULT_INTENT_TTL_MS = 60_000;
export const DAILY_WINDOW_MS = 24 * 3600 * 1000;
export const DEFAULT_MIN_LEADER_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
export const DEFAULT_MIN_LEADER_RATIO = 0.5;
const envNum = (k: string, d: number): number => { const v = Number(process.env[k]); return process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(v) && v >= 0 ? v : d; };
const RISK_FLAGS: RiskFlag[] = ["sniper", "bundle", "insider", "concentrated"];

export interface EngineOptions {
  social: SocialPort;
  flags: FlagsPort;
  store: CopyStore;
  tiers?: PerpTierPort;
  /** Milliseconds. */
  now?: () => number;
  ttlMs?: number;
  /** Defaults to RINGSIDE_COPY_PERPS=1. */
  perpsEnabled?: boolean;
  /** SOL price in USD, needed to size perp copies in ratio mode. */
  solPriceUsd?: () => Promise<number | undefined>;
  log?: (msg: string) => void;
  /** A buy is copied only if the leader's trade is at least this many lamports. Defaults to COPY_MIN_LEADER_LAMPORTS (0.05 SOL). */
  minLeaderLamports?: number;
  /** ... and at least this fraction of the follower's copy size (fixed mode). Defaults to COPY_MIN_LEADER_RATIO (0.5). */
  minLeaderRatio?: number;
}

const isNat = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function validSettings(s: CopySettings): boolean {
  return !!s && typeof s.follower === "string" && !!s.follower && s.follower !== s.leader
    && (s.mode === "fixed" || s.mode === "ratio")
    && isNat(s.fixedLamports) && isNat(s.ratioBps) && s.ratioBps <= 100_000 && isNat(s.maxPerTradeLamports) && isNat(s.dailyCapLamports)
    && isNat(s.slippageBps) && s.slippageBps <= 10_000 && typeof s.maxLeverage === "number" && s.maxLeverage >= 0
    && Array.isArray(s.skipFlags) && isNat(s.minTokenAgeSec);
}

export class CopyEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private now: () => number;
  private ttl: number;
  private perpsOn: boolean;
  private minLeaderLamports: number;
  private minLeaderRatio: number;
  constructor(private o: EngineOptions) {
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? DEFAULT_INTENT_TTL_MS;
    this.perpsOn = o.perpsEnabled ?? perpsGateFromEnv();
    this.minLeaderLamports = o.minLeaderLamports ?? envNum("COPY_MIN_LEADER_LAMPORTS", DEFAULT_MIN_LEADER_LAMPORTS);
    this.minLeaderRatio = o.minLeaderRatio ?? envNum("COPY_MIN_LEADER_RATIO", DEFAULT_MIN_LEADER_RATIO);
  }

  /** Runs one leader event at a time, so two events cannot both pass one follower's daily cap. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const r = this.chain.then(f, f);
    this.chain = r.catch(() => undefined);
    return r;
  }

  onLeaderTrade(trade: Trade): Promise<CopyIntent[]> {
    if (trade.side === "sell") this.o.store.recordLeaderSell(trade.wallet, trade.mint, trade.slot, trade.signature);
    return this.serial(() => this.handle(trade.wallet, trade.signature, trade.timestamp, (s) => this.spot(s, trade)));
  }

  onLeaderPerp(ev: PerpEvent): Promise<CopyIntent[]> {
    return this.serial(() => {
      // Track the leader's size once per event, whoever follows: ratio sizing needs the change, not the total.
      let prev: number | null = null;
      if (ev.action === "close") this.o.store.leaderPerpClosed(ev.leader, ev.mint, ev.side, ev.signature);
      else prev = this.o.store.leaderPerpStep(ev.leader, ev.mint, ev.side, ev.sizeUsd, ev.signature, ev.prevSizeUsd);
      return this.handle(ev.leader, ev.signature, ev.timestamp, (s) => this.perp(s, ev, prev));
    });
  }

  private async handle(leader: string, signature: string, tsSec: number, decide: (s: CopySettings) => Promise<Decision>): Promise<CopyIntent[]> {
    const all = await this.o.social.copySettingsForLeader(leader);
    const out: CopyIntent[] = [];
    for (const s of all) {
      if (!s || s.leader !== leader) continue; // never trust settings for another leader
      let d: Decision;
      const existing = typeof s.follower === "string" ? this.existing(s.follower, signature) : undefined;
      if (existing) { out.push(publicIntent(existing)); continue; }
      try {
        if (!validSettings(s)) d = { skip: "bad_settings" };
        else if (!s.enabled) d = { skip: "disabled" };
        else if (Math.floor(this.now() / 1000) - tsSec > MAX_LEADER_AGE_SEC) d = { skip: "leader_trade_stale" };
        else d = await decide(s);
      } catch (e) {
        this.o.log?.(`[copy] decide failed for ${s.follower}: ${(e as Error).message}`);
        d = { skip: "internal_error" };
      }
      const t = this.now();
      const base = {
        id: randomUUID(), follower: s.follower, leader, sourceSignature: signature, createdAt: t, expiresAt: t + this.ttl,
        slippageBps: isNat(s.slippageBps) ? s.slippageBps : 100,
      };
      const row: StoredIntent = "skip" in d
        ? { ...base, kind: d.kind ?? "spot", mint: d.mint ?? "", side: d.side ?? "buy", venue: d.venue ?? "jupiter", status: "skipped", skipReason: d.skip, perpSide: d.perpSide }
        : { ...base, ...d.intent, status: "pending" };
      const { intent, created } = this.o.store.insert(row);
      out.push(publicIntent(intent));
      if (created && intent.status === "pending") {
        try { await this.o.social.notify(intent.follower, publicIntent(intent)); }
        catch (e) { this.o.log?.(`[copy] notify failed: ${(e as Error).message}`); }
      }
    }
    return out;
  }

  private existing(follower: string, signature: string): StoredIntent | undefined {
    return this.o.store.findBySource(follower, signature);
  }

  /** Token filters for entries. Returns a skip reason or null. */
  private async tokenSkip(s: CopySettings, mint: string): Promise<string | null> {
    const wantFlags = s.skipFlags.filter((f) => RISK_FLAGS.includes(f));
    if (wantFlags.length === 0 && s.minTokenAgeSec === 0) return null;
    const facts = await this.o.flags.tokenFacts(mint, Math.floor(this.now() / 1000));
    const hit = wantFlags.find((f) => facts.flags.includes(f));
    if (hit) return `flagged:${hit}`;
    if (s.minTokenAgeSec > 0) {
      if (facts.ageSec === null) return "token_age_unknown";
      if (facts.ageSec < s.minTokenAgeSec) return "token_too_young";
    }
    return null;
  }

  /** Per-trade and rolling-24h caps for a buy of `lamports`. */
  private capSkip(s: CopySettings, lamports: number): string | null {
    if (lamports > s.maxPerTradeLamports) return "over_per_trade_cap";
    const spent = this.o.store.committedSince(s.follower, this.now() - DAILY_WINDOW_MS, this.now());
    if (spent + lamports > s.dailyCapLamports) return "over_daily_cap";
    return null;
  }

  private sizeLamports(s: CopySettings, leaderLamports: number): number {
    return s.mode === "fixed" ? s.fixedLamports : Math.floor((leaderLamports * s.ratioBps) / 10_000);
  }

  private async spot(s: CopySettings, t: Trade): Promise<Decision> {
    const meta = { kind: "spot" as const, mint: t.mint, side: t.side, venue: venueOf(t.source) };
    const skip = (reason: string): Decision => ({ skip: reason, ...meta });
    if (t.quote !== "SOL") return skip("unsupported_quote");
    const leaderLamports = Math.round(t.quoteAmount * LAMPORTS_PER_SOL);
    if (!Number.isFinite(leaderLamports) || leaderLamports <= 0) return skip("unsupported_quote");
    const lamports = this.sizeLamports(s, leaderLamports);
    if (lamports <= 0) return skip("over_per_trade_cap");

    if (t.side === "sell") {
      if (!s.copySells) return skip("sells_disabled");
      const pos = this.o.store.position(s.follower, t.mint);
      const avail = pos.tokens - this.o.store.reservedSellTokens(s.follower, t.mint);
      if (avail <= 0n) return skip("no_copy_position");
      // Size in SOL terms like a buy, converted to tokens at the follower's cost basis, never above what copies bought.
      let tokens = pos.costLamports > 0n ? (pos.tokens * BigInt(lamports)) / pos.costLamports : avail;
      if (tokens > avail) tokens = avail;
      if (tokens <= 0n) return skip("sell_too_small");
      return { intent: { ...meta, lamports, tokens: tokens.toString() } };
    }

    // A dust buy must not trigger a full-size copy: the leader could pre-buy, signal with dust and sell into followers.
    // In ratio mode the copy is already proportional to the leader, so only the absolute floor applies.
    const floor = Math.max(this.minLeaderLamports, s.mode === "fixed" ? lamports * this.minLeaderRatio : 0);
    if (leaderLamports < floor) return skip("leader_trade_too_small");
    const why = (await this.tokenSkip(s, t.mint)) ?? this.capSkip(s, lamports);
    const leaderPrice = t.quoteAmount / t.tokenAmount;
    return why ? skip(why) : { intent: { ...meta, lamports, leaderPrice: Number.isFinite(leaderPrice) && leaderPrice > 0 ? leaderPrice : undefined, sourceSlot: t.slot } };
  }

  private async perp(s: CopySettings, e: PerpEvent, prevSizeUsd: number | null): Promise<Decision> {
    const meta = { kind: "perp" as const, mint: e.mint, side: e.action === "close" ? ("close" as const) : e.side, venue: "ringside-perps" as const, ...(e.action === "close" ? { perpSide: e.side } : {}) };
    const skip = (reason: string): Decision => ({ skip: reason, ...meta });
    if (!this.perpsOn) return skip("perps_gate_off");
    if (!s.copyPerps) return skip("perps_disabled");
    if (e.action === "close") {
      // Only the side the leader closed, and only a position that came from copying this leader.
      return this.o.store.copiedPerp(s.follower, s.leader, e.mint, e.side) ? { intent: { ...meta } } : skip("no_copy_position");
    }
    const tier = (await this.o.tiers?.tierOf(e.mint)) ?? null;
    if (this.o.tiers && tier === null) return skip("no_perp_market");
    const leverage = cappedLeverage(e.leverage, s.maxLeverage, tier);
    if (!(leverage >= 1)) return skip("leverage_below_minimum");
    let lamports: number;
    if (s.mode === "fixed") lamports = s.fixedLamports;
    else {
      const px = await this.o.solPriceUsd?.();
      if (!px || !(px > 0)) return skip("no_price");
      // The event carries the position's total after the fill; copy only what the leader added.
      if (prevSizeUsd === null) return skip("perp_size_unknown");
      const added = e.sizeUsd - prevSizeUsd;
      if (!(added > 0)) return skip("perp_size_unknown");
      lamports = Math.floor(((added / px) * LAMPORTS_PER_SOL * s.ratioBps) / 10_000);
    }
    if (lamports <= 0) return skip("over_per_trade_cap");
    const why = (await this.tokenSkip(s, e.mint)) ?? this.capSkip(s, lamports);
    return why ? skip(why) : { intent: { ...meta, lamports, leverage } };
  }
}

type IntentCore = Pick<CopyIntent, "kind" | "mint" | "side" | "venue"> & Partial<Pick<CopyIntent, "lamports" | "tokens" | "leverage" | "leaderPrice">> & { sourceSlot?: number; perpSide?: "long" | "short" };
type Decision = ({ skip: string } & Partial<IntentCore>) | { intent: IntentCore };

/** Venue hint from the leader's trade source; the builder decides for real at build time. */
export function venueOf(source: string): "jupiter" | "pumpfun" {
  return /pump/i.test(source) ? "pumpfun" : "jupiter";
}

export const createCopyEngine = (o: EngineOptions) => new CopyEngine(o);
