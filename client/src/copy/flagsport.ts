/** FlagsPort backed by the indexer's store and flag functions (indexer/flags.ts). */
import { bundles, holderBalances, insiders, snipers, topHolderConcentration } from "../indexer/flags.js";
import type { Store } from "../indexer/store.js";
import type { FlagsPort, RiskFlag, TokenFacts } from "./ports.js";

export function indexerFlagsPort(store: Pick<Store, "mintTrades" | "launch" | "transfersToBuyers">): FlagsPort {
  return {
    async tokenFacts(mint: string, nowSec: number): Promise<TokenFacts> {
      const trades = store.mintTrades(mint);
      const launch = store.launch(mint);
      const creator = launch?.creator;
      const flags: RiskFlag[] = [];
      if (snipers(trades, launch?.slot, creator).length > 0) flags.push("sniper");
      if (bundles(trades).length > 0) flags.push("bundle");
      if (creator && insiders(creator, trades, store.transfersToBuyers(creator, mint)).length > 0) flags.push("insider");
      if (topHolderConcentration(holderBalances(trades)).flagged) flags.push("concentrated");
      let start = launch?.timestamp;
      if (start === undefined) for (const t of trades) if (start === undefined || t.timestamp < start) start = t.timestamp;
      return { flags, ageSec: start === undefined ? null : Math.max(0, nowSec - start) };
    },
  };
}
