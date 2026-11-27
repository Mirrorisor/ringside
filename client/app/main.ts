import "./polyfills";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { mountSocial } from "./social/screens";
import { backendBase, devOverride } from "./social/config";
import launchIdl from "../../target/idl/ringside_launch.json";
import perpsIdl from "../../target/idl/ringside_perps.json";
import { feeView, type FeeInput } from "../src/creatorfees";
import {
  GROSS_CAP_MULT, buildOrderInstruction, decodeMarket, decodePosition, decodeVault, marketPda, oiCap, orderPda as perpsOrderPda,
  perpsCoders, positionPda as perpsPositionPda, tierParams, vaultPda, vaultUsdcPda,
} from "../src/perps/index";

// ---------------------------------------------------------------------------
// Config. Devnet by default; ?network=mainnet (or VITE_NETWORK=mainnet at build
// time) switches Raydium, the explorer and the chain, turns the faucet and the
// browser signing key off, and needs ?rpc=… (or VITE_RPC) for a mainnet RPC.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};
const NETWORK = (params.get("network") ?? env.VITE_NETWORK ?? "devnet") === "mainnet" ? "mainnet" : "devnet";
const MAINNET = NETWORK === "mainnet";
const NET = MAINNET
  ? { rpc: env.VITE_RPC, cpmm: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", ammConfig: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2", cluster: "", chain: "solana:mainnet" }
  : { rpc: "https://api.devnet.solana.com", cpmm: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb", ammConfig: "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy", cluster: "?cluster=devnet", chain: "solana:devnet" };
const RPC = devOverride("rpc") ?? NET.rpc ?? "";
if (!RPC) document.body.insertAdjacentHTML("afterbegin", "<p style='padding:16px;background:#d8382f;color:#fff'>Mainnet needs an RPC: add ?rpc=… or build with VITE_RPC.</p>");
// Backend overrides (?relayer=, ?faucet=, ?rpc=, ?chain=) work only in dev builds and only for allowlisted origins (see social/config.ts):
// a hostile relayer could name its own treasury as the USDC fee recipient.
const RELAYER = backendBase("relayer", "/relayer");
const FAUCET = backendBase("faucet", "/faucet");
const USDC = 1_000_000;
const TWAP_WINDOW = 750n;
const BAND_BPS = 1500n;
const Q64 = 2n ** 64n;
const U128 = 2n ** 128n;
const TICK_MS = 6_000;
const CURVE_SUPPLY = 800_000_000_000_000n; // 800M tokens, 6 decimals
const POOL_TWAP_SECONDS = 300n;
// Raydium CPMM, where graduated tokens trade.
const CPMM = new PublicKey(NET.cpmm);
const AMM_CONFIG = new PublicKey(NET.ammConfig);
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SWAP_BASE_INPUT = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const usd = (v: number) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Local devnet keys (kept in this browser only)
// ---------------------------------------------------------------------------
function loadKey(name: string): Keypair {
  try {
    const raw = localStorage.getItem(name);
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch { /* fall through */ }
  const kp = Keypair.generate();
  try { localStorage.setItem(name, JSON.stringify(Array.from(kp.secretKey))); } catch { /* memory only */ }
  return kp;
}
const localWallet = loadKey("ringside.devnet.wallet");

// ---------------------------------------------------------------------------
// Browser wallet (Wallet Standard: Phantom, Backpack, Solflare…). Until one is
// connected, the devnet browser key above signs. The trading account stays a
// separate fresh key either way (funded privately through Rings).
// ---------------------------------------------------------------------------
const CHAIN = NET.chain; // not overridable by link
type StdAccount = { address: string; publicKey: Uint8Array };
let external: { name: string; wallet: any; account: StdAccount } | null = null;
const wallet = {
  get publicKey(): PublicKey {
    return external ? new PublicKey(external.account.publicKey) : localWallet.publicKey;
  },
};
// Wallet Standard discovery, without a library: wallets register through these
// two window events (https://github.com/wallet-standard/wallet-standard).
const registered: any[] = [];
const register = (...ws: any[]) => {
  for (const w of ws) if (!registered.includes(w)) registered.push(w);
  return () => {};
};
window.addEventListener("wallet-standard:register-wallet", (e: Event) => (e as CustomEvent).detail?.({ register }));
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } }));
const solanaWallets = () =>
  registered.filter((w: any) => "standard:connect" in w.features && "solana:signTransaction" in w.features && w.chains.some((c: string) => c.startsWith("solana:")));

async function connectWallet() {
  const found = solanaWallets();
  if (!found.length) return log("No Solana wallet extension found (Phantom, Backpack, Solflare). Still using the devnet browser wallet.");
  const w: any = found[0];
  const { accounts } = await w.features["standard:connect"].connect();
  if (!accounts?.length) return log(`${w.name} returned no account.`);
  external = { name: w.name, wallet: w, account: accounts[0] };
  (provider as unknown as { publicKey: PublicKey }).publicKey = wallet.publicKey;
  log(`Connected ${w.name}: ${short(wallet.publicKey)}. Launches and trades are now signed in your wallet.`);
  ($("connect") as HTMLButtonElement).textContent = w.name;
  void tick();
  void loadMine().catch(() => {});
}
const trader = loadKey("ringside.devnet.trading");

