// Token metadata upload: validation, local store, Pinata path, limits, HTTP routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataStore, sniffImage, MAX_IMAGE_BYTES } from "../dist/metadata.js";
import { createRelayerServer } from "../dist/relayer.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5540000000049454e44ae426082", "hex");
const dataUrl = (b, type = "image/png") => `data:${type};base64,${b.toString("base64")}`;
const dir = () => mkdtempSync(join(tmpdir(), "meta-"));

test("sniffs real image bytes, not the claimed type", () => {
  assert.equal(sniffImage(PNG).ext, "png");
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null);
});

test("refuses fake images, oversized images and bad fields", async () => {
  const s = new MetadataStore({ localDir: dir() });
  assert.equal((await s.create({ name: "A", symbol: "A", image: dataUrl(Buffer.from("not an image")) }, "c")).code, "bad_image");
  assert.equal((await s.create({ name: "A", symbol: "A", image: dataUrl(Buffer.alloc(MAX_IMAGE_BYTES + 1)) }, "c")).code, "image_too_large");
  assert.equal((await s.create({ name: "", symbol: "A" }, "c")).code, "bad_name");
  assert.equal((await s.create({ name: "A", symbol: "TOOLONGTICKER" }, "c")).code, "bad_symbol");
});

test("local store (devnet) writes image + JSON and serves them back", async () => {
  const s = new MetadataStore({ localDir: dir(), publicUrl: "http://x.test/relayer" });
  const r = await s.create({ name: "Night Moth", symbol: "moth", description: "test", image: dataUrl(PNG) }, "c");
  assert.ok(r.ok);
  assert.match(r.uri, /^http:\/\/x\.test\/relayer\/v1\/metadata\/[0-9a-f]{32}\.json$/);
  const meta = JSON.parse(s.serve(r.uri.split("/").pop()).body.toString());
  assert.deepEqual([meta.name, meta.symbol, meta.description], ["Night Moth", "MOTH", "test"]);
  const img = s.serve(meta.image.split("/").pop());
  assert.equal(img.type, "image/png");
  assert.deepEqual(img.body, PNG);
  assert.equal(s.serve("../../etc/passwd"), null, "no path traversal");
  assert.ok(r.uri.length <= 200);
});

test("mainnet without Pinata refuses instead of storing locally", async () => {
  const s = new MetadataStore({ localDir: dir(), mainnet: true });
  assert.equal((await s.create({ name: "A", symbol: "A" }, "c")).status, 503);
});

test("Pinata path pins image then JSON and returns the gateway link", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: init.body });
    return { ok: true, json: async () => ({ IpfsHash: calls.length === 1 ? "bafyimage" : "bafyjson" }) };
  };
  const s = new MetadataStore({ pinataJwt: "jwt", gateway: "https://gw.test/ipfs/", fetchImpl });
  const r = await s.create({ name: "Moth", symbol: "MOTH", image: dataUrl(PNG) }, "c");
  assert.deepEqual(r, { ok: true, uri: "https://gw.test/ipfs/bafyjson" });
  assert.equal(calls[0].url, "https://api.pinata.cloud/pinning/pinFileToIPFS");
  assert.equal(calls[1].auth, "Bearer jwt");
  assert.equal(JSON.parse(calls[1].body).pinataContent.image, "https://gw.test/ipfs/bafyimage");
});

test("20 uploads per client per hour", async () => {
  const s = new MetadataStore({ localDir: dir() });
  for (let i = 0; i < 20; i++) assert.ok((await s.create({ name: `T${i}`, symbol: "T" }, "same")).ok);
  assert.equal((await s.create({ name: "T", symbol: "T" }, "same")).status, 429);
  assert.ok((await s.create({ name: "T", symbol: "T" }, "other")).ok);
});

test("relayer serves the upload routes", async () => {
  const relayer = { signer: { address: "x" }, limits: {}, clientKey: (ip) => ip };
  const server = createRelayerServer(relayer, { metadata: new MetadataStore({ localDir: dir(), publicUrl: "http://127.0.0.1" }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const up = await fetch(`${base}/v1/metadata`, { method: "POST", body: JSON.stringify({ name: "Moth", symbol: "MOTH", image: dataUrl(PNG) }) });
  assert.equal(up.status, 200);
  const { uri } = await up.json();
  const got = await fetch(base + new URL(uri).pathname);
  assert.equal(got.headers.get("content-type"), "application/json");
  assert.equal((await got.json()).name, "Moth");
  assert.equal((await fetch(`${base}/v1/metadata/..%2F..%2Fpackage.json`)).status, 404);
  server.close();
});
