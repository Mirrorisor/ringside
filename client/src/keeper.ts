/**
 * Ringside keeper.
 *
 * Permissionless bot that keeps perp markets moving:
 *   - fills order requests once the 2-slot delay has passed (earns half the
 *     protocol fee share),
 *   - liquidates under-margined positions (earns 1% of notional, max $500),
 *   - cranks funding and the price band on every market about once a minute,
 *   - when a market's risk budget is spent, auto-deleverages its most
 *     profitable positions first,
 *   - keeps SOL/USD fresh from Pyth (posting its own verified update when the
 *     sponsored feed is stale),
 *   - graduates sold-out curves: migrate to a Raydium pool, then move the perp
 *     market to the pool's price.
 *
 * Liquidation and ADL eligibility is decided by the program, so the keeper
 * simulates each candidate and sends only what would succeed.
 *
 * Usage: RPC_URL=... KEEPER_KEY=<base58 64-byte secret> USDC_MINT=... node keeper.js
 * TEST_SOL_PRICE_USD=150 pushes a fixed price instead of Pyth (needs the price authority key).
 */
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  AccountRole,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PythPoster } from "./pyth.js";
import { Monitor, FILL_LAG_SLOTS, LOW_SOL_LAMPORTS, STALE_PRICE_S, type Condition } from "./monitor.js";
import { LAUNCH_PROGRAM, decodeCurve, decodeFeeRecipient, graduateMarketIx, migrateIx, priceAccounts, retireMarketIx } from "./graduation.js";

export const PERPS_PROGRAM = address(process.env.PERPS_PROGRAM_ID ?? "DsZ69w3q25nRmAzJCRBMLbwZWN6NyVbYipTWsCAUsg1F");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const FILL_DELAY_SLOTS = 2n;
const CRANK_EVERY_MS = 60_000;
const LIQ_SCAN_EVERY_MS = 15_000;
const PYTH_EVERY_MS = 30_000;
const GRADUATION_SCAN_EVERY_MS = 20_000;
const RETIRE_SCAN_EVERY_MS = 3_600_000;
const MONITOR_EVERY_MS = 30_000;
const COMPOUND_EVERY_MS = 3_600_000;
/** Compound protocol fees once at least this much (USDC, 6 dp) has accrued. */
const COMPOUND_MIN = BigInt(process.env.COMPOUND_MIN_USDC_E6 ?? "1000000");
/** After a fill fails for a reason other than timing, leave that order alone this long. */
const FAILED_ORDER_BACKOFF_MS = 60_000;

// ---------------------------------------------------------------------------
// Anchor encoding
// ---------------------------------------------------------------------------

const disc = (ns: "global" | "account", name: string) =>
  new Uint8Array(createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8));

const IX = {
  executeOrder: disc("global", "execute_order"),
  liquidate: disc("global", "liquidate"),
  autoDeleverage: disc("global", "auto_deleverage"),
  crankFunding: disc("global", "crank_funding"),
  setSolPrice: disc("global", "set_sol_price"),
  compoundProtocolFees: disc("global", "compound_protocol_fees"),
};
const ACC = {
  order: disc("account", "OrderRequest"),
  position: disc("account", "Position"),
  market: disc("account", "Market"),
};

