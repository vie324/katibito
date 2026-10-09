// 入力検証の小さなヘルパー(サーバーが受け取る JSON の検証に使う)。
// エラーメッセージは画面にそのまま出せる日本語で書く。

export class ValidationError extends Error {}

export function obj(v: unknown, name = "入力"): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError(`${name}の形式が正しくありません`);
  }
  return v as Record<string, unknown>;
}

type StrOpts = { max: number; min?: number; optional?: boolean; multiline?: boolean };

export function str(v: unknown, name: string, opts: StrOpts): string {
  if (v === undefined || v === null) {
    if (opts.optional) return "";
    throw new ValidationError(`${name}を入力してください`);
  }
  if (typeof v !== "string") throw new ValidationError(`${name}の形式が正しくありません`);
  // 制御文字を除く(改行・タブは複数行入力のみ許可)
  const cleaned = opts.multiline
    ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    : v.replace(/[\u0000-\u001f\u007f]/g, " ");
  const s = cleaned.trim();
  if ((opts.min ?? 0) > 0 && s.length < (opts.min ?? 0)) {
    throw new ValidationError(
      s.length === 0 ? `${name}を入力してください` : `${name}は${opts.min}文字以上にしてください`,
    );
  }
  if (s.length > opts.max) throw new ValidationError(`${name}は${opts.max}文字以内にしてください`);
  return s;
}

export function int(
  v: unknown,
  name: string,
  opts: { min: number; max: number; optional?: boolean },
): number | null {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return null;
    throw new ValidationError(`${name}を入力してください`);
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ValidationError(`${name}は整数で入力してください`);
  if (n < opts.min || n > opts.max) {
    throw new ValidationError(`${name}は${opts.min}〜${opts.max}の範囲で入力してください`);
  }
  return n;
}

export function num(v: unknown, name: string, opts: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${name}の形式が正しくありません`);
  if (v < opts.min || v > opts.max) throw new ValidationError(`${name}が範囲外です`);
  return v;
}

export function bool(v: unknown, name: string, fallback?: boolean): boolean {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "boolean") throw new ValidationError(`${name}の形式が正しくありません`);
  return v;
}

export function oneOf<T extends string>(v: unknown, name: string, values: readonly T[]): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new ValidationError(`${name}の値が正しくありません`);
  }
  return v as T;
}

export function arr<T>(v: unknown, name: string, max: number, item: (x: unknown, i: number) => T): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${name}の形式が正しくありません`);
  if (v.length > max) throw new ValidationError(`${name}は${max}件までです`);
  return v.map(item);
}

/** ISO 8601 の日時。空なら null */
export function isoDate(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError(`${name}の形式が正しくありません`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new ValidationError(`${name}の日時が正しくありません`);
  return new Date(t).toISOString();
}

export const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function id(v: unknown, name: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new ValidationError(`${name}が正しくありません`);
  return v;
}

export const LOGIN_ID_RE = /^[A-Za-z0-9._@-]{3,64}$/;

export function password(v: unknown, name = "パスワード"): string {
  if (typeof v !== "string") throw new ValidationError(`${name}を入力してください`);
  if (v.length < 8) throw new ValidationError(`${name}は8文字以上にしてください`);
  if (v.length > 200) throw new ValidationError(`${name}が長すぎます`);
  return v;
}
