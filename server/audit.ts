// 操作ログ(誰が・いつ・何をしたか)。月ごとの JSON Lines に追記する。
// 候補者の個人情報(氏名など)は書かない。面接は ID で記録する。

import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "../src/shared/types";

export class Audit {
  constructor(private readonly dir: string) {}

  async write(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, ...entry }) + "\n";
    const file = path.join(this.dir, `${ts.slice(0, 7)}.jsonl`);
    try {
      await appendFile(file, line);
    } catch (e) {
      console.error("[audit] 書き込みに失敗", e);
    }
  }

  async read(limit: number): Promise<AuditEntry[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const f of files) {
      const lines = (await readFile(path.join(this.dir, f), "utf8")).split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          out.push(JSON.parse(lines[i]) as AuditEntry);
        } catch {
          // 壊れた行は読み飛ばす
        }
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}
