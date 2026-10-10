// ZIP の書き出し(圧縮なし・ストリーム)。録画のような大きなファイルもメモリに載せずに書き出す。
// 各ファイルの CRC とサイズは中身のあとに書く(データ記述子)。ファイル名は UTF-8。
// ZIP64 は使わないため、全体を 4GB 未満に収める(超えるファイルは呼び出し側で除く)。

import { once } from "node:events";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { crc32 } from "node:zlib";

/** ヘッダーと中央ディレクトリのぶんを残した上限 */
export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;

const FLAGS = 0x0008 | 0x0800; // データ記述子あり・ファイル名は UTF-8

type Entry = { name: Buffer; crc: number; size: number; offset: number; time: number; date: number };

/** 日本時間での DOS 形式の日時 */
function dosDateTime(d: Date): { time: number; date: number } {
  const j = new Date(d.getTime() + 9 * 3600_000);
  const time = (j.getUTCHours() << 11) | (j.getUTCMinutes() << 5) | Math.floor(j.getUTCSeconds() / 2);
  const date = ((Math.max(1980, j.getUTCFullYear()) - 1980) << 9) | ((j.getUTCMonth() + 1) << 5) | j.getUTCDate();
  return { time, date };
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly out: Writable) {}

  get size(): number {
    return this.offset;
  }

  private async write(buf: Buffer): Promise<void> {
    if (this.out.destroyed) throw new Error("書き出しの途中で接続が切れました");
    this.offset += buf.length;
    if (!this.out.write(buf)) await this.drain();
  }

  /** 受け手が追いつくのを待つ(途中で接続が切れたら止める) */
  private async drain(): Promise<void> {
    const ac = new AbortController();
    try {
      await Promise.race([
        once(this.out, "drain", { signal: ac.signal }),
        once(this.out, "close", { signal: ac.signal }).then(() => {
          throw new Error("書き出しの途中で接続が切れました");
        }),
      ]);
    } finally {
      ac.abort();
    }
  }

  /** 同じ名前が重なったら「名前 (2).拡張子」にする */
  private uniqueName(name: string): string {
    let n = name;
    for (let i = 2; this.names.has(n); i++) {
      const dot = name.lastIndexOf(".");
      const slash = name.lastIndexOf("/");
      n = dot > slash + 1 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    this.names.add(n);
    return n;
  }

  private async begin(name: string, when: Date): Promise<Entry> {
    const nameBuf = Buffer.from(this.uniqueName(name), "utf8");
    const { time, date } = dosDateTime(when);
    const e: Entry = { name: nameBuf, crc: 0, size: 0, offset: this.offset, time, date };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(FLAGS, 6);
    h.writeUInt16LE(0, 8); // 圧縮なし
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    // CRC・サイズはデータ記述子に書く(ここは 0)
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    await this.write(h);
    await this.write(nameBuf);
    return e;
  }

  private async end(e: Entry): Promise<void> {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(e.crc >>> 0, 4);
    d.writeUInt32LE(e.size, 8);
    d.writeUInt32LE(e.size, 12);
    await this.write(d);
    this.entries.push(e);
  }

  async addBuffer(name: string, data: Buffer | string, when = new Date()): Promise<void> {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const e = await this.begin(name, when);
    e.crc = crc32(buf);
    e.size = buf.length;
    await this.write(buf);
    await this.end(e);
  }

  async addFile(name: string, file: string, when = new Date()): Promise<void> {
    const e = await this.begin(name, when);
    let crc = 0;
    for await (const chunk of createReadStream(file)) {
      const b = chunk as Buffer;
      crc = crc32(b, crc);
      e.size += b.length;
      await this.write(b);
    }
    e.crc = crc;
    await this.end(e);
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.offset, 42);
      await this.write(h);
      await this.write(e.name);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(this.offset - start, 12);
    eocd.writeUInt32LE(start, 16);
    await this.write(eocd);
    this.out.end();
  }
}