const connection = new Connection(RPC, { commitment: "confirmed" });
const signerWallet = {
  get publicKey() {
    return wallet.publicKey;
  },
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!external) {
      if (MAINNET) throw new Error("Connect a wallet first: on mainnet only your own wallet signs.");
      if (tx instanceof VersionedTransaction) tx.sign([localWallet]); else tx.partialSign(localWallet);
      return tx;
    }
    const bytes = tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const [{ signedTransaction }] = await external.wallet.features["solana:signTransaction"].signTransaction({
      account: external.account, transaction: bytes, chain: CHAIN,
    });
    return (tx instanceof VersionedTransaction ? VersionedTransaction.deserialize(signedTransaction) : Transaction.from(signedTransaction)) as T;
  },
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const t of txs) await signerWallet.signTransaction(t);
    return txs;
  },
};
const provider = new AnchorProvider(connection, signerWallet as never, { commitment: "confirmed" });
const launch = new Program(launchIdl as Idl, provider) as any;
const perps = new Program(perpsIdl as Idl, provider) as any;

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const enc = (s: string) => Buffer.from(s);
const GLOBAL = pda([enc("global")], launch.programId);
const VAULT = vaultPda(perps.programId);
const VAULT_USDC = vaultUsdcPda(perps.programId);
const perpsCoder = perpsCoders(perpsIdl as Idl);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
type CurveRow = { key: PublicKey; acc: any };
const st: {
  curves: CurveRow[]; selected: PublicKey | null; global: any; vault: any; usdcMint: PublicKey | null;
  curve: any; market: any; positions: Record<number, any | null>; orders: Record<number, boolean>;
  slot: bigint; vaultUsdc: number; walletSol: number; traderSol: number; traderUsdc: number; walletTokens: number;
  hist: { spot: number; mark: number; lo: number; hi: number }[]; mode: "perp" | "spot"; side: 0 | 1; busy: boolean;
  /** Raydium pool of a graduated token: vault balances and the raw ObservationState. */
  pool: { tokens: bigint; sol: bigint; obs: Buffer } | null;
  /** Curves this wallet created, with each one's perp market (null when it has none). */
  mine: { curve: any; market: any | null }[];
} = {
  pool: null, mine: [],
  curves: [], selected: null, global: null, vault: null, usdcMint: null, curve: null, market: null,
  positions: { 0: null, 1: null }, orders: { 0: false, 1: false }, slot: 0n, vaultUsdc: 0, walletSol: 0, traderSol: 0, traderUsdc: 0,
  walletTokens: 0, hist: [], mode: "perp", side: 0, busy: false,
};

function log(msg: string, sig?: string) {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `${esc(time)} · ${esc(msg)}${sig ? ` · <a href="https://explorer.solana.com/tx/${esc(sig)}${NET.cluster}" target="_blank" rel="noopener">view</a>` : ""}`;
  $("log").prepend(line);
}

// ---------------------------------------------------------------------------
// Price maths (mirrors the programs)
// ---------------------------------------------------------------------------
const big = (b: BN) => BigInt(b.toString());
/** Q64 lamports per base unit -> SOL per whole token. */
const qToSolPerToken = (q: bigint) => Number(q) / 2 ** 64 / 1000;
const spotQ = (c: any) => (big(c.virtualSol) << 64n) / big(c.virtualTokens);

function twapQ(c: any, now: bigint): bigint {
  const lastPrice = big(c.lastPriceQ64);
  const cumAt = (slot: bigint) => (big(c.priceCumulative) + lastPrice * (slot > big(c.lastSlot) ? slot - big(c.lastSlot) : 0n)) % U128;
  const cutoff = now > TWAP_WINDOW ? now - TWAP_WINDOW : 0n;
  let best: { slot: bigint; cum: bigint } | null = null, oldest: { slot: bigint; cum: bigint } | null = null;
  for (let i = 0; i < c.obsCount; i++) {
    const o = { slot: big(c.observations[i].slot), cum: big(c.observations[i].cumulative) };
    if (o.slot <= cutoff && (!best || o.slot > best.slot)) best = o;
    if (!oldest || o.slot < oldest.slot) oldest = o;
  }
  const start = best ?? oldest;
  if (!start || now <= start.slot) return lastPrice;
  return (((cumAt(now) - start.cum) % U128) + U128) % U128 / (now - start.slot);
}
const clampBand = (p: bigint, a: bigint) => {
  const lo = (a * (10000n - BAND_BPS)) / 10000n, hi = (a * (10000n + BAND_BPS)) / 10000n;
  return p < lo ? lo : p > hi ? hi : p;
};
// --- Raydium pool (graduated tokens) ----------------------------------------
function poolKeys(mint: PublicKey) {
  const [t0, t1] = mint.toBuffer().compare(NATIVE_MINT.toBuffer()) < 0 ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint];
  const pool = pda([enc("pool"), AMM_CONFIG.toBuffer(), t0.toBuffer(), t1.toBuffer()], CPMM);
  const vault = (m: PublicKey) => pda([enc("pool_vault"), pool.toBuffer(), m.toBuffer()], CPMM);
  return {
    pool, tokenVault: vault(mint), solVault: vault(NATIVE_MINT), tokenIs0: t0.equals(mint),
    observation: pda([enc("observation"), pool.toBuffer()], CPMM),
    authority: pda([enc("vault_and_lp_mint_auth_seed")], CPMM),
  };
}
/** Mirrors pool_twap_x32 in the perps program; returns Q64. */
function poolTwapQ(obs: Buffer, tokenIs0: boolean, spotX32: bigint, now: bigint): bigint {
  const BASE = 43;
  if (obs.length < BASE + 4000 || obs[8] === 0) return spotX32 << 32n;
  const latest = obs.readUInt16LE(9) % 100;
  const ts = (k: number) => obs.readBigUInt64LE(BASE + k * 40);
  const cum = (k: number) => {
    const o = BASE + k * 40 + 8 + (tokenIs0 ? 0 : 16);
    return obs.readBigUInt64LE(o) + (obs.readBigUInt64LE(o + 8) << 64n);
  };
  const tl = ts(latest);
  if (tl === 0n || tl > now) return spotX32 << 32n;
  const cumNow = (cum(latest) + spotX32 * (now - tl)) % U128;
  const cutoff = now > POOL_TWAP_SECONDS ? now - POOL_TWAP_SECONDS : 0n;
  let best: [bigint, bigint] | null = null, oldest: [bigint, bigint] | null = null;
  for (let k = 0; k < 100; k++) {
    const t = ts(k);
    if (t === 0n || t > now) continue;
    if (t <= cutoff && (!best || t > best[0])) best = [t, cum(k)];
    if (!oldest || t < oldest[0]) oldest = [t, cum(k)];
  }
  const start = best ?? oldest;
  if (!start || now <= start[0]) return spotX32 << 32n;
  return ((((cumNow - start[1]) % U128) + U128) % U128 / (now - start[0])) << 32n;
}
const graduated = () => !!(st.curve?.migrated && st.pool && st.market && st.market.tier >= 1);
/** Spot the perps program uses: the curve, or the Raydium pool once the market graduated. */
function spotNow(): bigint {
  if (st.curve?.migrated && st.pool) return ((st.pool.sol << 32n) / st.pool.tokens) << 32n;
  return spotQ(st.curve);
}
/** Spot as the perps program sees it: the pool only once the market has graduated. */
const perpSpot = () => (graduated() ? spotNow() : spotQ(st.curve));
function twapNow(c: any, slot: bigint): bigint {
  if (graduated()) {
    const k = poolKeys(c.mint);
    return poolTwapQ(st.pool!.obs, k.tokenIs0, (st.pool!.sol << 32n) / st.pool!.tokens, BigInt(Math.floor(Date.now() / 1000)));
  }
  return twapQ(c, slot);
}

