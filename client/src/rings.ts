/**
 * Ringside privacy rails on Helius Solana Privacy Rings.
 *
 * Rings carry money in and out; trades themselves run on Ringside's public
 * programs from a fresh trading account. The flow:
 *
 *   identity wallet --shieldIn--> shielded balance --fundTradingAccount--> trading account
 *   trading account --(trade on ringside_perps)--> PnL --shieldOut--> shielded balance
 *
 * Built against @heliuslabs/spr 0.9.0-alpha. The SDK is alpha: names and
 * behaviour may change, so pin the version.
 */
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  type Signature,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  signTransactionWithSigners,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import {
  LocalKeys,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildMultiTransferTransaction,
  buildRegistrationTransaction,
  buildWithdrawalTransaction,
  createSprClient,
  syncWallet,
  type Bytes32,
} from "@heliuslabs/spr";
import { SignedTeePolicy } from "@heliuslabs/spr/client";

/** Mainnet USDC. */
export const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export type Network = "mainnet" | "devnet";

export interface RingsConfig {
  network: Network;
  heliusApiKey: string;
  /**
   * Photon indexer and prover. Leave both out to route them through the Helius
   * RPC's `/v1/spr` gateway, which authenticates with the same API key.
   */
  indexerUrl?: string;
  proverUrl?: string;
}

export type SprClient = Awaited<ReturnType<typeof createSprClient>>;

export async function connect(cfg: RingsConfig): Promise<SprClient> {
  const rpc =
    cfg.network === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`
      : `https://devnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`;
  return createSprClient({
    solanaRpcUrl: rpc,
    ...(cfg.indexerUrl ? { indexerUrl: cfg.indexerUrl } : {}),
    ...(cfg.proverUrl ? { proverUrl: cfg.proverUrl } : {}),
    // The key travels in the RPC URL; passing it again as apiKey is rejected by the SDK.
    proverTee: SignedTeePolicy.forNetwork(cfg.network),
  });
}

/** A user's shielded identity: the Ed25519 seed signs both Solana and Rings. */
export interface ShieldedUser {
  signer: KeyPairSigner;
  keypair: ShieldedKeypair;
  wallet: Wallet;
  keys: LocalKeys;
}

export async function loadShieldedUser(client: SprClient, ownerSeed: Bytes32): Promise<ShieldedUser> {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(ownerSeed);
  const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(ownerSeed));
  const wallet = new Wallet({ identity: keypair.shieldedAddress() });
  const keys = LocalKeys.fromKeypair(keypair, client.proofService);
  await syncWallet({ client, wallet, keys });
  return { signer, keypair, wallet, keys };
}

function submitter(client: SprClient) {
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc: client.solanaRpc,
    rpcSubscriptions: client.solanaRpcSubscriptions,
  } as Parameters<typeof sendAndConfirmTransactionFactory>[0]);
  return async (tx: Transaction, signers: KeyPairSigner[]): Promise<bigint> => {
    const signed = await signTransactionWithSigners(signers, tx);
    await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], { commitment: "confirmed" });
    return await client.confirmTransaction(getSignatureFromTransaction(signed));
  };
}

/** Where the Ringside relayer lives and which address it pays fees from (GET /v1/info). */
export interface RelayerEndpoint {
  url: string;
  address: Address;
}

export async function relayerInfo(url: string): Promise<RelayerEndpoint> {
  const r = await fetch(new URL("/v1/info", url));
  if (!r.ok) throw new Error(`Relayer info failed: ${r.status}`);
  const info = (await r.json()) as { relayer: string };
  return { url, address: address(info.relayer) };
}

/**
 * Signs `tx` (built with the relayer as fee payer) with the user's keys and
 * hands it to the relayer, which co-signs and submits. Returns the slot it
 * landed in. Use this for any sponsored transaction, including Ringside
 * request_order with the relayer as `payer`.
 */
export async function sponsorTransaction(
  client: SprClient,
  relayer: RelayerEndpoint,
  tx: Transaction,
  signers: KeyPairSigner[],
): Promise<bigint> {
  const signed = await partiallySignTransaction(signers.map((s) => s.keyPair), tx);
  const res = await fetch(new URL("/v1/sponsor", relayer.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: getBase64EncodedWireTransaction(signed) }),
  });
  const body = (await res.json()) as { signature?: string; code?: string; message?: string };
  if (!res.ok || !body.signature) throw new Error(`Relayer refused (${body.code ?? res.status}): ${body.message ?? ""}`);
  return await client.confirmTransaction(body.signature as Signature);
}

async function resync(client: SprClient, u: ShieldedUser, slot: bigint) {
  await syncWallet({ client, wallet: u.wallet, keys: u.keys, config: { requireSlot: slot } });
}

/** One-time: publish the user's shielded keys so others can pay them privately. */
export async function register(client: SprClient, u: ShieldedUser, sponsor?: KeyPairSigner) {
  const tx = await buildRegistrationTransaction({
    client,
    owner: u.signer.address,
    address: u.keypair.shieldedAddress(),
    payer: sponsor?.address,
  });
  if (tx === undefined) return; // already registered with these keys
  await submitter(client)(tx, sponsor ? [sponsor, u.signer] : [u.signer]);
}

