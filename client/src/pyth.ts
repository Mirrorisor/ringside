/**
 * Keeps the perps vault's SOL/USD fresh from Pyth.
 *
 * `refresh_sol_price` accepts any fully verified SOL/USD PriceUpdateV2 owned by
 * the Pyth receiver. If the sponsored feed account is fresh we just point at
 * it; otherwise (devnet's sponsored feed updates in bursts) we post our own
 * fully verified update from Hermes and consume it in the same bundle. The
 * update accounts are closed afterwards, so the rent comes back.
 *
 * Hermes needs a Pyth API key since Aug 2026 (PYTH_API_KEY). Without one, on
 * devnet only, a stale sponsored account's last price is pushed through the
 * price authority instead ("fallback"), so devnet keeps a real Pyth number.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import type { PythSolanaReceiver as Receiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";
import { Wallet } from "@coral-xyz/anchor";
import { createRequire } from "node:module";

// Pyth's ESM build imports jito-ts without file extensions, which Node's ESM
// loader rejects; the CommonJS build works.
const { PythSolanaReceiver } = createRequire(import.meta.url)("@pythnetwork/pyth-solana-receiver") as {
  PythSolanaReceiver: typeof Receiver;
};
import { createHash } from "node:crypto";

export const SOL_USD_FEED_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const SPONSORED_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
/** Must stay under the program's 60 s limit, with room for the transaction to land. */
const FRESH_ENOUGH_S = 30;

/**
 * Compute units for refresh_sol_price. Required: with tightComputeBudget the
 * Pyth SDK sets the limit to the sum of declared units, so an undeclared
 * instruction gets a budget of 0 ("consumed 0 of 0 compute units").
 */
const REFRESH_CU = 40_000;
const refreshDisc = createHash("sha256").update("global:refresh_sol_price").digest().subarray(0, 8);
const setPriceDisc = createHash("sha256").update("global:set_sol_price").digest().subarray(0, 8);

/** publish_time of a PriceUpdateV2 (Full verification layout), or 0. */
export function publishTime(data: Buffer): number {
  if (data.length < 101 || data[40] !== 1) return 0;
  return Number(data.readBigInt64LE(93));
}

export class PythPoster {
  private receiver: Receiver;
  private apiKey = process.env.PYTH_API_KEY || "";
  private hermes = new HermesClient(process.env.HERMES_URL ?? "https://hermes.pyth.network", this.apiKey ? { accessToken: this.apiKey } : {});
  private devnet = (process.env.NETWORK ?? "devnet") !== "mainnet";

  constructor(private connection: Connection, private payer: Keypair, private perpsProgram: PublicKey, private vault: PublicKey) {
    const wallet = new Wallet(payer);
    this.receiver = new PythSolanaReceiver({ connection, wallet: wallet as never });
  }

  private refreshIx(priceUpdate: PublicKey) {
    return new TransactionInstruction({
      programId: this.perpsProgram,
      keys: [
        { pubkey: this.vault, isSigner: false, isWritable: true },
        { pubkey: priceUpdate, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(refreshDisc),
    });
  }

  /** Devnet without a Pyth key: push the sponsored account's last price as price authority. */
  private async fallback(data: Buffer) {
    const price = data.readBigInt64LE(73), expo = data.readInt32LE(89);
    const e6 = expo + 6 >= 0 ? price * 10n ** BigInt(expo + 6) : price / 10n ** BigInt(-(expo + 6));
    const ix = new TransactionInstruction({
      programId: this.perpsProgram,
      keys: [
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.vault, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([Buffer.from(setPriceDisc), Buffer.from(new BigUint64Array([e6]).buffer)]),
    });
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [this.payer], { commitment: "confirmed" });
  }

  /** Returns where the price came from. */
  async refresh(): Promise<"sponsored" | "posted" | "fallback"> {
    const sponsored = await this.connection.getAccountInfo(SPONSORED_SOL_USD, "confirmed");
    const age = sponsored ? Date.now() / 1000 - publishTime(sponsored.data) : Infinity;
    if (age > FRESH_ENOUGH_S && !this.apiKey) {
      if (!this.devnet || !sponsored) throw new Error("sponsored Pyth feed is stale and PYTH_API_KEY is not set");
      await this.fallback(sponsored.data);
      return "fallback";
    }
    const builder = this.receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    let source: "sponsored" | "posted";
    if (age <= FRESH_ENOUGH_S) {
      await builder.addPriceConsumerInstructions(async () => [{ instruction: this.refreshIx(SPONSORED_SOL_USD), signers: [], computeUnits: REFRESH_CU }]);
      source = "sponsored";
    } else {
      const update = await this.hermes.getLatestPriceUpdates([SOL_USD_FEED_ID], { encoding: "base64" });
      await builder.addPostPriceUpdates(update.binary.data);
      await builder.addPriceConsumerInstructions(async (get: (id: string) => PublicKey) => [{ instruction: this.refreshIx(get(SOL_USD_FEED_ID)), signers: [], computeUnits: REFRESH_CU }]);
      source = "posted";
    }
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 10_000, tightComputeBudget: true });
    await this.receiver.provider.sendAll(txs, { skipPreflight: false, commitment: "confirmed" });
    return source;
  }
}
