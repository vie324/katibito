// メモの中のリンクのうち、このアプリの中へのもの(場面へのリンクなど)だけを押せるようにするための判定。

/**
 * このアプリの中へのリンクなら、移動先(パス+クエリ)を返す。外部のサイト・判定できないものは null。
 * 「https://<このアプリ>//evil.example/…」のように、パスが // で始まるもの(ブラウザでは外部のサイトになる)は認めない
 */
export function internalPath(raw: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (!/^\/(?![/\\])/.test(u.pathname) || u.pathname.includes("\\")) return null;
  return u.pathname + u.search;
}
