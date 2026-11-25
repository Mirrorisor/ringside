// Checks the keeper's decoders and discriminators against bytes serialized by the Rust program.
import { readFileSync } from "node:fs";
import { decodeMarket, decodePosition, decodeOrder } from "../dist/keeper.js";
import { createHash } from "node:crypto";
const fx = Object.fromEntries(readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => l.split(" ")));
const bytes = (h) => new Uint8Array(Buffer.from(h, "hex"));
const disc = (n) => createHash("sha256").update(`account:${n}`).digest().subarray(0, 8).toString("hex");
const eq = (a, b, m) => { if (a !== b) { console.error("FAIL", m, a, b); process.exitCode = 1; } };
eq(fx.MARKET.slice(0, 16), disc("Market"), "market disc");
eq(fx.POSITION.slice(0, 16), disc("Position"), "position disc");
eq(fx.ORDER.slice(0, 16), disc("OrderRequest"), "order disc");
const m = decodeMarket("m", bytes(fx.MARKET));
eq(m.tier, 1, "tier"); eq(m.reduceOnly, true, "reduceOnly"); eq(m.adlMode, true, "adl"); eq(m.bandAnchorQ64, 15n << 64n, "anchor");
const p = decodePosition("p", bytes(fx.POSITION));
eq(p.side, 1, "side"); eq(p.collateral, 6n, "col"); eq(p.sizeUsd, 7n, "size"); eq(p.entryQ64, (8n << 64n) + 3n, "entry");
const o = decodeOrder("o", bytes(fx.ORDER));
eq(o.kind, 1, "kind"); eq(o.requestSlot, 12345n, "slot"); eq(o.rentPayer, "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf", "rentPayer");
console.log(process.exitCode ? "layout mismatch" : "keeper decoders match the Rust layout");