class Reader {
  private o = 8; // skip discriminator
  constructor(private d: Uint8Array) {}
  private view = () => new DataView(this.d.buffer, this.d.byteOffset, this.d.byteLength);
  pubkey(): Address {
    const a = getAddressDecoder().decode(this.d.subarray(this.o, this.o + 32));
    this.o += 32;
    return a;
  }
  u8() { return this.d[this.o++]; }
  bool() { return this.u8() !== 0; }
  u64() { const v = this.view().getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { const v = this.view().getBigInt64(this.o, true); this.o += 8; return v; }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  i128() { const lo = this.u64(); const hi = this.i64(); return (hi << 64n) + lo; }
}

export interface OrderRequest { key: Address; owner: Address; market: Address; side: number; kind: number; requestSlot: bigint; rentPayer: Address }
export interface Position { key: Address; owner: Address; market: Address; side: number; collateral: bigint; sizeUsd: bigint; entryQ64: bigint }
export interface Market { key: Address; mint: Address; curve: Address; tier: number; reduceOnly: boolean; adlMode: boolean; bandAnchorQ64: bigint }

export function decodeOrder(key: Address, d: Uint8Array): OrderRequest {
  const r = new Reader(d);
  const owner = r.pubkey(), market = r.pubkey(), side = r.u8(), kind = r.u8();
  r.u64(); r.u64(); r.u128();
  const requestSlot = r.u64();
  r.u8(); // bump
  return { key, owner, market, side, kind, requestSlot, rentPayer: r.pubkey() };
}

export function decodePosition(key: Address, d: Uint8Array): Position {
  const r = new Reader(d);
  const owner = r.pubkey(), market = r.pubkey(), side = r.u8(), collateral = r.u64(), sizeUsd = r.u64();
  return { key, owner, market, side, collateral, sizeUsd, entryQ64: r.u128() };
}

export function decodeMarket(key: Address, d: Uint8Array): Market {
  const r = new Reader(d);
  const mint = r.pubkey(), curve = r.pubkey();
  r.pubkey(); // creator
  const tier = r.u8();
  r.u64(); r.u64(); r.u64(); r.u64(); // created_slot, oi_long, oi_short, oi_cap_override
  r.i128(); r.i64(); // funding_index, last_funding_ts
  const bandAnchorQ64 = r.u128();
  r.u64(); r.i128(); r.u64(); r.u64(); // band_anchor_slot, trader_net_pnl, insurance, creator_fees
  return { key, mint, curve, tier, reduceOnly: r.bool(), adlMode: r.bool(), bandAnchorQ64 };
}

// ---------------------------------------------------------------------------
// Keeper
// ---------------------------------------------------------------------------

type Rpc = ReturnType<typeof createSolanaRpc>;

export class Keeper {
  private vault!: Address;
  private vaultUsdc!: Address;
  private keeperUsdc!: Address;
  private markets = new Map<string, Market>();
  private inflight = new Set<string>();
  private backoffUntil = new Map<string, number>();
  private lastCrank = 0;
  private lastLiqScan = 0;
  private lastPrice = 0;
  private lastGradScan = 0;
  private lastRetireScan = 0;
  private lastMonitor = 0;
  private lastCompound = 0;
  private warnedNoTreasury = false;
  monitor = new Monitor(process.env.ALERT_WEBHOOK_URL);
  /** Markets deliberately limited by the admin (e.g. the protocol's own token): no reduce-only alerts. */
  private quietMarkets = new Set((process.env.MONITOR_IGNORE_MARKETS ?? "").split(",").filter(Boolean));
  private relayerAddress = process.env.RELAYER_ADDRESS ? address(process.env.RELAYER_ADDRESS) : null;
  private retired = new Set<string>();
  private lastPythSource = "";
  /** Pyth poster; null when a fixed test price is used. */
  pyth: PythPoster | null = null;
  /** Devnet only: a fixed SOL/USD (6 dp) the keeper pushes every minute as the price authority. */
  testSolPriceE6: bigint | null = null;
  private send: ReturnType<typeof sendAndConfirmTransactionFactory>;