function markQ(m: any, c: any, slot: bigint): { mark: bigint; anchor: bigint; clamped: boolean } {
  const twap = twapNow(c, slot);
  const elapsed = slot > big(m.bandAnchorSlot) ? (slot - big(m.bandAnchorSlot)) / TWAP_WINDOW : 0n;
  let anchor = big(m.bandAnchorQ64);
  for (let i = 1n; i < (elapsed < 64n ? elapsed : 64n); i++) anchor = clampBand(twap, anchor);
  const mark = clampBand(twap, anchor);
  return { mark, anchor, clamped: mark !== twap };
}
/** Tier table and GROSS_CAP_MULT come from the shared perps module (mirrors tier_params in programs/ringside_perps). */
const tierOf = () => { const p = tierParams(Math.min(st.market?.tier ?? 0, 2)); return { lev: Number(p.maxLeverage), fee: Number(p.feeBps) / 10000 }; };
function caps() {
  const v = st.vault, c = st.curve;
  if (!v || !c) return null;
  const reserve = graduated() ? st.pool!.sol : big(c.virtualSol);
  const cap = Number(oiCap(v, reserve)!) / USDC;
  // Each side may reach GROSS_CAP_MULT x cap; the vault's net exposure stays within the skew limit.
  return { cap, side: cap * Number(GROSS_CAP_MULT), account: cap * 0.2, skew: (cap * v.skewCapBps) / 10000 };
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------
const positionPda = (market: PublicKey, side: number) => perpsPositionPda(perps.programId, trader.publicKey, market, side);
const orderPda = (market: PublicKey, side: number) => perpsOrderPda(perps.programId, trader.publicKey, market, side);
const tokenAmount = (data: Buffer | null | undefined) => (data && data.length >= 72 ? Number(data.readBigUInt64LE(64)) : 0);

async function loadCurves() {
  const all: CurveRow[] = (await launch.account.curve.all()).map((r: any) => ({ key: r.publicKey, acc: r.account }));
  all.sort((a, b) => Number(big(b.acc.createdSlot) - big(a.acc.createdSlot)));
  st.curves = all;
  if (!st.selected && all.length) st.selected = all[0].acc.mint;
  renderMarkets();
  await loadMine();
}

/** The wallet's own launches and their perp markets (for the creator-fee numbers and claim buttons). */
async function loadMine() {
  const me = wallet.publicKey;
  const mine = st.curves.filter((r) => r.acc.creator.equals(me)).map((r) => r.acc);
  const out: { curve: any; market: any | null }[] = [];
  for (let i = 0; i < mine.length; i += 100) {
    const chunk = mine.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((c) => marketPda(perps.programId, c.mint)));
    chunk.forEach((c, j) => out.push({ curve: c, market: infos[j] ? decodeMarket(perpsCoder, infos[j]!.data) : null }));
  }
  st.mine = out;
  renderMine();
}

