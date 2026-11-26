import { ApiError, copy, indexer, social, sponsorSend, streamNotifications } from "./api";
import { b64, getToken, signIn, signedIn, unb64, type Signer } from "./auth";
import { ago, avatar, clear, fmt, h, shortAddr, sol, signed } from "./dom";
import { AppCheckError, checkBuiltTransaction, describeBuilt, type BuiltView } from "../../src/appcheck";
import { FEE_WALLET, JUPITER_FEE_ACCOUNTS, SPONSOR, SPONSOR_ADDRESS } from "./config";
import type { CopyIntent, CopySettings, LeaderRow, RiskFlag, TokenFlags, Trade, Window } from "./types";

export interface Env { signer: Signer; mainnet: boolean; explorer: (sig: string) => string }

type View =
  | { t: "feed" } | { t: "leaders" } | { t: "inbox" }
  | { t: "wallet"; addr: string } | { t: "token"; mint: string } | { t: "settings"; addr: string };

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error)?.message ?? "Something went wrong.");
const isAddr = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export function mountSocial(root: HTMLElement, tabs: HTMLElement, env: Env, onTab: (name: string) => void) {
  let view: View = { t: "feed" };
  let timer: number | undefined;
  let pendingCount = 0;
  let renderId = 0;
  const badge = h("b", { class: "badge", hidden: true });

  const tabDefs: [string, string][] = [["trade", "Trade"], ["feed", "Feed"], ["leaders", "Leaders"], ["inbox", "Copy"]];
  for (const [id, label] of tabDefs) {
    tabs.append(h("button", { "data-tab": id, "aria-pressed": "false", onclick: () => go(id === "trade" ? null : ({ t: id } as View)) }, label, id === "inbox" ? badge : null));
  }
  function markTab(name: string) {
    for (const b of Array.from(tabs.children)) b.setAttribute("aria-pressed", String(b.getAttribute("data-tab") === name));
  }
  function go(v: View | null) {
    window.clearTimeout(timer);
    if (!v) { root.hidden = true; onTab("trade"); markTab("trade"); return; }
    view = v; root.hidden = false; onTab("social");
    markTab(v.t === "feed" || v.t === "leaders" || v.t === "inbox" ? v.t : "");
    void render();
  }

  // ---- helpers ----------------------------------------------------------------
  const walletLink = (a: string) => h("button", { class: "lnk", onclick: () => go({ t: "wallet", addr: a }) }, shortAddr(a));
  const mintLink = (m: string) => h("button", { class: "lnk", onclick: () => go({ t: "token", mint: m }) }, shortAddr(m));
  const note = (text: string, cls = "muted") => h("p", { class: cls, role: cls === "err" ? "alert" : undefined }, text);
  const heading = (title: string, back?: View) =>
    h("div", { class: "sh" }, back ? h("button", { class: "back", "aria-label": "Back", onclick: () => go(back) }, "‹") : null, h("h2", null, title));

  /** Shows a sign-in prompt unless the active wallet already has a session. Returns true when signed in. */
  function needAuth(box: HTMLElement, again: () => void): boolean {
    if (signedIn(env.signer)) return true;
    const msg = h("p", { class: "muted" }, "Sign in with your wallet to follow traders and copy trades. It is a free signature; no transaction is sent.");
    const out = h("p", { class: "err", role: "alert" });
    const btn = h("button", { class: "primary", onclick: async () => {
      (btn as HTMLButtonElement).disabled = true; out.textContent = "";
      try { await signIn(env.signer); again(); } catch (e) { out.textContent = errMsg(e); (btn as HTMLButtonElement).disabled = false; }
    } }, `Sign in as ${shortAddr(env.signer.address())}`);
    box.append(h("div", { class: "card" }, msg, btn, out));
    return false;
  }

  async function render() {
    window.clearTimeout(timer);
    const id = ++renderId;
    clear(root);
    const box = h("div", { class: "pane" });
    root.append(box);
    const live = () => id === renderId && document.body.contains(box);
    const guard = (p: Promise<void>) => p.catch((e) => { if (live()) box.append(note(errMsg(e), "err")); });
    switch (view.t) {
      case "feed": return guard(feedView(box, live));
      case "leaders": return guard(leadersView(box, live));
      case "inbox": return guard(inboxView(box, live));
      case "wallet": return guard(walletView(box, view.addr, live));
      case "token": return guard(tokenView(box, view.mint, live));
      case "settings": return guard(settingsView(box, view.addr, live));
    }
  }
  const refresh = () => { if (!root.hidden) void render(); };

  // ---- Feed -------------------------------------------------------------------
  function tradeRow(t: Trade) {
    const buy = t.side === "buy";
    return h("div", { class: "row" },
      h("div", null,
        h("div", null, walletLink(t.wallet), " ", h("b", { class: buy ? "up" : "down" }, buy ? "bought" : "sold"), " ", mintLink(t.mint)),
        h("div", { class: "muted" }, `${fmt(t.tokenAmount, 0)} tokens for ${fmt(t.quoteAmount, 3)} ${t.quote} · ${ago(t.timestamp)}`)));
  }
  async function feedView(box: HTMLElement, live: () => boolean) {
    box.append(heading("Feed"));
    if (!needAuth(box, refresh)) return;
    const follows = await social.follows();
    if (!live()) return;
    if (!follows.length) return void box.append(note("You are not following anyone yet. Pick traders from the Leaders tab."));
    const list = h("div", { class: "card list2" });
    box.append(h("p", { class: "muted" }, `Following ${follows.length} trader${follows.length === 1 ? "" : "s"} · updates live`), list);
    const load = async () => {
      try {
        const trades = await indexer.feed(follows.slice(0, 50));
        if (!live()) return;
        clear(list);
        if (!trades.length) list.append(note("No recent trades from the traders you follow."));
        for (const t of trades) list.append(tradeRow(t));
      } catch (e) { if (live()) { clear(list); list.append(note(errMsg(e), "err")); } }
      if (live()) timer = window.setTimeout(load, 10_000);
    };
    await load();
  }

  // ---- Leaderboard ------------------------------------------------------------
  let lbWindow: Window = "7d";
  async function leadersView(box: HTMLElement, live: () => boolean) {
    box.append(heading("Leaderboard"));
    const seg = h("div", { class: "seg3", role: "group", "aria-label": "Window" },
      ...(["24h", "7d", "30d"] as Window[]).map((w) => h("button", { "aria-pressed": String(w === lbWindow), onclick: () => { lbWindow = w; refresh(); } }, w)));
    box.append(seg);
    const rows: LeaderRow[] = await indexer.leaderboard(lbWindow);
    if (!live()) return;
    if (!rows.length) return void box.append(note("No ranked traders in this window yet."));
    const card = h("div", { class: "card list2" });
    for (const r of rows) {
      const pnl = r.realisedPnl?.SOL ?? 0;
      card.append(h("div", { class: "row" },
        h("b", { class: "rank" }, String(r.rank)),
        h("div", { class: "grow" }, walletLink(r.wallet), h("div", { class: "muted" }, `${r.trades} trades · win ${r.winRate === null ? "–" : Math.round(r.winRate * 100) + "%"}`)),
        h("b", { class: pnl >= 0 ? "up" : "down" }, `${signed(pnl)} SOL`)));
    }
    box.append(card, note("Realised PnL in SOL over the window, ranked by the indexer. Past results do not predict future ones."));
  }

  // ---- Wallet profile ---------------------------------------------------------
  async function walletView(box: HTMLElement, addr: string, live: () => boolean) {
    box.append(heading(shortAddr(addr), { t: "leaders" }));
    if (!isAddr(addr)) return void box.append(note("Not a valid wallet address.", "err"));
    const [stats, user, follows] = await Promise.all([
      indexer.wallet(addr),
      signedIn(env.signer) ? social.user(addr).catch(() => ({} as Record<string, unknown>)) : Promise.resolve({} as Record<string, unknown>),
      signedIn(env.signer) ? social.follows().catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]);
    if (!live()) return;
    const name = typeof user.displayName === "string" ? user.displayName : typeof user.name === "string" ? user.name : "";
    const bio = typeof user.bio === "string" ? user.bio : "";
    box.append(h("div", { class: "card prof" }, avatar(user.avatarUrl ?? user.avatar, 56),
      h("div", null, h("h3", null, name || shortAddr(addr)), h("div", { class: "muted" }, addr), bio ? h("p", null, bio) : null)));

    let following = follows.includes(addr);
    const own = addr === env.signer.address();
    if (!own) {
      const out = h("p", { class: "err", role: "alert" });
      const fbtn = h("button", { class: following ? "" : "primary", onclick: async () => {
        if (!signedIn(env.signer)) { try { await signIn(env.signer); return refresh(); } catch (e) { out.textContent = errMsg(e); return; } }
        (fbtn as HTMLButtonElement).disabled = true; out.textContent = "";
        try { following ? await social.unfollow(addr) : await social.follow(addr); following = !following; fbtn.textContent = following ? "Following" : "Follow"; fbtn.className = following ? "" : "primary"; }
        catch (e) { out.textContent = errMsg(e); }
        (fbtn as HTMLButtonElement).disabled = false;
      } }, following ? "Following" : signedIn(env.signer) ? "Follow" : "Sign in to follow");
      box.append(h("div", { class: "two" }, fbtn, h("button", { onclick: () => go({ t: "settings", addr }) }, "Copy settings")), out);
    }

    const stat = (label: string, w: Window) => {
      const s = stats.windows?.[w];
      return h("div", { class: "stat" }, h("span", { class: "muted" }, label),
        h("b", { class: (s?.realisedPnl?.SOL ?? 0) >= 0 ? "up" : "down" }, s ? `${signed(s.realisedPnl.SOL)} SOL` : "–"),
        h("span", { class: "muted" }, s ? `${s.trades} trades · win ${s.winRate === null ? "–" : Math.round(s.winRate * 100) + "%"}` : ""));
    };
    box.append(h("div", { class: "card stats3" }, stat("24h", "24h"), stat("7d", "7d"), stat("30d", "30d")));
    const pos = h("div", { class: "card list2" }, h("h3", null, "Open positions"));
    if (!stats.openPositions?.length) pos.append(note("No open positions."));
    for (const p of stats.openPositions ?? []) {
      pos.append(h("div", { class: "row" }, h("div", { class: "grow" }, mintLink(p.mint), h("div", { class: "muted" }, `${fmt(p.tokenAmount, 0)} tokens`)),
        h("div", { class: "n" }, `${fmt(p.costBasis, 3)} ${p.quote}`, h("div", { class: "muted" }, "cost basis"))));
    }
    box.append(pos);
    if (stats.lastTradeAt) box.append(note(`Last trade ${ago(stats.lastTradeAt)}.`));
  }

  // ---- Token panel ------------------------------------------------------------
  const FLAG_TEXT: Record<RiskFlag, { title: string; why: string }> = {
    sniper: { title: "Snipers", why: "Wallets that bought within a second or two of launch, before most people could even see the token. They often sell into later buyers." },
    bundle: { title: "Bundled buys", why: "Several wallets bought in the very same moment, which usually means one person controls them all and is making the token look more popular than it is." },
    insider: { title: "Insider funding", why: "Wallets that were funded by the token's creator and then bought it. The creator may be buying their own token through disguised wallets." },
    concentrated: { title: "Concentrated holders", why: "A few wallets hold a large share of the supply. If one of them sells, the price can fall hard." },
  };
  const flagRow = (flag: RiskFlag, hit: boolean, detail: string) =>
    h("div", { class: `flag ${hit ? "hit" : "ok"}` },
      h("div", null, h("b", null, FLAG_TEXT[flag].title), " ", h("span", { class: "tag" }, hit ? "Warning" : "Clear")),
      h("div", null, hit ? detail : "Nothing found in the trades we have indexed."),
      hit ? h("div", { class: "muted" }, FLAG_TEXT[flag].why) : null);
  async function tokenView(box: HTMLElement, mint: string, live: () => boolean) {
    box.append(heading("Token risk", { t: "feed" }));
    if (!isAddr(mint)) return void box.append(note("Not a valid token address.", "err"));
    const f: TokenFlags = await indexer.flags(mint);
    if (!live()) return;
    box.append(h("div", { class: "card" }, h("div", { class: "muted" }, mint), h("p", { class: "muted" }, `Based on ${f.trades} indexed trades. Flags are warnings, not proof; a clear result does not make a token safe.`)));
    const nS = f.snipers?.length ?? 0, nB = f.bundles?.length ?? 0, nI = f.insiders?.length ?? 0;
    box.append(h("div", { class: "card flags" },
      flagRow("sniper", nS > 0, `${nS} wallet${nS === 1 ? "" : "s"} sniped this token.`),
      flagRow("bundle", nB > 0, `${nB} bundle${nB === 1 ? "" : "s"} detected (${(f.bundles ?? []).reduce((a, b) => a + b.wallets.length, 0)} wallets).`),
      f.insiders === null ? h("div", { class: "flag" }, h("b", null, "Insider funding"), h("div", { class: "muted" }, "Not checked: the token's creator is not known to the indexer.")) : flagRow("insider", nI > 0, `${nI} buyer${nI === 1 ? " was" : "s were"} funded by the creator.`),
      flagRow("concentrated", !!f.concentration?.flagged, `The top 10 holders own about ${Math.round((f.concentration?.topShare ?? 0) * 100)}% of the indexed supply.`)));
  }

  // ---- Copy settings ----------------------------------------------------------
  const ALL_FLAGS: RiskFlag[] = ["sniper", "bundle", "insider", "concentrated"];
  const defaults = (leader: string): CopySettings => ({
    follower: env.signer.address(), leader, enabled: true, mode: "fixed", fixedLamports: 50_000_000, ratioBps: 1000,
    maxPerTradeLamports: 50_000_000, dailyCapLamports: 200_000_000, slippageBps: 300, copySells: true, copyPerps: false,
    maxLeverage: 1, skipFlags: [...ALL_FLAGS], minTokenAgeSec: 300,
  });
  async function settingsView(box: HTMLElement, leader: string, live: () => boolean) {
    box.append(heading("Copy settings", { t: "wallet", addr: leader }));
    if (!isAddr(leader)) return void box.append(note("Not a valid wallet address.", "err"));
    if (!needAuth(box, refresh)) return;
    const saved = await social.getCopy(leader);
    if (!live()) return;
    const s: CopySettings = saved ?? defaults(leader);
    box.append(note(`Copying ${shortAddr(leader)}. ${saved ? "Editing your saved settings." : "Defaults are conservative; nothing is copied until you save."}`));

    const num = (id: string, label: string, val: number, step = "any", help = "") => {
      const input = h("input", { id, class: "num", type: "number", inputmode: "decimal", min: "0", step, value: String(val) }) as HTMLInputElement;
      return { input, el: h("div", { class: "f" }, h("label", { for: id }, label), input, help ? h("div", { class: "muted" }, help) : null) };
    };
    const check = (id: string, label: string, on: boolean) => {
      const input = h("input", { id, type: "checkbox", checked: on }) as HTMLInputElement;
      return { input, el: h("label", { class: "chk", for: id }, input, label) };
    };
    const enabled = check("cEn", "Copying enabled", s.enabled);
    const mode = h("select", { id: "cMode" }, h("option", { value: "fixed" }, "Fixed amount per trade"), h("option", { value: "ratio" }, "Match a share of their trade size")) as HTMLSelectElement;
    mode.value = s.mode;
    const fixed = num("cFixed", "Amount per trade (SOL)", s.fixedLamports / 1e9);
    const ratio = num("cRatio", "Share of their trade (%)", s.ratioBps / 100, "any", "10 means you copy a tenth of what they trade.");
    const maxT = num("cMax", "Max per trade (SOL)", s.maxPerTradeLamports / 1e9);
    const daily = num("cDay", "Daily cap (SOL)", s.dailyCapLamports / 1e9, "any", "The most copying can spend in one day.");
    const slip = num("cSlip", "Max slippage (%)", s.slippageBps / 100, "any", "Trades that would fill worse than this are refused.");
    const age = num("cAge", "Skip tokens younger than (minutes)", s.minTokenAgeSec / 60);
    const sells = check("cSells", "Also copy their sells", s.copySells);
    const flagChecks = ALL_FLAGS.map((fl) => ({ fl, ...check(`cF${fl}`, `Skip tokens flagged: ${FLAG_TEXT[fl].title.toLowerCase()}`, s.skipFlags.includes(fl)) }));
    const perps = check("cPerp", "Copy perps (experimental, devnet only)", s.copyPerps && !env.mainnet);
    perps.input.disabled = env.mainnet;
    const lev = num("cLev", "Max leverage (x)", s.maxLeverage, "0.1", "Trades above this are skipped.");
    const warn = h("div", { class: "warn", role: "note" }, h("b", null, "Experimental, devnet only. "), "Copying leveraged perps can lose more than copying spot trades, and you can be liquidated quickly. Perps copying works on devnet test funds only and is unavailable on mainnet.");
    const sync = () => {
      const r = mode.value === "ratio";
      fixed.el.hidden = r; ratio.el.hidden = !r;
      lev.el.hidden = !perps.input.checked; warn.hidden = false;
    };
    mode.addEventListener("change", sync); perps.input.addEventListener("change", sync); sync();

    const out = h("p", { role: "alert" });
    const save = h("button", { class: "primary", style: "width:100%", onclick: async () => {
      out.className = "err"; out.textContent = "";
      const L = (x: number) => Math.round(x * 1e9);
      const v = {
        fixed: L(Number(fixed.input.value)), ratio: Math.round(Number(ratio.input.value) * 100), max: L(Number(maxT.input.value)),
        day: L(Number(daily.input.value)), slip: Math.round(Number(slip.input.value) * 100), age: Math.round(Number(age.input.value) * 60), lev: Number(lev.input.value),
      };
      if (Object.values(v).some((x) => !Number.isFinite(x) || x < 0)) { out.textContent = "Enter valid, non-negative numbers."; return; }
      if (v.slip > 5000 || v.ratio > 10_000) { out.textContent = "Slippage must be at most 50% and the share at most 100%."; return; }
      if (v.max > v.day) { out.textContent = "Max per trade cannot exceed the daily cap."; return; }
      if (perps.input.checked && (v.lev < 1 || v.lev > 10)) { out.textContent = "Max leverage must be between 1 and 10."; return; }
      const body: CopySettings = {
        follower: env.signer.address(), leader, enabled: enabled.input.checked, mode: mode.value as "fixed" | "ratio",
        fixedLamports: v.fixed, ratioBps: v.ratio, maxPerTradeLamports: v.max, dailyCapLamports: v.day, slippageBps: v.slip,
        copySells: sells.input.checked, copyPerps: perps.input.checked && !env.mainnet, maxLeverage: perps.input.checked ? v.lev : 1,
        skipFlags: flagChecks.filter((c) => c.input.checked).map((c) => c.fl), minTokenAgeSec: v.age,
      };
      (save as HTMLButtonElement).disabled = true;
      try { await social.putCopy(leader, body); out.className = "up"; out.textContent = "Saved."; } catch (e) { out.textContent = errMsg(e); }
      (save as HTMLButtonElement).disabled = false;
    } }, "Save copy settings");

    box.append(h("div", { class: "card form" }, enabled.el, h("div", { class: "f" }, h("label", { for: "cMode" }, "Sizing"), mode), fixed.el, ratio.el, maxT.el, daily.el, slip.el, age.el, sells.el,
      h("h3", null, "Skip risky tokens"), ...flagChecks.map((c) => c.el),
      h("h3", null, "Perps"), warn, perps.el, lev.el, save, out));
  }

  // ---- Copy inbox -------------------------------------------------------------
  const SIDE_TEXT: Record<CopyIntent["side"], string> = { buy: "Buy", sell: "Sell", long: "Long", short: "Short", close: "Close" };
  const VENUE_TEXT: Record<CopyIntent["venue"], string> = { jupiter: "Jupiter", pumpfun: "Pump.fun", meteora: "Meteora", "ringside-perps": "Ringside perps (devnet)" };
  const amountText = (i: CopyIntent) => [
    // For a sell, intent.lamports is the leader's trade size, not what you will receive; proceeds come from the build.
    i.lamports !== undefined && i.side !== "sell" ? sol(i.lamports) : null,
    i.tokens !== undefined ? `${i.tokens} tokens (base units)` : null,
    i.leverage !== undefined ? `${i.leverage}x leverage` : null,
  ].filter(Boolean).join(" · ") || "amount set when built";
  const refusalOf = (d: Record<string, unknown> | null) => {
    const r = d && (d.refusal ?? d.refused ?? d.skipReason ?? d.reason);
    return typeof r === "string" ? r : null;
  };

  async function inboxView(box: HTMLElement, live: () => boolean) {
    box.append(heading("Copy inbox"));
    if (!needAuth(box, refresh)) return;
    const intents = (await copy.pending()).filter((i) => i.status === "pending");
    if (!live()) return;
    pendingCount = intents.length; updateBadge();
    if (!intents.length) return void box.append(note("Nothing to copy right now. New trades from traders you copy will show up here."));
    box.append(note("Each copy expires quickly. You always review the exact amount before signing."));
    const cards = intents.map((i) => intentCard(i, live));
    box.append(...cards.map((c) => c.el));
    const tick = () => {
      if (!live()) return;
      for (const c of cards) c.tick();
      timer = window.setTimeout(tick, 1000);
    };
    tick();
  }

  function intentCard(i: CopyIntent, live: () => boolean) {
    const count = h("b", { class: "cd" });
    const body = h("div", { class: "ibody" });
    const out = h("p", { role: "alert", class: "muted" });
    const buyish = i.side === "buy" || i.side === "long";
    const copyBtn = h("button", { class: buyish ? "long" : "short", style: "width:100%" }, `Copy ${SIDE_TEXT[i.side].toLowerCase()}`) as HTMLButtonElement;
    let expired = false;
    const lines = (view: BuiltView | null) => [
      h("div", { class: "rows2" }, h("div", null, h("span", null, "Action"), h("b", null, `${SIDE_TEXT[i.side]} ${i.kind === "perp" ? "perp" : "spot"}`)),
        h("div", null, h("span", null, "Token"), mintLink(i.mint)),
        h("div", null, h("span", null, "Requested"), h("b", null, amountText(i))),
        ...(view ? reviewRows(view) : [h("div", null, h("span", null, "Venue"), h("b", null, VENUE_TEXT[i.venue] ?? "Unknown venue")), h("div", null, h("span", null, "Fee"), h("b", null, "Shown after the transaction is built."))]),
        h("div", null, h("span", null, "Copying"), walletLink(i.leader))),
    ];
    const unk = (v: string | null) => v ?? "unknown";
    // What will be signed, from the build response and the decoded transaction (never the leader's cost basis).
    const reviewRows = (v: BuiltView) => {
      const sell = i.side === "sell";
      const out = (x: bigint | null) => (x === null ? "unknown" : sell ? sol(Number(x)) : `${x} tokens (base units)`);
      return [
        h("div", null, h("span", null, "Venue (in the transaction)"), h("b", null, VENUE_TEXT[i.venue] ?? unk(v.venue))),
        h("div", null, h("span", null, sell ? "Expected proceeds" : "Expected output"), h("b", null, out(v.expectedOut))),
        h("div", null, h("span", null, "Minimum after slippage"), h("b", null, out(v.minOut))),
        h("div", null, h("span", null, "Ringside fee"), h("b", null, v.feeLamports === null ? "unknown" : `${sol(v.feeLamports)}. Network fee is paid by the sponsor.`)),
      ];
    };
    const setBusy = (b: boolean) => { copyBtn.disabled = b || expired; };
    const show = (view: BuiltView | null) => { clear(body); body.append(...lines(view)); };
    show(null);
    if (i.kind === "perp") body.append(h("div", { class: "warn" }, "Experimental devnet perp. Leverage can lose more than spot."));

    let sponsorAddr = SPONSOR_ADDRESS;
    async function expectedSponsor(): Promise<string | null> {
      if (sponsorAddr) return sponsorAddr;
      try {
        const r = await fetch(`${SPONSOR}/health`, { signal: AbortSignal.timeout(10_000) });
        const d = (await r.json()) as { feePayer?: unknown };
        if (typeof d.feePayer === "string" && isAddr(d.feePayer)) return (sponsorAddr = d.feePayer);
      } catch { /* no sponsor: only the user may pay */ }
      return null;
    }

    async function run() {
      setBusy(true); out.className = "muted"; out.textContent = "Building transaction…";
      try {
        const built = await copy.build(i.id);
        const refusal = refusalOf(built);
        if (refusal) { show(describeBuilt(i.side, built, undefined)); out.className = "err"; out.textContent = `Refused: ${refusal}`; return; }
        // Decode and check what the wallet would sign BEFORE showing a confirm button.
        let view = describeBuilt(i.side, built, undefined);
        const claimedFee = view.feeLamports;
        let checked;
        try {
          checked = await checkBuiltTransaction(built.transaction, { user: env.signer.address(), sponsor: await expectedSponsor(), mint: i.mint, venue: i.venue, feeWallet: FEE_WALLET || null, feeLamports: claimedFee, feeAccounts: JUPITER_FEE_ACCOUNTS.length ? JUPITER_FEE_ACCOUNTS : null });
        } catch (e) {
          show(null); out.className = "err";
          out.textContent = e instanceof AppCheckError ? e.message : `Refusing to sign: this transaction failed the safety check (${errMsg(e)}).`;
          setBusy(false); return;
        }
        view = { ...describeBuilt(i.side, built, i.slippageBps), venue: checked.venues[0] };
        view.unknown = view.unknown.filter((u) => u !== "venue");
        show(view);
        clear(out); out.className = "";
        const confirm = h("button", { class: "primary", onclick: () => void sign(built.transaction, confirm as HTMLButtonElement) }, "Confirm and sign") as HTMLButtonElement;
        const cancel = h("button", { onclick: () => { clear(out); setBusy(false); show(null); } }, "Cancel");
        const parts: Node[] = [h("p", { class: "muted" }, "Review the details above, then confirm. The transaction passed the safety check (fee payer, programs, transfers, token and approvals).")];
        if (checked.feeLamportsInTx > 0n) parts.push(h("p", { class: "muted" }, `The transaction pays ${sol(Number(checked.feeLamportsInTx))} to the Ringside fee wallet.`));
        if (view.unknown.length) {
          const ack = h("input", { type: "checkbox", id: `ack-${i.id}`, onchange: () => { confirm.disabled = !(ack as HTMLInputElement).checked; } });
          confirm.disabled = true;
          parts.push(h("div", { class: "warn" }, `Unknown: ${view.unknown.join(", ")}. The service did not report these, so the app cannot show what you will get.`),
            h("label", { for: `ack-${i.id}` }, ack, " I understand and want to sign anyway."));
        }
        out.append(...parts, h("div", { class: "two" }, cancel, confirm));
      } catch (e) {
        out.className = "err"; out.textContent = errMsg(e); setBusy(false);
      }
    }
    async function sign(txB64: string, btn: HTMLButtonElement) {
      btn.disabled = true;
      const status = h("p", { class: "muted" }, "Waiting for your signature…");
      out.append(status);
      try {
        const signedTx = await env.signer.signTransaction(unb64(txB64));
        status.textContent = "Sending (fees sponsored)…";
        const sent = await sponsorSend(b64(signedTx));
        await copy.sent(i.id, sent.signature).catch(() => undefined);
        clear(out); out.className = "up";
        out.append("Copied. ", h("a", { href: env.explorer(sent.signature), target: "_blank", rel: "noopener" }, "View transaction"));
        copyBtn.hidden = true; count.textContent = "sent";
        pendingCount = Math.max(0, pendingCount - 1); updateBadge();
      } catch (e) {
        clear(out); out.className = "err"; out.textContent = errMsg(e); setBusy(false);
      }
    }
    copyBtn.addEventListener("click", () => void run());
    const el = h("div", { class: "card intent" }, h("div", { class: "ihead" }, h("b", null, `${SIDE_TEXT[i.side]} · ${VENUE_TEXT[i.venue] ?? ""}`), count), body, copyBtn, out);
    return {
      el,
      tick() {
        const left = Math.max(0, Math.floor(i.expiresAt / (i.expiresAt > 1e12 ? 1000 : 1) - Date.now() / 1000));
        if (left === 0 && !expired) { expired = true; copyBtn.disabled = true; count.textContent = "expired"; }
        else if (!expired && live()) count.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
      },
    };
  }

  // ---- Badge + live updates ---------------------------------------------------
  function updateBadge() { badge.textContent = String(pendingCount); (badge as HTMLElement).hidden = pendingCount === 0; }
  async function pollPending() {
    if (!getToken() || !signedIn(env.signer)) return;
    try { pendingCount = (await copy.pending()).filter((i) => i.status === "pending").length; updateBadge(); } catch { /* engine offline */ }
  }
  setInterval(() => void pollPending(), 30_000);
  streamNotifications(() => { void pollPending(); if (!root.hidden && view.t === "feed") refresh(); });
  void pollPending();

  return { go };
}
