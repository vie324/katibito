// 2段階認証(TOTP, RFC 6238)。認証アプリ(Google Authenticator・Microsoft Authenticator など)に出る 6 桁の確認コード。
// スマートフォンをなくしたときのために、1回ずつ使える予備のコードも発行する(サーバーにはハッシュだけを保存)。

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_MS = 30_000;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("base32 の文字ではありません");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 時間刻み step の確認コード(6桁) */
export function totpAt(secret: string, step: number, digits = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac(algorithm, base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/**
 * 確認コードを確かめ、合っていればその時間刻みを返す(時計のずれを見て前後1刻みまで許す)。
 * lastStep 以前の刻みのコードは受け付けない(同じコードの使い回しを防ぐ)
 */
export function verifyTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / STEP_MS);
  for (const step of [cur - 1, cur, cur + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// 予備のコード: 読み間違えにくい文字だけで「xxxx-xxxx」
const RECOVERY_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

export function newRecoveryCodes(n = 10): string[] {
  const one = () => Array.from({ length: 8 }, () => RECOVERY_CHARS[randomInt(RECOVERY_CHARS.length)]).join("");
  return Array.from({ length: n }, () => {
    const s = one();
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export function normalizeRecovery(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}

export function hashRecovery(code: string): string {
  return createHash("sha256").update(`katibito-recovery:${normalizeRecovery(code)}`).digest("hex");
}

export function looksLikeRecovery(code: string): boolean {
  return /^[a-z0-9]{8}$/.test(normalizeRecovery(code)) && !/^\d+$/.test(normalizeRecovery(code));
}
