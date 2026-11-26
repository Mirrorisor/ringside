/**
 * Keeps secrets out of service logs. RPC URLs carry API keys (Helius puts it in
 * the query string, other providers in the path), and library error messages can
 * echo a URL or a header, so every service routes stdout/stderr through this.
 *
 * Masks: the exact values of secret-looking environment variables (and the key
 * part of any URL among them), plus api-key/token style query parameters.
 */
const SECRET_ENV = /(KEY|SECRET|TOKEN|JWT|PASSWORD|PRIVATE|RPC_URL|REDIS_URL|WEBHOOK)/i;
const PARAM = /\b((?:api[-_]?key|apikey|access[-_]?token|token|key|secret|auth)=)[^&\s"'<>]+/gi;
const MIN_LEN = 8;

/** Secret strings to mask, longest first so a URL is masked before a substring of it. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!raw || !SECRET_ENV.test(name)) continue;
    const v = raw.trim();
    if (v.length < MIN_LEN || /^\d+$/.test(v) || v === "true" || v === "false") continue;
    out.add(v);
    // For URLs also mask the parts that tend to hold the key on their own.
    try {
      const u = new URL(v);
      for (const p of u.searchParams.values()) if (p.length >= MIN_LEN) out.add(p);
      for (const seg of u.pathname.split("/")) if (seg.length >= 16) out.add(seg);
      if (u.password.length >= MIN_LEN) out.add(u.password);
    } catch { /* not a URL */ }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let s = text;
  for (const v of secrets) if (s.includes(v)) s = s.split(v).join("<redacted>");
  return s.replace(PARAM, "$1<redacted>");
}

let installed = false;

/** Routes process.stdout/stderr (so console.* too) through redact(). Idempotent. */
export function installLogRedaction(env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  installed = true;
  const secrets = secretValues(env);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      // console.* writes strings. Binary chunks pass through untouched (they may be a
      // framed protocol, e.g. the test runner's), so log text must not be written as bytes.
      if (typeof chunk === "string") return write(redact(chunk, secrets), ...rest);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
