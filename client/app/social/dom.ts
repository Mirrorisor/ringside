// Tiny DOM builder. Text always goes through text nodes, never innerHTML, so API data cannot inject markup.
type Child = Node | string | number | null | undefined | false;
type Attrs = { class?: string; onclick?: (e: MouseEvent) => void; [k: string]: unknown };

export function h(tag: string, attrs: Attrs | null, ...kids: Child[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "onclick") e.addEventListener("click", v as EventListener);
    else if (k === "oninput") e.addEventListener("input", v as EventListener);
    else if (k === "onchange") e.addEventListener("change", v as EventListener);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
export const clear = (e: Element) => e.replaceChildren();

/** Avatar: only an https URL is ever rendered, and only as an image. */
export function avatar(url: unknown, size = 36): HTMLElement {
  if (typeof url === "string") {
    try {
      const u = new URL(url);
      if (u.protocol === "https:") {
        const img = h("img", { alt: "", width: size, height: size, referrerpolicy: "no-referrer", loading: "lazy", class: "av" }) as HTMLImageElement;
        img.src = u.href;
        return img;
      }
    } catch { /* not a URL */ }
  }
  return h("span", { class: "av", style: `width:${size}px;height:${size}px` });
}

export const shortAddr = (s: string) => (s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
export const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const sol = (lamports: number) => `${fmt(lamports / 1e9, lamports / 1e9 < 0.01 && lamports !== 0 ? 4 : 3)} SOL`;
export const signed = (n: number, d = 3) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n), d);
export const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
