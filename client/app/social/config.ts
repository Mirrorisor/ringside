import { resolveBase } from "../../src/appcheck";
import { parseFeeAccounts } from "../../src/trade/jupiter";

// Base URLs of the social-layer services. Production builds always use same-origin paths.
// Dev builds (import.meta.env.DEV) accept a query override (?indexer=, ?social=, ?sponsor=, ?copy=, ?relayer=, ...)
// only for origins on a build-time allowlist: env VITE_ALLOWED_BACKENDS (comma-separated origins),
// plus this page's origin and localhost. A link can never point a production app at another backend.
const meta = import.meta as unknown as { env: { DEV?: boolean; VITE_ALLOWED_BACKENDS?: string; VITE_FEE_WALLET?: string; VITE_JUPITER_FEE_ACCOUNTS?: string; VITE_SPONSOR_ADDRESS?: string } };
const params = new URLSearchParams(location.search);

export const backendBase = (param: string, path: string): string =>
  resolveBase(params.get(param), `${location.origin}${path}`, { dev: meta.env.DEV === true, allowedCsv: meta.env.VITE_ALLOWED_BACKENDS, pageOrigin: location.origin });

/** The query override for `param`, or null (always null outside dev builds or off the allowlist). */
export const devOverride = (param: string): string | null => {
  const v = resolveBase(params.get(param), "", { dev: meta.env.DEV === true, allowedCsv: meta.env.VITE_ALLOWED_BACKENDS, pageOrigin: location.origin });
  return v || null;
};

export const INDEXER = backendBase("indexer", "/indexer");
export const SOCIAL = backendBase("social", "/social");
export const SPONSOR = backendBase("sponsor", "/sponsor");
export const COPY = backendBase("copy", "/copy");
/** Ringside fee wallet: the only recipient a copy transaction may pay from the user's SOL. */
export const FEE_WALLET = meta.env.VITE_FEE_WALLET ?? "";
/** Our Jupiter fee token accounts (VITE_JUPITER_FEE_ACCOUNTS, same format as the copy service's JUPITER_FEE_ACCOUNTS); the only accounts a swap's platform fee may go to. Empty: not checked. */
export const JUPITER_FEE_ACCOUNTS: string[] = Object.values(parseFeeAccounts(meta.env.VITE_JUPITER_FEE_ACCOUNTS));
/** Expected gas sponsor (fee payer). When unset, the sponsor's own /health is asked. */
export const SPONSOR_ADDRESS = meta.env.VITE_SPONSOR_ADDRESS ?? "";
