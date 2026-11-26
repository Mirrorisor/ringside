/**
 * Which Solana cluster an RPC really serves, from its genesis hash. A URL says
 * little (custom and pooled RPC hosts rarely contain "mainnet"), so devnet-only
 * shortcuts and mainnet safeguards key off this instead, and fail closed.
 */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export type Cluster = "mainnet" | "devnet" | "unknown";

export function clusterOf(genesisHash: string | undefined): Cluster {
  if (genesisHash === MAINNET_GENESIS_HASH) return "mainnet";
  if (genesisHash === DEVNET_GENESIS_HASH) return "devnet";
  return "unknown";
}

/** Looks up the cluster; a failed lookup is "unknown", never devnet. */
export async function detectCluster(getGenesisHash: () => Promise<string>): Promise<Cluster> {
  try {
    return clusterOf(await getGenesisHash());
  } catch {
    return "unknown";
  }
}

/**
 * The network a service should behave as. The RPC's own cluster wins; a declared
 * NETWORK that contradicts it is an error. When the cluster can't be identified
 * (lookup failed, local validator), the declared value is used, defaulting to
 * mainnet so its safeguards stay on.
 */
export function resolveNetwork(declared: string | undefined, detected: Cluster): { network: "mainnet" | "devnet"; error?: string; warning?: string } {
  const d = declared?.trim().toLowerCase() || undefined;
  if (d !== undefined && d !== "mainnet" && d !== "devnet") {
    return { network: "mainnet", error: `NETWORK must be "mainnet" or "devnet", not "${declared}"` };
  }
  if (detected !== "unknown") {
    if (d !== undefined && d !== detected) {
      return { network: detected, error: `NETWORK=${d} but the RPC serves ${detected}` };
    }
    return { network: detected };
  }
  if (d === undefined) {
    return { network: "mainnet", warning: "could not identify the RPC's cluster and NETWORK is unset: applying mainnet safeguards" };
  }
  return { network: d, warning: `could not identify the RPC's cluster: using NETWORK=${d}` };
}
