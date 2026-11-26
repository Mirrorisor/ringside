// Base URLs of the social-layer services. Each can be overridden by query param
// (?indexer=, ?social=, ?sponsor=, ?copy=), like ?relayer=; defaults are the Vite dev proxies.
const params = new URLSearchParams(location.search);
export const INDEXER = params.get("indexer") ?? `${location.origin}/indexer`;
export const SOCIAL = params.get("social") ?? `${location.origin}/social`;
export const SPONSOR = params.get("sponsor") ?? `${location.origin}/sponsor`;
export const COPY = params.get("copy") ?? `${location.origin}/copy`;