async function tick() {
  if (!st.global) st.global = await launch.account.global.fetch(GLOBAL);
  const mint = st.selected;
  const keys: PublicKey[] = [VAULT, wallet.publicKey, trader.publicKey, VAULT_USDC];
  if (st.usdcMint) keys.push(getAssociatedTokenAddressSync(st.usdcMint, trader.publicKey));
  let curveKey: PublicKey | null = null, market: PublicKey | null = null;
  if (mint) {
    curveKey = pda([enc("curve"), mint.toBuffer()], launch.programId);
    market = marketPda(perps.programId, mint);
    keys.push(curveKey, market, getAssociatedTokenAddressSync(mint, wallet.publicKey),
      positionPda(market, 0), positionPda(market, 1), orderPda(market, 0), orderPda(market, 1));
  }
  const [infos, slot] = await Promise.all([connection.getMultipleAccountsInfo(keys), connection.getSlot("confirmed")]);
  st.slot = BigInt(slot);
  const [vaultInfo, wInfo, tInfo, vuInfo] = infos;
  st.vaultUsdc = tokenAmount(vuInfo?.data) / USDC;
  if (vaultInfo) {
    st.vault = decodeVault(perpsCoder, vaultInfo.data);
    st.usdcMint = st.vault.usdcMint;
  }
  st.walletSol = (wInfo?.lamports ?? 0) / LAMPORTS_PER_SOL;
  st.traderSol = tInfo?.lamports ?? 0;
  let i = 4;
  if (keys.length > 4 && st.usdcMint && keys[4].equals(getAssociatedTokenAddressSync(st.usdcMint, trader.publicKey))) {
    st.traderUsdc = tokenAmount(infos[4]?.data) / USDC;
    i = 5;
  }
  if (mint) {
    const [cI, mI, wtI, p0, p1, o0, o1] = infos.slice(i);
    st.curve = cI ? launch.coder.accounts.decode("curve", cI.data) : null;
    st.market = mI ? decodeMarket(perpsCoder, mI.data) : null;
    st.walletTokens = tokenAmount(wtI?.data) / 1e6;
    st.positions = {
      0: p0 ? decodePosition(perpsCoder, p0.data) : null,
      1: p1 ? decodePosition(perpsCoder, p1.data) : null,
    };
    st.orders = { 0: !!o0, 1: !!o1 };
    st.pool = null;
    if (st.curve?.migrated) {
      const k = poolKeys(mint);
      const [tv, sv, ob] = await connection.getMultipleAccountsInfo([k.tokenVault, k.solVault, k.observation]);
      if (tv && sv && ob) st.pool = { tokens: BigInt(tokenAmount(tv.data)), sol: BigInt(tokenAmount(sv.data)), obs: ob.data };
    }
    if (st.curve && st.market) {
      const { mark, anchor } = markQ(st.market, st.curve, st.slot);
      st.hist.push({
        spot: qToSolPerToken(spotNow()), mark: qToSolPerToken(mark),
        lo: qToSolPerToken((anchor * 8500n) / 10000n), hi: qToSolPerToken((anchor * 11500n) / 10000n),
      });
      if (st.hist.length > 200) st.hist.shift();
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/** Sets innerHTML only when it changed, so buttons aren't replaced under the pointer. */
function setHtml(el: HTMLElement, html: string) {
  if ((el as HTMLElement & { _html?: string })._html === html) return;
  (el as HTMLElement & { _html?: string })._html = html;
  el.innerHTML = html;
}

/** Share of the curve's 800M tokens sold, in percent. */
const progress = (c: any) => Number(((CURVE_SUPPLY - big(c.realTokens)) * 10000n) / CURVE_SUPPLY) / 100;

function renderMarkets() {
  const solUsd = st.vault ? Number(st.vault.solUsdE6) / USDC : 150;
  setHtml($("markets"), st.curves.length
    ? st.curves.map((r) => {
        const c = r.acc, sold = progress(c);
        const mcap = qToSolPerToken(spotQ(c)) * 1e9 * solUsd;
        return `<button class="mk" data-mint="${esc(c.mint.toBase58())}" aria-current="${st.selected?.equals(c.mint) ?? false}">
          <div><b>${esc(c.name)}</b> <span class="muted">$${esc(c.symbol)}</span><div class="bar" style="margin-top:6px;width:120px"><i style="width:${sold}%"></i></div></div>
          <div style="text-align:right"><b>${c.migrated ? "Raydium" : usd(mcap)}</b><div class="muted">${c.migrated ? "graduated" : c.complete ? "graduating…" : "perps · tier 0"}</div></div></button>`;
      }).join("")
    : `<span class="muted">No tokens yet. Launch the first one.</span>`);
}

// ---------------------------------------------------------------------------
// Creator fees (docs/creator-fee-lock.md): 20% claimable now, 80% at graduation, forfeited after 30 days.
// ---------------------------------------------------------------------------
const bn = (x: any): bigint => (x === undefined || x === null ? 0n : BigInt(x.toString()));
/** Old accounts decode without the locked field (reads as 0). */
function feeInput(c: any, m: any | null): FeeInput {
  return {
    complete: !!c.complete, createdTs: bn(c.createdTs),
    sol: { early: bn(c.creatorFeesOwed), locked: bn(c.creatorFeesLocked) },
    usdc: m ? { early: bn(m.creatorFees), locked: bn(m.creatorFeesLocked) } : null,
  };
}
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
/** The panel body: numbers for everyone, claim buttons only when this wallet created the curve. */
function feesHtml(c: any, m: any | null, buttons: boolean): string {
  const v = feeView(feeInput(c, m), nowS());
  const mine = buttons && c.creator.equals(wallet.publicKey);
  const mint = esc(c.mint.toBase58());
  const rows = v.streams.map((s) => `<div class="rows" style="margin:0"><div><span>${esc(s.label)} · claimable now</span><span>${esc(s.claimable)}</span></div>
      <div><span>Locked until graduation</span><span>${esc(s.locked)}</span></div></div>`).join("");
  const btns = mine ? `<div class="btns">${v.streams.map((s) =>
    `<button class="primary" data-claim="${s.key}" data-mint="${mint}" ${s.canClaim && !st.busy ? "" : "disabled"} title="${esc(s.payNote)}">${esc(s.button)}</button>
     <span class="muted" style="margin:-2px 0 2px">${esc(s.payNote)}${s.key === "usdc" ? "; your USDC account is created if missing" : ""}</span>`).join("")}</div>` : "";
  return `${rows}<div class="${v.status === "overdue" || v.status === "forfeited" ? "warn" : "muted"}" style="margin:0">${esc(v.line)}</div>
    <p class="note" style="margin:0">${esc(v.note)}</p>${btns}`;
}
function renderFees() {
  setHtml($("feesBody"), st.curve ? feesHtml(st.curve, st.market, true) : `<span class="muted">Pick a market.</span>`);
}
function renderMine() {
  ($("mineCard") as HTMLElement).hidden = st.mine.length === 0;
  setHtml($("mine"), st.mine.map(({ curve: c, market: m }) =>
    `<div class="ml"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px"><button class="lnk" data-pick="${esc(c.mint.toBase58())}">${esc(c.name)} <span class="muted">$${esc(c.symbol)}</span></button></div>
     <div class="fees">${feesHtml(c, m, true)}</div></div>`).join(""));
}

function render() {
  renderMine();
  $("wAddr").textContent = short(wallet.publicKey);
  $("wSol").textContent = `${st.walletSol.toFixed(3)} SOL`;
  $("tAddr").textContent = short(trader.publicKey);
  $("tUsdc").textContent = usd(st.traderUsdc);
  $("tSol").textContent = `${st.traderSol} lamports`;
  const solUsd = st.vault ? Number(st.vault.solUsdE6) / USDC : 0;
  $("solPx").textContent = st.vault ? `${usd(solUsd)} (${Math.round(Date.now() / 1000 - Number(st.vault.solUsdTs))}s old)` : "–";
  if (st.vault) {
    // LP money = vault balance minus trader collateral and reserved fees/insurance (mirrors lp_assets()).
    const lp = st.vaultUsdc - Number(st.vault.traderCollateral) / USDC - Number(st.vault.reserved) / USDC;
    $("vTvl").textContent = `${usd(lp)} (of ${usd(st.vaultUsdc)} held)`;
  }

  const c = st.curve, m = st.market;
  if (!c) return;
  $("tName").textContent = `${c.name} · $${c.symbol}`;
  void showTokenImage(c.uri);
  const stage = c.migrated ? (m && m.tier >= 1 ? " · graduated: spot and perps price from Raydium" : " · graduated, moving perps to the pool price…") : c.complete ? " · sold out, graduating to Raydium…" : "";
  $("tSub").textContent = `Mint ${short(c.mint)} · ${m ? `perp market tier ${m.tier}${m.reduceOnly ? " · reduce-only" : ""}` : "no perp market yet"}${stage}`;
  const spot = qToSolPerToken(spotNow());
  $("sSpot").textContent = `${spot.toExponential(3)} SOL`;
  $("sCap").textContent = usd(spot * 1e9 * solUsd);
  const sold = progress(c);
  $("sProg").textContent = c.migrated && st.pool
    ? `pool: ${(Number(st.pool.sol) / LAMPORTS_PER_SOL).toFixed(3)} SOL`
    : `${sold.toFixed(1)}% sold · ${(Number(c.realSol) / LAMPORTS_PER_SOL).toFixed(3)} SOL raised`;
  ($("sProgBar") as HTMLElement).style.width = `${c.migrated ? 100 : sold}%`;
  let mk: ReturnType<typeof markQ> | null = null;
  if (m) {
    mk = markQ(m, c, st.slot);
    $("sMark").textContent = `${qToSolPerToken(mk.mark).toExponential(3)} SOL`;
    const k = caps();
    if (k) {
      const oiL = Number(m.oiLong) / USDC, oiS = Number(m.oiShort) / USDC;
      $("oiL").textContent = `${usd(oiL)} / ${usd(k.side)}`;
      $("oiS").textContent = `${usd(oiS)} / ${usd(k.side)}`;
      $("skew").textContent = `${usd(oiL - oiS)} / ±${usd(k.skew)}`;
    }
  }
  drawChart();
  renderFees();
  renderTicket(mk);
  renderPositions(mk);
  $("sHeld").textContent = `${st.walletTokens.toLocaleString()} ${c.symbol}`;
  const sol = parseFloat(($("solIn") as HTMLInputElement).value) || 0;
  const [x, y] = c.migrated && st.pool ? [st.pool.sol, st.pool.tokens] : [big(c.virtualSol), big(c.virtualTokens)];
  const net = BigInt(Math.floor(sol * (c.migrated ? 0.9975 : 0.99) * LAMPORTS_PER_SOL));
  $("sOut").textContent = sol > 0 ? `${(Number(y - (x * y) / (x + net)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${c.symbol}` : "–";
}

const imageCache = new Map<string, string>();
/** Shows the token's image from its metadata JSON (only http(s) image links). */
async function showTokenImage(uri: string) {
  const img = $("tImg") as HTMLImageElement;
  if (!uri || !/^https?:\/\//.test(uri)) { img.hidden = true; return; }
  try {
    if (!imageCache.has(uri)) {
      const meta = await (await fetch(uri)).json();
      imageCache.set(uri, typeof meta.image === "string" && /^https?:\/\//.test(meta.image) ? meta.image : "");
    }
    const src = imageCache.get(uri)!;
    img.hidden = !src;
    if (src && img.src !== src) img.src = src;
  } catch {
    imageCache.set(uri, "");
    img.hidden = true;
  }
}

/** Downloads the trading account's key: it holds margin, and lives only in this browser. */
function backupTradingKey() {
  const blob = new Blob([JSON.stringify(Array.from(trader.secretKey))], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ringside-trading-${trader.publicKey.toBase58().slice(0, 8)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  log("Trading key downloaded. Keep it safe: it controls this trading account's margin.");
}

function renderTicket(mk: ReturnType<typeof markQ> | null) {
  const col = parseFloat(($("col") as HTMLInputElement).value) || 0;
  const t = tierOf(), levInput = $("lev") as HTMLInputElement;
  const levMax = String(t.lev * 0.99);
  if (levInput.max !== levMax) {
    levInput.max = levMax;
    if (parseFloat(levInput.value) > t.lev * 0.99) levInput.value = levMax;
  }
  $("levMax").textContent = `Tier ${st.market?.tier ?? 0} max ${t.lev}x`;
  $("pFeeL").textContent = `Open fee (${(t.fee * 100).toFixed(2)}%)`;
  const lev = parseFloat(levInput.value);
  const size = col * lev, fee = size * t.fee;
  $("levV").textContent = `${lev.toFixed(2)}x`;
  $("pSize").textContent = usd(size);
  $("pFee").textContent = usd(fee);
  const btn = $("open") as HTMLButtonElement;
  btn.className = st.side ? "short" : "long";
  btn.textContent = `Open ${st.side ? "short" : "long"} ${usd(size)}`;
  let why = "";
  const k = caps(), m = st.market, c = st.curve;
  if (!m) why = "This token has no perp market yet.";
  else if (!k || !c || !mk) why = "Loading market…";
  else {
    const spot = perpSpot();
    const px = st.side === 0 ? (mk.mark > spot ? mk.mark : spot) : (mk.mark < spot ? mk.mark : spot);
    $("pPx").textContent = `${qToSolPerToken(px).toExponential(3)} SOL`;
    const oiL = Number(m.oiLong) / USDC, oiS = Number(m.oiShort) / USDC;
    const sideOi = st.side === 0 ? oiL : oiS, netAfter = oiL - oiS + (st.side === 0 ? size : -size);
    const existing = st.positions[st.side] ? Number(st.positions[st.side].sizeUsd) / USDC : 0;
    $("pCap").textContent = `${usd(k.account - existing)} / ${usd(k.side - sideOi)}`;
    const age = Date.now() / 1000 - Number(st.vault.solUsdTs);
    if (st.orders[st.side]) why = "An order on this side is waiting for the keeper.";
    else if (col <= 0) why = "Enter collateral.";
    else if (col > st.traderUsdc) why = "Not enough USDC in the trading account. Use Get test funds.";
    else if ((col - fee) * t.lev < size) why = `Above ${t.lev}x after the fee. Lower leverage a little.`;
    else if (existing + size > k.account) why = "Above your per-account cap for this market.";
    else if (sideOi + size > k.side) why = "This side of the market is full.";
    else if (Math.abs(netAfter) > k.skew) why = "Vault net exposure limit. Try the other side or a smaller size.";
    else if (mk.clamped) why = "Mark is at the band edge; new positions wait for it to catch up.";
    else if (c.complete && m.tier === 0) why = "Sold out: perps reopen once the market moves to the Raydium price.";
    else if (m.reduceOnly) why = "Market is reduce-only.";
    else if (age > 110) why = "SOL price is stale. Is the keeper running?";
  }
  btn.disabled = !!why || st.busy;
  $("pWhy").textContent = why;
}

function renderPositions(mk: ReturnType<typeof markQ> | null) {
  const body = $("pos");
  let shown = 0;
  for (const side of [0, 1]) {
    const p = st.positions[side];
    let row = body.querySelector<HTMLTableRowElement>(`tr[data-side="${side}"]`);
    if (!p || Number(p.sizeUsd) === 0) { row?.remove(); continue; }
    shown++;
    if (!row) {
      // Built once per open position; later ticks only update the text, so the Close button stays put.
      row = document.createElement("tr");
      row.dataset.side = String(side);
      row.innerHTML = `<td class="${side ? "down" : "up"}">${side ? "Short" : "Long"}</td><td class="n" data-f="size"></td><td class="n" data-f="col"></td>
        <td class="n" data-f="entry"></td><td class="n" data-f="pnl"></td><td class="n"><button data-close="${side}">Close</button></td>`;
      body.appendChild(row);
    }
    const size = Number(p.sizeUsd) / USDC, entry = big(p.entryPriceQ64);
    let pnl = 0;
    if (mk && st.curve) {
      const spot = perpSpot();
      const exit = side === 0 ? (mk.mark < spot ? mk.mark : spot) : (mk.mark > spot ? mk.mark : spot);
      pnl = size * (Number(exit) / Number(entry) - 1) * (side === 0 ? 1 : -1);
    }
    const f = (k: string) => row!.querySelector<HTMLElement>(`[data-f="${k}"]`)!;
    f("size").textContent = usd(size);
    f("col").textContent = usd(Number(p.collateral) / USDC);
    f("entry").textContent = qToSolPerToken(entry).toExponential(3);
    f("pnl").textContent = usd(pnl);
    f("pnl").className = `n ${pnl >= 0 ? "up" : "down"}`;
    const btn = row.querySelector<HTMLButtonElement>("button")!;
    const waiting = st.orders[side];
    btn.disabled = waiting || st.busy;
    btn.textContent = waiting ? "Waiting…" : "Close";
  }
  ($("posEmpty") as HTMLElement).hidden = shown > 0;
}

function drawChart() {
  const el = $("chart"), W = el.clientWidth, H = el.clientHeight, h = st.hist;
  if (!W || h.length < 2) { el.innerHTML = `<p class="muted">Collecting prices…</p>`; return; }
  const all = h.flatMap((p) => [p.spot, p.mark, p.lo, p.hi]);
  const lo = Math.min(...all) * 0.98, hi = Math.max(...all) * 1.02;
  const X = (i: number) => 8 + (i / (h.length - 1)) * (W - 16), Y = (v: number) => 10 + (1 - (v - lo) / (hi - lo || 1)) * (H - 20);
  const path = (k: "spot" | "mark" | "lo" | "hi") => h.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p[k]).toFixed(1)}`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><path d="${path("hi")}" fill="none" stroke="var(--rope)" stroke-width="1.5" opacity=".7"/>
    <path d="${path("lo")}" fill="none" stroke="var(--rope)" stroke-width="1.5" opacity=".7"/>
    <path d="${path("spot")}" fill="none" stroke="var(--soft)" stroke-width="1.3"/>
    <path d="${path("mark")}" fill="none" stroke="var(--ink)" stroke-width="2.5"/></svg>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function guarded(label: string, fn: () => Promise<void>) {
  if (st.busy) return;
  st.busy = true;
  render();
  try { await fn(); } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const code = /Error Code: (\w+)/.exec(msg)?.[1];
    log(`${label} failed: ${code ?? msg.slice(0, 160)}`);
    console.error(e);
  } finally {
    st.busy = false;
    await tick().catch(() => {});
  }
}

async function faucet() {
  await guarded("Faucet", async () => {
    const r = await fetch(`${FAUCET}/v1/faucet`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet.publicKey.toBase58(), tradingAccount: trader.publicKey.toBase58() }) });
    const b = await r.json();
    if (!r.ok) throw new Error(b.message ?? b.code);
    log(`Faucet: wallet ${b.wallet === "cooldown" ? "on cooldown" : "+0.25 SOL"}, trading account ${b.tradingAccount === "cooldown" ? "on cooldown" : "+50 test USDC"}`);
  });
}

async function launchToken(e: Event) {
  e.preventDefault();
  const name = ($("lName") as HTMLInputElement).value.trim(), symbol = ($("lSym") as HTMLInputElement).value.trim().toUpperCase();
  const dev = parseFloat(($("lDev") as HTMLInputElement).value) || 0;
  const description = ($("lDesc") as HTMLTextAreaElement).value.trim();
  const file = ($("lImg") as HTMLInputElement).files?.[0];
  if (!name || !symbol) return;
  await guarded("Launch", async () => {
    let uri = "";
    if (file || description) {
      if (file && file.size > 1024 * 1024) throw new Error("Image is limited to 1 MB.");
      const image = file
        ? await new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = fail; r.readAsDataURL(file); })
        : undefined;
      const res = await fetch(`${RELAYER}/v1/metadata`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, symbol, description, image }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? body.code);
      uri = body.uri;
      log(`Metadata stored: ${uri}`);
    }
    const mint = Keypair.generate();
    const curve = pda([enc("curve"), mint.publicKey.toBuffer()], launch.programId);
    const sig = await launch.methods
      .createToken({ name, symbol, uri, devBuyLamports: new BN(Math.floor(dev * LAMPORTS_PER_SOL)) })
      .accountsPartial({
        creator: wallet.publicKey, global: GLOBAL, mint: mint.publicKey, curve,
        curveTokenVault: getAssociatedTokenAddressSync(mint.publicKey, curve, true),
        devLockVault: pda([enc("dev_lock"), mint.publicKey.toBuffer()], launch.programId),
        feeRecipient: st.global.feeRecipient, insuranceRecipient: st.global.insuranceRecipient,
        metadata: pda([enc("metadata"), METAPLEX.toBuffer(), mint.publicKey.toBuffer()], METAPLEX), tokenMetadataProgram: METAPLEX,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([mint]).rpc();
    log(`Launched $${symbol}`, sig);
    const sig2 = await perps.methods.createMarket()
      .accountsPartial({ payer: wallet.publicKey, curve, market: marketPda(perps.programId, mint.publicKey), systemProgram: SystemProgram.programId })
      .rpc();
    log(`Opened the $${symbol} perp market`, sig2);
    st.selected = mint.publicKey;
    st.hist = [];
    (e.target as HTMLFormElement).reset();
    ($("lDev") as HTMLInputElement).value = "0.05";
    await loadCurves();
  });
}

function tradeAccounts(mint: PublicKey) {
  const curve = pda([enc("curve"), mint.toBuffer()], launch.programId);
  return {
    trader: wallet.publicKey, global: GLOBAL, mint, curve,
    curveTokenVault: getAssociatedTokenAddressSync(mint, curve, true),
    traderTokenAccount: getAssociatedTokenAddressSync(mint, wallet.publicKey),
    feeRecipient: st.global.feeRecipient, insuranceRecipient: st.global.insuranceRecipient,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}

/** Raydium CPMM swap for graduated tokens; wraps and unwraps SOL around it. */
async function raydiumSwap(mint: PublicKey, buying: boolean, amountIn: bigint) {
  const k = poolKeys(mint);
  const me = wallet.publicKey;
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, me), tok = getAssociatedTokenAddressSync(mint, me);
  const data = Buffer.alloc(24);
  SWAP_BASE_INPUT.copy(data, 0);
  data.writeBigUInt64LE(amountIn, 8);
  data.writeBigUInt64LE(1n, 16);
  const [inAcc, outAcc, inVault, outVault, inMint, outMint] = buying
    ? [wsol, tok, k.solVault, k.tokenVault, NATIVE_MINT, mint]
    : [tok, wsol, k.tokenVault, k.solVault, mint, NATIVE_MINT];
  const swap = new TransactionInstruction({
    programId: CPMM,
    keys: [
      { pubkey: me, isSigner: true, isWritable: false },
      { pubkey: k.authority, isSigner: false, isWritable: false },
      { pubkey: AMM_CONFIG, isSigner: false, isWritable: false },
      { pubkey: k.pool, isSigner: false, isWritable: true },
      { pubkey: inAcc, isSigner: false, isWritable: true },
      { pubkey: outAcc, isSigner: false, isWritable: true },
      { pubkey: inVault, isSigner: false, isWritable: true },
      { pubkey: outVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: inMint, isSigner: false, isWritable: false },
      { pubkey: outMint, isSigner: false, isWritable: false },
      { pubkey: k.observation, isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, wsol, me, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(me, tok, me, mint),
  );
  if (buying) tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: amountIn }), createSyncNativeInstruction(wsol));
  tx.add(swap, createCloseAccountInstruction(wsol, me, me));
  return provider.sendAndConfirm(tx);
}

async function buy() {
  const sol = parseFloat(($("solIn") as HTMLInputElement).value) || 0;
  if (!st.selected || sol <= 0) return;
  if (st.curve?.complete && !st.curve.migrated) return log("Sold out; buying reopens on Raydium in a moment.");
  if (st.curve?.migrated) {
    return guarded("Buy", async () => {
      const sig = await raydiumSwap(st.selected!, true, BigInt(Math.floor(sol * LAMPORTS_PER_SOL)));
      log(`Bought on Raydium with ${sol} SOL`, sig);
    });
  }
  await guarded("Buy", async () => {
    const sig = await launch.methods.buy(new BN(Math.floor(sol * LAMPORTS_PER_SOL)), new BN(1)).accountsPartial(tradeAccounts(st.selected!)).rpc();
    log(`Bought with ${sol} SOL`, sig);
  });
}

async function sellAll() {
  if (!st.selected || st.walletTokens <= 0) return;
  if (st.curve?.complete && !st.curve.migrated) return log("Sold out; selling reopens on Raydium in a moment.");
  if (st.curve?.migrated) {
    return guarded("Sell", async () => {
      const sig = await raydiumSwap(st.selected!, false, BigInt(Math.round(st.walletTokens * 1e6)));
      log(`Sold ${st.walletTokens.toLocaleString()} tokens on Raydium`, sig);
    });
  }
  await guarded("Sell", async () => {
    const sig = await launch.methods.sell(new BN(Math.floor(st.walletTokens * 1e6)), new BN(1)).accountsPartial(tradeAccounts(st.selected!)).rpc();
    log(`Sold ${st.walletTokens.toLocaleString()} tokens`, sig);
  });
}

/** Builds request_order signed by the trading account, sends it via the relayer, then waits for a keeper fill. */
async function sponsoredOrder(side: number, kind: number, collateral: number, size: number) {
  const mint = st.selected!;
  const info = await (await fetch(`${RELAYER}/v1/info`)).json();
  const relayer = new PublicKey(info.relayer);
  const market = marketPda(perps.programId, mint);
  const ix = buildOrderInstruction({
    idl: perpsIdl as Idl, action: kind ? "close" : "open", trader: trader.publicKey, payer: relayer, mint, side: side as 0 | 1, usdcMint: st.usdcMint!,
    collateral: BigInt(Math.round(collateral * USDC)), sizeUsd: BigInt(Math.round(size * USDC)), coders: perpsCoder,
  });
  let body: any;
  for (let attempt = 0; ; attempt++) {
    const tx = new Transaction({ feePayer: relayer, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(ix);
    // The relayer may ask for a small USDC sponsorship fee to its treasury.
    if (info.feeRecovery && BigInt(info.feeRecovery.minAmount) > 0n) {
      tx.add(createTransferInstruction(
        getAssociatedTokenAddressSync(st.usdcMint!, trader.publicKey), new PublicKey(info.feeRecovery.treasury), trader.publicKey,
        BigInt(info.feeRecovery.minAmount),
      ));
    }
    tx.partialSign(trader);
    const r = await fetch(`${RELAYER}/v1/sponsor`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.serialize({ requireAllSignatures: false }).toString("base64") }) });
    body = await r.json();
    if (r.ok) break;
    if (body.code !== "rpc_busy" || attempt >= 4) throw new Error(`relayer refused: ${body.code} ${body.message ?? ""}`);
    await sleep(8_000);
  }
  log(`Relayer sponsored ${kind ? "close" : "open"} order (paid ${(Number(body.spentLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`, body.signature);
  for (let i = 0; i < 40; i++) {
    await sleep(3_000);
    if (!(await connection.getAccountInfo(orderPda(market, side)))) { log(`Keeper filled the ${kind ? "close" : "open"} order`); return; }
  }
  log("Still waiting for a keeper. Is it running?");
}

async function openPosition() {
  const col = parseFloat(($("col") as HTMLInputElement).value) || 0;
  const size = col * parseFloat(($("lev") as HTMLInputElement).value);
  await guarded("Open", () => sponsoredOrder(st.side, 0, col, Math.floor(size * 100) / 100));
}

/** Claims one creator-fee stream with the connected wallet, signed like launches and buys. Amounts are re-read first. */
async function claimFees(mint: PublicKey, stream: "sol" | "usdc") {
  await guarded(`Claim ${stream === "sol" ? "SOL" : "USDC"} fees`, async () => {
    const curve = pda([enc("curve"), mint.toBuffer()], launch.programId);
    const market = marketPda(perps.programId, mint);
    const [cI, mI] = await connection.getMultipleAccountsInfo([curve, market]);
    if (!cI) throw new Error("Curve not found.");
    const c = launch.coder.accounts.decode("curve", cI.data);
    if (!c.creator.equals(wallet.publicKey)) throw new Error("Only the creator's wallet can claim.");
    const m = mI ? decodeMarket(perpsCoder, mI.data) : null;
    const v = feeView(feeInput(c, m), nowS()).streams.find((s) => s.key === stream);
    if (!v) throw new Error("This token has no perp market.");
    if (!v.canClaim) throw new Error("Nothing to claim yet.");
    let sig: string;
    if (stream === "sol") {
      sig = await launch.methods.claimCreatorFees().accountsPartial({ creator: wallet.publicKey, curve }).rpc();
    } else {
      if (!st.usdcMint) throw new Error("USDC mint not loaded yet. Try again in a moment.");
      const creatorUsdc = getAssociatedTokenAddressSync(st.usdcMint, wallet.publicKey);
      sig = await perps.methods.claimCreatorFees()
        .accountsPartial({ creator: wallet.publicKey, vault: VAULT, vaultUsdc: VAULT_USDC, market, creatorUsdc, tokenProgram: TOKEN_PROGRAM_ID, curve })
        .preInstructions([createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, creatorUsdc, wallet.publicKey, st.usdcMint)])
        .rpc();
    }
    log(`Claimed ${v.claimable} of creator fees from $${c.symbol}`, sig);
    await loadCurves();
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$("faucet").addEventListener("click", faucet);
$("launch").addEventListener("submit", launchToken);
$("buy").addEventListener("click", buy);
$("sell").addEventListener("click", sellAll);
$("open").addEventListener("click", openPosition);
$("pos").addEventListener("click", (e) => {
  const side = (e.target as HTMLElement).closest("[data-close]")?.getAttribute("data-close");
  if (side !== null && side !== undefined) guarded("Close", () => sponsoredOrder(Number(side), 1, 0, 0));
});
const onClaim = (e: Event) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-claim]");
  if (b) void claimFees(new PublicKey(b.dataset.mint!), b.dataset.claim as "sol" | "usdc");
};
$("feesBody").addEventListener("click", onClaim);
$("mine").addEventListener("click", (e) => {
  onClaim(e);
  const mint = (e.target as HTMLElement).closest("[data-pick]")?.getAttribute("data-pick");
  if (!mint) return;
  st.selected = new PublicKey(mint);
  st.hist = [];
  $("pos").innerHTML = "";
  renderMarkets();
  tick().catch(() => {});
});
$("markets").addEventListener("click", (e) => {
  const mint = (e.target as HTMLElement).closest("[data-mint]")?.getAttribute("data-mint");
  if (!mint) return;
  st.selected = new PublicKey(mint);
  st.hist = [];
  $("pos").innerHTML = "";
  renderMarkets();
  tick().catch(() => {});
});
const setMode = (m: "perp" | "spot") => {
  st.mode = m;
  $("mPerp").setAttribute("aria-pressed", String(m === "perp"));
  $("mSpot").setAttribute("aria-pressed", String(m === "spot"));
  ($("perpBox") as HTMLElement).hidden = m !== "perp";
  ($("spotBox") as HTMLElement).hidden = m !== "spot";
};
$("mPerp").addEventListener("click", () => setMode("perp"));
$("mSpot").addEventListener("click", () => setMode("spot"));
const setSide = (s: 0 | 1) => { st.side = s; $("sLong").setAttribute("aria-pressed", String(s === 0)); $("sShort").setAttribute("aria-pressed", String(s === 1)); render(); };
$("sLong").addEventListener("click", () => setSide(0));
$("sShort").addEventListener("click", () => setSide(1));
for (const id of ["col", "lev", "solIn"]) $(id).addEventListener("input", () => render());
new ResizeObserver(() => drawChart()).observe($("chart"));

async function loop() {
  let n = 0;
  for (;;) {
    try {
      if (n % 5 === 0) await loadCurves();
      await tick();
    } catch (e) {
      if (!/429/.test(String(e))) console.warn(e);
    }
    n++;
    await sleep(TICK_MS);
  }
}
log(`Devnet wallet ${short(wallet.publicKey)} and trading account ${short(trader.publicKey)} live in this browser only. Connect a wallet to sign with your own.`);
$("backup").addEventListener("click", backupTradingKey);
if (MAINNET) { ($("faucet") as HTMLElement).hidden = true; log("Mainnet: connect your wallet to launch or trade. Back up the trading key before depositing."); }
$("connect").addEventListener("click", () => void connectWallet().catch((e) => log(`Wallet: ${(e as Error).message}`)));
loop();

// ---------------------------------------------------------------------------
// Social layer: feed, leaderboard, profiles, copy trading. Signs with the connected
// wallet when there is one, else the local devnet key (never on mainnet).
// ---------------------------------------------------------------------------
const social = mountSocial($("social"), $("tabs"), {
  mainnet: MAINNET,
  /** Read-only creator-fee card on the token risk page. */
  async tokenExtra(mint) {
    const key = new PublicKey(mint);
    const [cI, mI] = await connection.getMultipleAccountsInfo([pda([enc("curve"), key.toBuffer()], launch.programId), marketPda(perps.programId, key)]);
    if (!cI) return null;
    const c = launch.coder.accounts.decode("curve", cI.data);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h3>Creator fees</h3><div class="fees" style="margin-top:8px">${feesHtml(c, mI ? decodeMarket(perpsCoder, mI.data) : null, false)}</div>`;
    return card;
  },
  explorer: (sig) => `https://explorer.solana.com/tx/${encodeURIComponent(sig)}${NET.cluster}`,
  signer: {
    address: () => wallet.publicKey.toBase58(),
    async signMessage(msg) {
      if (external) {
        const f = external.wallet.features["solana:signMessage"];
        if (!f) throw new Error(`${external.name} cannot sign messages. Try another wallet.`);
        const [{ signature }] = await f.signMessage({ account: external.account, message: msg });
        return signature as Uint8Array;
      }
      if (MAINNET) throw new Error("Connect a wallet first.");
      return ed25519.sign(msg, localWallet.secretKey.slice(0, 32));
    },
    async signTransaction(bytes) {
      const tx = VersionedTransaction.deserialize(bytes);
      return (await signerWallet.signTransaction(tx)).serialize();
    },
  },
}, (name) => { ($("trade") as HTMLElement).hidden = name !== "trade"; });
void social;
