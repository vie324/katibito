// 認証: パスワード(scrypt)、セッション(HttpOnly Cookie)、ログイン試行の制限、初期設定コード。

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

function scryptAsync(pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scryptAsync(pw.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 照合時間を一定に近づけるためのダミー(存在しないユーザーへのログイン) */
let dummyHash: string | null = null;
export async function burnPasswordCheck(pw: string): Promise<void> {
  if (!dummyHash) dummyHash = await hashPassword("dummy-password-for-timing");
  await verifyPassword(pw, dummyHash);
}

// ---------------------------------------------------------------------------
// セッション
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "ktb_session";

const tokenKey = (token: string) => createHash("sha256").update(token).digest("base64url");

export class Sessions {
  constructor(
    private readonly store: Store,
    private readonly ttlMs: number,
  ) {}

  create(userId: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.store.sessions.set(tokenKey(token), { userId, createdAt: now, expiresAt: now + this.ttlMs });
    this.store.scheduleSessionsSave();
    return token;
  }

  /** 有効なら userId。残り期間が半分を切っていたら延長する */
  resolve(token: string | undefined): string | null {
    if (!token || token.length > 200) return null;
    const key = tokenKey(token);
    const s = this.store.sessions.get(key);
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt <= now) {
      this.store.sessions.delete(key);
      this.store.scheduleSessionsSave();
      return null;
    }
    if (s.expiresAt - now < this.ttlMs / 2) {
      s.expiresAt = now + this.ttlMs;
      this.store.scheduleSessionsSave();
    }
    return s.userId;
  }

  destroy(token: string | undefined): void {
    if (!token) return;
    if (this.store.sessions.delete(tokenKey(token))) this.store.scheduleSessionsSave();
  }

  /** パスワード変更・無効化時: そのユーザーのセッションをすべて消す(keep は残す) */
  destroyUser(userId: string, keepToken?: string): void {
    const keep = keepToken ? tokenKey(keepToken) : null;
    let changed = false;
    for (const [k, s] of this.store.sessions) {
      if (s.userId === userId && k !== keep) {
        this.store.sessions.delete(k);
        changed = true;
      }
    }
    if (changed) this.store.scheduleSessionsSave();
  }

  get ttlSec(): number {
    return Math.floor(this.ttlMs / 1000);
  }
}

// ---------------------------------------------------------------------------
// ログイン試行の制限(総当たり対策)
// ---------------------------------------------------------------------------

export class LoginLimiter {
  private readonly fails = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxPerAccount = 8,
    private readonly maxPerIp = 30,
    private readonly windowMs = 15 * 60_000,
    /** 接続元を変えながらの総当たり対策: 1つのログインIDへの失敗は、接続元にかかわらずこの回数まで */
    private readonly maxPerAccountAllIps = 30,
  ) {}

  private bump(key: string): void {
    const now = Date.now();
    const e = this.fails.get(key);
    if (!e || e.resetAt <= now) this.fails.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
  }

  private count(key: string): number {
    const e = this.fails.get(key);
    if (!e || e.resetAt <= Date.now()) return 0;
    return e.count;
  }

  blocked(ip: string, loginId: string): boolean {
    const id = loginId.toLowerCase();
    return (
      this.count(`a:${ip}|${id}`) >= this.maxPerAccount ||
      this.count(`i:${ip}`) >= this.maxPerIp ||
      this.count(`u:${id}`) >= this.maxPerAccountAllIps
    );
  }

  fail(ip: string, loginId: string): void {
    const id = loginId.toLowerCase();
    this.bump(`a:${ip}|${id}`);
    this.bump(`i:${ip}`);
    this.bump(`u:${id}`);
    this.prune();
  }

  /** 期限切れの記録を捨てる(ランダムなIDで失敗を繰り返されてもメモリが増え続けないように) */
  private prune(): void {
    if (this.fails.size < 10_000) return;
    const now = Date.now();
    for (const [k, e] of this.fails) if (e.resetAt <= now) this.fails.delete(k);
  }

  succeed(ip: string, loginId: string): void {
    this.fails.delete(`a:${ip}|${loginId.toLowerCase()}`);
  }
}

// ---------------------------------------------------------------------------
// 初期設定コード: ユーザーが1人もいないときだけ有効。サーバーのログに出す。
// 公開サーバーで最初にアクセスした第三者が管理者を作れないようにするため。
// ---------------------------------------------------------------------------

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSetupCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function setupCodeMatches(input: string, expected: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = Buffer.from(norm(input));
  const b = Buffer.from(norm(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
