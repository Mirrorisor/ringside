/**
 * Sponsorship budgets: request counts per hour and lamports spent per day,
 * keyed by trading account, client and "global".
 *
 * MemoryBudget keeps them in this process (one relayer). RedisBudget keeps
 * them in Redis so several relayer instances share the same limits; it speaks
 * the Redis protocol directly over TCP (no client library), using only
 * ZADD / ZREMRANGEBYSCORE / ZCARD / PEXPIRE for hourly counts and INCRBY /
 * GET / PEXPIRE for daily spend. Limits are soft across instances: two
 * relayers can both pass a check in the same instant, by at most one request.
 */
import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomBytes } from "node:crypto";

export interface BudgetStore {
  countLastHour(key: string): Promise<number>;
  spentToday(key: string): Promise<bigint>;
  record(keys: string[], lamports: bigint): Promise<void>;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const today = () => Math.floor(Date.now() / DAY);

export class MemoryBudget implements BudgetStore {
  private hourly = new Map<string, number[]>();
  private daily = new Map<string, bigint>();
  private day = today();

  private roll() {
    if (today() !== this.day) {
      this.day = today();
      this.daily.clear();
    }
  }
  async countLastHour(key: string) {
    const cut = Date.now() - HOUR;
    const xs = (this.hourly.get(key) ?? []).filter((t) => t > cut);
    this.hourly.set(key, xs);
    return xs.length;
  }
  async spentToday(key: string) {
    this.roll();
    return this.daily.get(key) ?? 0n;
  }
  async record(keys: string[], lamports: bigint) {
    this.roll();
    for (const k of keys) {
      this.hourly.set(k, [...(this.hourly.get(k) ?? []), Date.now()]);
      this.daily.set(k, (this.daily.get(k) ?? 0n) + lamports);
    }
  }
}

type Reply = string | number | null | Reply[] | Error;

/** Minimal Redis (RESP2) client: one connection, commands answered in order. */
export class RespClient {
  private sock!: Socket;
  private buf = Buffer.alloc(0);
  private waiting: ((r: Reply) => void)[] = [];
  private ready!: Promise<void>;
  private dead = false;
  private closed = false;

  constructor(private url: string) {
    this.open();
  }

  /** (Re)connects; a dropped connection is reopened on the next command. */
  private open() {
    this.dead = false;
    this.buf = Buffer.alloc(0);
    const u = new URL(this.url);
    const tls = u.protocol === "rediss:";
    const port = Number(u.port || 6379);
    this.sock = tls ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : connect({ host: u.hostname, port });
    this.sock.on("data", (d) => this.onData(d));
    this.sock.on("error", (e) => this.failAll(e));
    this.sock.on("close", () => {
      this.dead = true;
      this.failAll(new Error("redis connection closed"));
    });
    this.ready = new Promise<void>((ok, fail) => {
      this.sock.once(tls ? "secureConnect" : "connect", () => ok());
      this.sock.once("error", fail);
    }).then(async () => {
      if (u.password) {
        const r = await this.cmd(u.username ? ["AUTH", decodeURIComponent(u.username), decodeURIComponent(u.password)] : ["AUTH", decodeURIComponent(u.password)]);
        if (r instanceof Error) throw r;
      }
    });
  }

  private failAll(e: Error) {
    for (const w of this.waiting.splice(0)) w(e);
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const parsed = RespClient.parse(this.buf, 0);
      if (!parsed) return;
      this.buf = this.buf.subarray(parsed[1]);
      this.waiting.shift()?.(parsed[0]);
    }
  }

  /** Parses one reply at `o`; null if incomplete. Returns [reply, nextOffset]. */
  static parse(b: Buffer, o: number): [Reply, number] | null {
    const eol = b.indexOf("\r\n", o);
    if (eol < 0) return null;
    const t = String.fromCharCode(b[o]);
    const line = b.toString("utf8", o + 1, eol);
    if (t === "+") return [line, eol + 2];
    if (t === "-") return [new Error(line), eol + 2];
    if (t === ":") return [Number(line), eol + 2];
    if (t === "$") {
      const n = Number(line);
      if (n < 0) return [null, eol + 2];
      if (b.length < eol + 2 + n + 2) return null;
      return [b.toString("utf8", eol + 2, eol + 2 + n), eol + 2 + n + 2];
    }
    if (t === "*") {
      const n = Number(line);
      if (n < 0) return [null, eol + 2];
      const out: Reply[] = [];
      let at = eol + 2;
      for (let i = 0; i < n; i++) {
        const p = RespClient.parse(b, at);
        if (!p) return null;
        out.push(p[0]);
        at = p[1];
      }
      return [out, at];
    }
    throw new Error(`unexpected redis reply type ${t}`);
  }

  private cmd(args: string[]): Promise<Reply> {
    let wire = `*${args.length}\r\n`;
    for (const a of args) wire += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
    return new Promise((ok) => {
      this.waiting.push(ok);
      this.sock.write(wire);
    });
  }

  async call(...args: (string | number | bigint)[]): Promise<Reply> {
    if (this.dead && !this.closed) this.open();
    await this.ready;
    const r = await this.cmd(args.map(String));
    if (r instanceof Error) throw r;
    return r;
  }

  close() {
    this.closed = true;
    this.sock.end();
  }
}

export class RedisBudget implements BudgetStore {
  constructor(private redis: RespClient, private prefix = "ringside:relayer:") {}

  async countLastHour(key: string) {
    const k = `${this.prefix}h:${key}`;
    await this.redis.call("ZREMRANGEBYSCORE", k, "-inf", Date.now() - HOUR);
    return Number(await this.redis.call("ZCARD", k));
  }
  async spentToday(key: string) {
    const v = await this.redis.call("GET", `${this.prefix}d:${today()}:${key}`);
    return v === null ? 0n : BigInt(v as string);
  }
  async record(keys: string[], lamports: bigint) {
    const now = Date.now();
    for (const key of keys) {
      const h = `${this.prefix}h:${key}`;
      await this.redis.call("ZADD", h, now, `${now}:${randomBytes(4).toString("hex")}`);
      await this.redis.call("PEXPIRE", h, HOUR);
      const d = `${this.prefix}d:${today()}:${key}`;
      await this.redis.call("INCRBY", d, lamports);
      await this.redis.call("PEXPIRE", d, 2 * DAY);
    }
  }
}
