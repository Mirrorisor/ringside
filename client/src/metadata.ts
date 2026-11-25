/**
 * Token metadata hosting for launches: POST /v1/metadata with
 * { name, symbol, description?, image? (data: URL) } → { uri }.
 *
 * The image and a Metaplex-style JSON ({ name, symbol, description, image })
 * are pinned to IPFS through Pinata when PINATA_JWT is set. Without it, and
 * only off mainnet, they're kept on this server's disk and served from
 * GET /v1/metadata/<file>, which is enough for devnet.
 *
 * Checks: image ≤ 1 MB and really PNG/JPEG/GIF/WebP (magic bytes, not the
 * claimed type), name ≤ 32 / symbol ≤ 10 / description ≤ 500 chars, URI ≤ 200
 * chars (the launch program's limit), 20 uploads per client per hour.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_METADATA_BODY = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;
const UPLOADS_PER_HOUR = 20;

export interface MetadataInput { name?: unknown; symbol?: unknown; description?: unknown; image?: unknown }
export type MetadataResult = { ok: true; uri: string } | { ok: false; status: number; code: string; message: string };

const KINDS: { ext: string; mime: string; magic: number[]; at?: number }[] = [
  { ext: "png", mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "jpg", mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { ext: "gif", mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", mime: "image/webp", magic: [0x57, 0x45, 0x42, 0x50], at: 8 },
];

export function sniffImage(b: Buffer) {
  return KINDS.find((k) => k.magic.every((x, i) => b[(k.at ?? 0) + i] === x)) ?? null;
}

const bad = (code: string, message: string, status = 400): MetadataResult => ({ ok: false, status, code, message });

export class MetadataStore {
  private uses = new Map<string, number[]>();

  constructor(
    private opts: {
      pinataJwt?: string;
      gateway?: string; // e.g. https://<you>.mypinata.cloud/ipfs/
      localDir?: string;
      publicUrl?: string; // where GET /v1/metadata/* is reachable
      mainnet?: boolean;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private allow(client: string) {
    const now = Date.now();
    const recent = (this.uses.get(client) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= UPLOADS_PER_HOUR) return false;
    recent.push(now);
    this.uses.set(client, recent);
    return true;
  }

  async create(input: MetadataInput, client: string): Promise<MetadataResult> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!name || name.length > 32) return bad("bad_name", "Name must be 1–32 characters.");
    if (!symbol || symbol.length > 10) return bad("bad_symbol", "Ticker must be 1–10 characters.");
    if (description.length > 500) return bad("bad_description", "Description is limited to 500 characters.");

    let image: { bytes: Buffer; ext: string; mime: string } | null = null;
    if (input.image !== undefined && input.image !== null && input.image !== "") {
      const m = typeof input.image === "string" ? /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(input.image) : null;
      if (!m) return bad("bad_image", "Image must be a base64 data: URL.");
      const bytes = Buffer.from(m[1], "base64");
      if (bytes.length > MAX_IMAGE_BYTES) return bad("image_too_large", "Image is limited to 1 MB.", 413);
      const kind = sniffImage(bytes);
      if (!kind) return bad("bad_image", "Image must be PNG, JPEG, GIF or WebP.");
      image = { bytes, ext: kind.ext, mime: kind.mime };
    }
    if (!this.allow(client)) return bad("rate_limited", "Too many uploads; try again later.", 429);

    const json = (imageUri: string) => JSON.stringify({ name, symbol, description, image: imageUri });
    if (this.opts.pinataJwt) return this.pinata(image, json, name);
    if (this.opts.mainnet) return bad("storage_unconfigured", "Metadata storage isn't configured (set PINATA_JWT).", 503);
    return this.local(image, json);
  }

  private async pinata(image: { bytes: Buffer; ext: string; mime: string } | null, json: (u: string) => string, name: string): Promise<MetadataResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const gateway = this.opts.gateway ?? "https://gateway.pinata.cloud/ipfs/";
    const auth = { authorization: `Bearer ${this.opts.pinataJwt}` };
    let imageUri = "";
    if (image) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `${name}.${image.ext}`);
      const r = await f("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: auth, body: form });
      if (!r.ok) return bad("storage_failed", `Image upload failed (${r.status}).`, 502);
      imageUri = gateway + ((await r.json()) as { IpfsHash: string }).IpfsHash;
    }
    const r = await f("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ pinataContent: JSON.parse(json(imageUri)), pinataMetadata: { name: `${name} metadata` } }),
    });
    if (!r.ok) return bad("storage_failed", `Metadata upload failed (${r.status}).`, 502);
    const uri = gateway + ((await r.json()) as { IpfsHash: string }).IpfsHash;
    return uri.length <= 200 ? { ok: true, uri } : bad("uri_too_long", "Metadata URI is over 200 characters; use a shorter gateway.", 500);
  }

  private local(image: { bytes: Buffer; ext: string } | null, json: (u: string) => string): MetadataResult {
    const dir = this.opts.localDir ?? "metadata-store";
    const base = (this.opts.publicUrl ?? "http://localhost:8787").replace(/\/$/, "") + "/v1/metadata/";
    mkdirSync(dir, { recursive: true });
    let imageUri = "";
    if (image) {
      const file = createHash("sha256").update(image.bytes).digest("hex").slice(0, 32) + "." + image.ext;
      writeFileSync(join(dir, file), image.bytes);
      imageUri = base + file;
    }
    const body = json(imageUri);
    const file = createHash("sha256").update(body).digest("hex").slice(0, 32) + ".json";
    writeFileSync(join(dir, file), body);
    return { ok: true, uri: base + file };
  }

  /** GET /v1/metadata/<file> for the local store; null when not found or not allowed. */
  serve(file: string): { body: Buffer; type: string } | null {
    if (!/^[0-9a-f]{32}\.(json|png|jpg|gif|webp)$/.test(file)) return null;
    const p = join(this.opts.localDir ?? "metadata-store", file);
    if (!existsSync(p)) return null;
    const ext = file.split(".")[1];
    const type = ext === "json" ? "application/json" : KINDS.find((k) => k.ext === ext)!.mime;
    return { body: readFileSync(p), type };
  }
}