  constructor(private rpc: Rpc, rpcWs: ReturnType<typeof createSolanaRpcSubscriptions>, private signer: KeyPairSigner, private usdcMint: Address) {
    this.send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: rpcWs } as Parameters<typeof sendAndConfirmTransactionFactory>[0]);
  }

  async init() {
    const enc = new TextEncoder();
    [this.vault] = await getProgramDerivedAddress({ programAddress: PERPS_PROGRAM, seeds: [enc.encode("vault")] });
    [this.vaultUsdc] = await getProgramDerivedAddress({ programAddress: PERPS_PROGRAM, seeds: [enc.encode("vault_usdc")] });
    this.keeperUsdc = await ata(this.signer.address, this.usdcMint);
  }

  private async accounts(discriminator: Uint8Array) {
    const res = await this.rpc
      .getProgramAccounts(PERPS_PROGRAM, {
        encoding: "base64",
        filters: [{ memcmp: { offset: 0n, bytes: base58(discriminator), encoding: "base58" } }],
      })
      .send();
    return (res as unknown as { pubkey: Address; account: { data: [string, string] } }[]).map((a) => ({
      key: a.pubkey,
      data: new Uint8Array(Buffer.from(a.account.data[0], "base64")),
    }));
  }

  private async refreshMarkets() {
    for (const a of await this.accounts(ACC.market)) this.markets.set(a.key, decodeMarket(a.key, a.data));
  }

  /** One pass of the main loop. */
  async tick() {
    if (this.pyth && Date.now() - this.lastPrice > PYTH_EVERY_MS) {
      this.lastPrice = Date.now();
      await this.guard("pyth", async () => {
        const src = await this.pyth!.refresh();
        if (src !== this.lastPythSource) console.log(`[keeper] SOL/USD source: ${src === "posted" ? "own verified Pyth update (Hermes)" : src === "sponsored" ? "Pyth sponsored feed" : "devnet fallback: last sponsored Pyth price, pushed by the price authority"}`);
        this.lastPythSource = src;
      });
    } else if (this.testSolPriceE6 !== null && Date.now() - this.lastPrice > 60_000) {
      this.lastPrice = Date.now();
      const data = new Uint8Array(16);
      data.set(IX.setSolPrice, 0);
      new DataView(data.buffer).setBigUint64(8, this.testSolPriceE6, true);
      await this.guard("price", () =>
        this.sendIx({ programAddress: PERPS_PROGRAM, accounts: [signer(this.signer.address), w(this.vault)], data }),
      );
    }
    const slot = await this.rpc.getSlot({ commitment: "confirmed" }).send();
    if (this.markets.size === 0 || Date.now() - this.lastCrank > CRANK_EVERY_MS) await this.refreshMarkets();

    // 1. Fill orders whose delay has passed.
    const orders = (await this.accounts(ACC.order)).map((a) => decodeOrder(a.key, a.data));
    if (Date.now() - this.lastMonitor > MONITOR_EVERY_MS) {
      this.lastMonitor = Date.now();
      await this.checkHealth(slot, orders).catch((e) => console.warn(`[keeper] monitor: ${(e as Error).message}`));
    }
    if (process.env.COMPOUND_PROTOCOL_FEES !== "0" && Date.now() - this.lastCompound > COMPOUND_EVERY_MS) {
      this.lastCompound = Date.now();
      await this.guard("compound", () => this.compoundFees());
    }
    await Promise.all(
      orders
        .filter((o) => slot >= o.requestSlot + FILL_DELAY_SLOTS && !this.inflight.has(o.key) && (this.backoffUntil.get(o.key) ?? 0) < Date.now())
        .map((o) => this.guard(o.key, () => this.executeOrder(o))),
    );

    // 2. Liquidations and ADL.
    if (Date.now() - this.lastLiqScan > LIQ_SCAN_EVERY_MS) {
      this.lastLiqScan = Date.now();
      const positions = (await this.accounts(ACC.position))
        .map((a) => decodePosition(a.key, a.data))
        .filter((p) => p.sizeUsd > 0n);
      for (const p of positions) {
        const m = this.markets.get(p.market);
        if (!m) continue;
        const ix = await this.positionIx(IX.liquidate, p, m);
        if (await this.wouldSucceed(ix)) await this.guard(p.key, () => this.sendIx(ix));
      }
      // ADL: most profitable first, by an estimate at the band anchor. The
      // program re-checks profitability at the real mark.
      for (const m of [...this.markets.values()].filter((x) => x.adlMode)) {
        const ranked = positions
          .filter((p) => p.market === m.key)
          .map((p) => ({ p, pnl: estPnl(p, m.bandAnchorQ64) }))
          .filter((x) => x.pnl > 0n)
          .sort((a, b) => (b.pnl > a.pnl ? 1 : -1));
        for (const { p } of ranked) {
          const ix = await this.positionIx(IX.autoDeleverage, p, m);
          if (!(await this.wouldSucceed(ix))) break; // budget restored or nothing left in profit
          await this.guard(p.key, () => this.sendIx(ix));
        }
      }
    }

    // 3. Graduation: sold-out curves migrate to Raydium, then their markets move to the pool price.
    if (Date.now() - this.lastGradScan > GRADUATION_SCAN_EVERY_MS) {
      this.lastGradScan = Date.now();
      await this.graduate();
    }

    // 4. Retire dead launches so their Tier 0 slots free up (hourly; the program decides).
    if (Date.now() - this.lastRetireScan > RETIRE_SCAN_EVERY_MS) {
      this.lastRetireScan = Date.now();
      for (const m of [...this.markets.values()].filter((x) => x.tier === 0 && !x.reduceOnly && !this.retired.has(x.key))) {
        const ix = await retireMarketIx(this.signer.address, m.key, m.curve);
        if (await this.wouldSucceed(ix)) {
          await this.guard(`retire:${m.key}`, async () => {
            await this.sendIx(ix);
            this.retired.add(m.key);
            console.log(`[keeper] retired idle market ${m.key}`);
          });
        }
      }
    }

    // 5. Funding and band crank.
    if (Date.now() - this.lastCrank > CRANK_EVERY_MS) {
      this.lastCrank = Date.now();
      for (const m of this.markets.values()) {
        await this.guard(`crank:${m.key}`, async () =>
          this.sendIx({
            programAddress: PERPS_PROGRAM,
            accounts: [ro(this.vault), w(m.key), ro(m.curve), ...(await this.poolTail(m))],
            data: IX.crankFunding,
          }),
        );
      }
    }
  }

  private async executeOrder(o: OrderRequest) {
    const m = this.markets.get(o.market) ?? (await this.refreshMarkets(), this.markets.get(o.market));
    if (!m) return;
    const [position] = await getProgramDerivedAddress({
      programAddress: PERPS_PROGRAM,
      seeds: [new TextEncoder().encode("position"), addr(o.owner), addr(o.market), new Uint8Array([o.side])],
    });
    await this.sendIx({
      programAddress: PERPS_PROGRAM,
      accounts: [
        signer(this.signer.address), w(this.vault), w(this.vaultUsdc), w(m.key), ro(m.curve),
        w(o.rentPayer), w(o.key), w(position), w(await ata(o.owner, this.usdcMint)), w(this.keeperUsdc), ro(TOKEN_PROGRAM),
        ...(await this.poolTail(m)),
      ],
      data: IX.executeOrder,
    });
  }

  private async positionIx(data: Uint8Array, p: Position, m: Market): Promise<Instruction> {
    return {
      programAddress: PERPS_PROGRAM,
      accounts: [
        signer(this.signer.address), w(this.vault), w(this.vaultUsdc), w(m.key), ro(m.curve),
        w(p.key), w(await ata(p.owner, this.usdcMint)), w(this.keeperUsdc), ro(TOKEN_PROGRAM),
        ...(await this.poolTail(m)),
      ],
      data,
    };
  }

  /** Vault fields the keeper watches: authority, protocol fees, SOL price and its time. */
  private async readVault() {
    const acc = await this.rpc.getAccountInfo(this.vault, { encoding: "base64" }).send();
    const d = new Uint8Array(Buffer.from(acc.value!.data[0], "base64"));
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    // disc 8 | authority 32 | price_authority 32 | usdc_mint 32 | total_shares | trader_collateral | reserved | protocol_fees | sol_usd_e6 | sol_usd_ts
    return {
      authority: getAddressDecoder().decode(d.subarray(8, 40)),
      protocolFees: v.getBigUint64(128, true),
      solUsdTs: Number(v.getBigInt64(144, true)),
    };
  }

  /** Permissionless: protocol fees become treasury-owned vault liquidity. */
  private async compoundFees() {
    const v = await this.readVault();
    if (v.protocolFees < COMPOUND_MIN) return;
    // The treasury is named by the admin (set_treasury); until then there's nothing to compound into.
    const [config] = await getProgramDerivedAddress({ programAddress: PERPS_PROGRAM, seeds: [new TextEncoder().encode("treasury")] });
    const cfg = await this.rpc.getAccountInfo(config, { encoding: "base64" }).send();
    if (!cfg.value) {
      if (!this.warnedNoTreasury) console.warn("[keeper] no treasury set (treasury.ts set-treasury): protocol fees wait in the vault");
      this.warnedNoTreasury = true;
      return;
    }
    const treasury = getAddressDecoder().decode(new Uint8Array(Buffer.from(cfg.value.data[0], "base64")).subarray(8, 40));
    const [treasuryLp] = await getProgramDerivedAddress({ programAddress: PERPS_PROGRAM, seeds: [new TextEncoder().encode("lp"), addr(treasury)] });
    await this.sendIx({
      programAddress: PERPS_PROGRAM,
      accounts: [
        { address: this.signer.address, role: AccountRole.WRITABLE_SIGNER }, w(this.vault), ro(this.vaultUsdc), ro(config), w(treasuryLp),
        ro(address("11111111111111111111111111111111")),
      ],
      data: IX.compoundProtocolFees,
    });
    console.log(`[keeper] compounded ${Number(v.protocolFees) / 1e6} USDC of protocol fees into the vault (treasury-owned)`);
  }

  private async checkHealth(slot: bigint, orders: OrderRequest[]) {
    const v = await this.readVault();
    const priceAge = Math.floor(Date.now() / 1000) - v.solUsdTs;
    const lagging = orders.filter((o) => slot > o.requestSlot + FILL_DELAY_SLOTS + FILL_LAG_SLOTS);
    const balance = async (a: Address) => (await this.rpc.getBalance(a, { commitment: "confirmed" }).send()).value;
    const keeperSol = await balance(this.signer.address);
    const conditions: Condition[] = [
      { key: "price", active: priceAge > STALE_PRICE_S, message: `SOL/USD in the vault is ${priceAge}s old (limit ${STALE_PRICE_S}s): new positions are blocked` },
      { key: "fills", active: lagging.length > 0, message: `${lagging.length} order(s) unfilled ${FILL_LAG_SLOTS}+ slots past their delay` },
      { key: "keeper-sol", active: keeperSol < LOW_SOL_LAMPORTS, message: `keeper ${this.signer.address} has ${Number(keeperSol) / 1e9} SOL` },
      { key: "loop", active: this.monitor.failures >= 5, message: `keeper loop failing: ${this.monitor.lastTickError}` },
    ];
    if (this.relayerAddress) {
      const r = await balance(this.relayerAddress);
      conditions.push({ key: "relayer-sol", active: r < LOW_SOL_LAMPORTS, message: `relayer ${this.relayerAddress} has ${Number(r) / 1e9} SOL` });
    }
    for (const m of this.markets.values()) {
      const quiet = this.quietMarkets.has(m.key) || this.retired.has(m.key);
      conditions.push({ key: `adl:${m.key}`, active: m.adlMode, message: `market ${m.key} spent its risk budget: reduce-only with ADL` });
      conditions.push({ key: `ro:${m.key}`, active: m.reduceOnly && !m.adlMode && !quiet, message: `market ${m.key} is reduce-only` });
    }
    await this.monitor.update(conditions);
  }

  /** Graduated markets price from their Raydium pool, passed as remaining accounts. */
  private async poolTail(m: Market) {
    return m.tier >= 1 ? priceAccounts(m.mint) : [];
  }

  private async graduate() {
    const curves = await this.rpc
      .getProgramAccounts(LAUNCH_PROGRAM, {
        encoding: "base64",
        filters: [{ memcmp: { offset: 0n, bytes: base58(disc("account", "Curve")), encoding: "base58" } }],
      })
      .send();
    const decoded = (curves as unknown as { pubkey: Address; account: { data: [string, string] } }[]).map((a) =>
      decodeCurve(a.pubkey, new Uint8Array(Buffer.from(a.account.data[0], "base64"))),
    );
    for (const c of decoded.filter((c) => c.complete && !c.migrated)) {
      await this.guard(`migrate:${c.mint}`, async () => {
        const [global] = await getProgramDerivedAddress({ programAddress: LAUNCH_PROGRAM, seeds: [new TextEncoder().encode("global")] });
        const g = await this.rpc.getAccountInfo(global, { encoding: "base64" }).send();
        const feeRecipient = decodeFeeRecipient(new Uint8Array(Buffer.from(g.value!.data[0], "base64")));
        await this.sendIx(await migrateIx(this.signer.address, c.mint, feeRecipient), 400_000);
        console.log(`[keeper] ${c.mint} graduated to Raydium`);
        c.migrated = true;
      });
    }
    const migrated = new Set(decoded.filter((c) => c.migrated).map((c) => c.key as string));
    for (const m of this.markets.values()) {
      if (m.tier !== 0 || !migrated.has(m.curve)) continue;
      await this.guard(`graduate:${m.key}`, async () => {
        await this.sendIx(await graduateMarketIx(m.key, m.curve, m.mint));
        m.tier = 1;
        console.log(`[keeper] market ${m.key} now prices from its Raydium pool`);
      });
    }
  }

  private async build(ix: Instruction, computeUnits?: number) {
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(computeUnits ? [computeUnitLimit(computeUnits), ix] : [ix], m),
    );
    return signTransactionMessageWithSigners(msg);
  }

  private async wouldSucceed(ix: Instruction): Promise<boolean> {
    const tx = await this.build(ix);
    const sim = await this.rpc
      .simulateTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", sigVerify: false })
      .send();
    return sim.value.err === null;
  }

  private async sendIx(ix: Instruction, computeUnits?: number) {
    const tx = await this.build(ix, computeUnits);
    await this.send(tx as Parameters<typeof this.send>[0], { commitment: "confirmed" });
  }

  /** Runs `fn` once per key at a time; logs and swallows errors so one bad account can't stall the loop. */
  private async guard(key: string, fn: () => Promise<void>) {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      await fn();
    } catch (e) {
      // Surface the program's own error from the simulation logs.
      const err = e as { message: string; context?: { logs?: string[] }; cause?: { context?: { logs?: string[] } } };
      const logs = err.context?.logs ?? err.cause?.context?.logs ?? [];
      const reason = logs.find((l) => l.includes("Error Code") || l.includes("Error Message")) ?? logs.slice(-2).join(" | ");
      console.warn(`[keeper] ${key}: ${err.message}${reason ? ` — ${reason}` : ""}`);
      // A program refusal (cap, leverage, reduce-only...) won't change in 2 seconds; don't hammer the RPC.
      if (/Error Code: (?!TooEarly)/.test(reason)) {
        this.backoffUntil.set(key, Date.now() + FAILED_ORDER_BACKOFF_MS);
        console.warn(`[keeper] ${key}: refused by the program; retrying in ${FAILED_ORDER_BACKOFF_MS / 1000}s`);
      }
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** Quanto PnL estimate in USDC base units at a Q64 price. */
export function estPnl(p: Position, priceQ64: bigint): bigint {
  if (p.entryQ64 === 0n) return 0n;
  const change = ((priceQ64 - p.entryQ64) * p.sizeUsd) / p.entryQ64;
  return p.side === 0 ? change : -change;
}

const addr = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
/** Base58 for the 8-byte discriminator filter. */
const base58 = (b: Uint8Array): Base58EncodedBytes => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of b) { if (byte === 0) s = "1" + s; else break; }
  return s as Base58EncodedBytes;
};
const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const computeUnitLimit = (units: number): Instruction => {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data };
};
const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const signer = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER });

export async function ata(owner: Address, mint: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [addr(owner), addr(TOKEN_PROGRAM), addr(mint)] });
  return a;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const key = process.env.KEEPER_KEY;
  const keyFile = process.env.KEEPER_KEYPAIR;
  const usdc = process.env.USDC_MINT;
  const interval = Number(process.env.KEEPER_INTERVAL_MS ?? 400);
  if (!rpcUrl || (!key && !keyFile) || !usdc) {
    console.error("Set RPC_URL, USDC_MINT and KEEPER_KEY (base58) or KEEPER_KEYPAIR (Solana CLI JSON file)");
    process.exit(1);
  }
  const rpc = createSolanaRpc(rpcUrl);
  const ws = createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws"));
  const secret = keyFile
    ? Uint8Array.from(JSON.parse((await import("node:fs")).readFileSync(keyFile, "utf8")))
    : new Uint8Array(getBase58Encoder().encode(key!));
  const signerKp = await createKeyPairSignerFromBytes(secret);
  const keeper = new Keeper(rpc, ws, signerKp, address(usdc));
  await keeper.init();
  if (process.env.TEST_SOL_PRICE_USD) {
    keeper.testSolPriceE6 = BigInt(Math.round(Number(process.env.TEST_SOL_PRICE_USD) * 1e6));
    console.log(`[keeper] pushing a fixed SOL/USD of $${process.env.TEST_SOL_PRICE_USD} every minute`);
  } else {
    const [vault] = await getProgramDerivedAddress({ programAddress: PERPS_PROGRAM, seeds: [new TextEncoder().encode("vault")] });
    keeper.pyth = new PythPoster(new Connection(rpcUrl, "confirmed"), Keypair.fromSecretKey(secret), new PublicKey(PERPS_PROGRAM), new PublicKey(vault));
    console.log("[keeper] SOL/USD from Pyth");
  }
  console.log(`[keeper] running as ${signerKp.address}`);
  if (process.env.KEEPER_HEALTH_PORT) {
    keeper.monitor.serve(Number(process.env.KEEPER_HEALTH_PORT));
    console.log(`[keeper] health on :${process.env.KEEPER_HEALTH_PORT}/health`);
  }
  console.log(`[keeper] alerts ${process.env.ALERT_WEBHOOK_URL ? "to webhook" : "to this log only (set ALERT_WEBHOOK_URL)"}`);
  for (;;) {
    try {
      await keeper.tick();
      keeper.monitor.tickSucceeded();
    } catch (e) {
      keeper.monitor.tickFailed(e as Error);
      console.warn(`[keeper] tick failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1]?.endsWith("keeper.js") || process.argv[1]?.endsWith("keeper.ts")) void main();