/**
 * Step 1 (public): move USDC from the identity wallet into the shielded pool.
 * This is the only Ringside transaction the identity wallet ever signs.
 */
export async function shieldIn(client: SprClient, u: ShieldedUser, sourceUsdcAccount: Address, amount: bigint, asset: Address = USDC_MINT) {
  const tx = await buildDepositTransaction({
    client,
    feePayer: u.signer.address,
    recipient: u.keypair.shieldedAddress(),
    asset,
    splTokenAccount: sourceUsdcAccount,
    amount,
  });
  const slot = await submitter(client)(tx, [u.signer]);
  await resync(client, u, slot);
}

/**
 * Deterministic trading accounts, so a user can recover them from their seed.
 * Index n gives an unrelated-looking address for each session or market.
 */
export async function deriveTradingAccount(ownerSeed: Bytes32, index: number): Promise<KeyPairSigner> {
  const label = new TextEncoder().encode(`ringside/trading-account/v1/${index}`);
  const material = new Uint8Array(ownerSeed.length + label.length);
  material.set(ownerSeed, 0);
  material.set(label, ownerSeed.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return createKeyPairSignerFromPrivateKeyBytes(digest);
}

/**
 * Step 2: withdraw margin from the shielded balance straight into a fresh
 * trading account. Ringside's relayer pays the SOL fee, so the trading account
 * is never funded from a traceable wallet.
 */
export async function fundTradingAccount(
  client: SprClient,
  u: ShieldedUser,
  tradingAccount: Address,
  amount: bigint,
  relayer: RelayerEndpoint,
  asset: Address = USDC_MINT,
) {
  const tx = await buildWithdrawalTransaction({
    client,
    wallet: u.wallet,
    keys: u.keys,
    feePayer: relayer.address, // sponsored: owner co-signs, relayer pays
    recipient: tradingAccount,
    asset,
    amount,
  });
  const slot = await sponsorTransaction(client, relayer, tx, [u.signer]);
  await resync(client, u, slot);
}

/**
 * Step 4: after closing, move the trading account's USDC back into the
 * user's shielded balance. The deposit itself is public; what it hides is
 * where the money goes next. The relayer pays the fee, so the trading account
 * can be emptied to zero.
 */
export async function shieldOut(
  client: SprClient,
  u: ShieldedUser,
  tradingAccount: KeyPairSigner,
  tradingUsdcAccount: Address,
  amount: bigint,
  relayer: RelayerEndpoint,
  asset: Address = USDC_MINT,
) {
  const tx = await buildDepositTransaction({
    client,
    feePayer: relayer.address,
    depositor: tradingAccount.address,
    recipient: u.keypair.shieldedAddress(),
    asset,
    splTokenAccount: tradingUsdcAccount,
    amount,
  });
  const slot = await sponsorTransaction(client, relayer, tx, [tradingAccount]);
  await resync(client, u, slot);
}

/**
 * Creator and referral rewards: one private transfer to up to 15 registered
 * recipients, amounts hidden. Run from Ringside's treasury shielded wallet.
 */
export async function payRewardsPrivately(
  client: SprClient,
  treasury: ShieldedUser,
  payouts: { recipient: Address; amount: bigint }[],
) {
  for (let i = 0; i < payouts.length; i += 15) {
    const batch = payouts.slice(i, i + 15);
    const tx = await buildMultiTransferTransaction({
      client,
      wallet: treasury.wallet,
      keys: treasury.keys,
      feePayer: treasury.signer.address,
      asset: USDC_MINT,
      payments: batch,
    });
    const slot = await submitter(client)(tx, [treasury.signer]);
    await resync(client, treasury, slot);
  }
}

/**
 * Unlinkability is only as good as the crowd. A shield-in of 1,234.56 USDC
 * followed by a 1,234.56 withdrawal is trivially linked. This plans a
 * withdrawal as rounded, split chunks with random delays.
 */
export function planUnlinkableWithdrawal(
  amount: bigint,
  opts: { roundTo?: bigint; maxChunks?: number; minDelayMs?: number; maxDelayMs?: number } = {},
): { amount: bigint; delayMs: number }[] {
  const roundTo = opts.roundTo ?? 10_000_000n; // $10 in 6-dp USDC
  const maxChunks = opts.maxChunks ?? 3;
  const minDelay = opts.minDelayMs ?? 60_000;
  const maxDelay = opts.maxDelayMs ?? 15 * 60_000;
  const rounded = (amount / roundTo) * roundTo;
  if (rounded === 0n) return [];
  const units = Number(rounded / roundTo);
  const chunks = Math.max(1, Math.min(maxChunks, units));
  const plan: { amount: bigint; delayMs: number }[] = [];
  let left = units;
  for (let i = 0; i < chunks; i++) {
    const take = i === chunks - 1 ? left : Math.max(1, Math.floor((left / (chunks - i)) * (0.6 + Math.random() * 0.8)));
    left -= take;
    plan.push({ amount: BigInt(take) * roundTo, delayMs: minDelay + Math.floor(Math.random() * (maxDelay - minDelay)) });
  }
  return plan;
}
