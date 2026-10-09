// MediaRecorder が書く WebM に Duration と Cues(シーク用索引)を付けて書き直す。
//
// Chrome の MediaRecorder はライブ出力なので、Segment / Cluster のサイズが「不明」、
// Duration なし、Cues なしで書かれる。このまま配信すると、ブラウザは後半へシークするたびに
// 先頭から順に読むしかなく(30分の面接なら数百MBのダウンロード)、遠隔での確認に耐えない。
// ここでは:
//   - 先頭に SeekHead、Info に Duration を追加
//   - 各 Cluster のサイズを確定値に書き換え
//   - 末尾に Cues(映像のキーフレームごと)を追加
// した新しいファイルを書く。Cluster の中身はバイト単位でそのままコピーする(再エンコードしない)。
// 途中で途切れたファイル(ブラウザが落ちた等)は、最後の完全な要素までで切り詰める。

import { open, stat, type FileHandle } from "node:fs/promises";

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
  Void: 0xec,
  CRC32: 0xbf,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

/** 不明サイズの Cluster の終わりを判定するための、Segment 直下(および上位)の要素 */
const TOP_LEVEL = new Set<number>([
  ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Chapters, ID.Tags, ID.Attachments,
  ID.EBML, ID.Segment,
]);

export class WebmFormatError extends Error {}

export type WebmIndexResult = {
  durationMs: number;
  cueCount: number;
  clusterCount: number;
  /** 途中で途切れていたため切り詰めた */
  truncated: boolean;
  bytesWritten: number;
};

// ---------------------------------------------------------------------------
// 読み出し(1MB 窓のバッファ付き)
// ---------------------------------------------------------------------------

class Reader {
  private buf = Buffer.alloc(1 << 20);
  private start = 0;
  private len = 0;

  constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}

  /** [pos, pos+n) を読めるようにする。ファイル末尾を越える場合 false。 */
  async ensure(pos: number, n: number): Promise<boolean> {
    if (pos + n > this.size) return false;
    if (pos >= this.start && pos + n <= this.start + this.len) return true;
    if (n > this.buf.length) this.buf = Buffer.alloc(n);
    const want = Math.min(this.buf.length, this.size - pos);
    const { bytesRead } = await this.fh.read(this.buf, 0, want, pos);
    this.start = pos;
    this.len = bytesRead;
    return pos + n <= this.start + this.len;
  }

  byte(pos: number): number {
    return this.buf[pos - this.start];
  }

  slice(pos: number, n: number): Buffer {
    return Buffer.from(this.buf.subarray(pos - this.start, pos - this.start + n));
  }
}

type ElementHeader = {
  id: number;
  /** null = サイズ不明 */
  size: number | null;
  dataStart: number;
  headerLen: number;
};

async function readHeader(r: Reader, pos: number, limit: number): Promise<ElementHeader | null> {
  const avail = Math.min(12, limit - pos);
  if (avail < 2 || !(await r.ensure(pos, avail))) return null;
  const b0 = r.byte(pos);
  let idLen = 0;
  if (b0 & 0x80) idLen = 1;
  else if (b0 & 0x40) idLen = 2;
  else if (b0 & 0x20) idLen = 3;
  else if (b0 & 0x10) idLen = 4;
  else throw new WebmFormatError(`不正な要素ID (offset ${pos})`);
  if (idLen >= avail) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + r.byte(pos + i);

  const s0 = r.byte(pos + idLen);
  let sizeLen = 1;
  let mask = 0x80;
  while (sizeLen <= 8 && !(s0 & mask)) {
    sizeLen++;
    mask >>= 1;
  }
  if (sizeLen > 8) throw new WebmFormatError(`不正なサイズ (offset ${pos})`);
  if (idLen + sizeLen > avail) return null;
  let value = s0 & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < sizeLen; i++) {
    const b = r.byte(pos + idLen + i);
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return {
    id,
    size: allOnes ? null : value,
    dataStart: pos + idLen + sizeLen,
    headerLen: idLen + sizeLen,
  };
}

function readUintBuf(buf: Buffer, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
  return v;
}

/** バッファ内の子要素を列挙する(Info / Tracks / BlockGroup の解析用) */
function* children(buf: Buffer, start: number, end: number): Generator<{ id: number; dataStart: number; size: number; start: number }> {
  let p = start;
  while (p < end) {
    const b0 = buf[p];
    const idLen = b0 & 0x80 ? 1 : b0 & 0x40 ? 2 : b0 & 0x20 ? 3 : b0 & 0x10 ? 4 : 0;
    if (idLen === 0 || p + idLen >= end) return;
    const id = readUintBuf(buf, p, idLen);
    const s0 = buf[p + idLen];
    let sizeLen = 1;
    let mask = 0x80;
    while (sizeLen <= 8 && !(s0 & mask)) {
      sizeLen++;
      mask >>= 1;
    }
    if (sizeLen > 8 || p + idLen + sizeLen > end) return;
    let size = s0 & (mask - 1);
    for (let i = 1; i < sizeLen; i++) size = size * 256 + buf[p + idLen + i];
    const dataStart = p + idLen + sizeLen;
    if (dataStart + size > end) return;
    yield { id, dataStart, size, start: p };
    p = dataStart + size;
  }
}

function blockHeader(buf: Buffer, off: number, len: number): { track: number; rel: number; flags: number } | null {
  if (len < 4) return null;
  const b0 = buf[off];
  let tl = 1;
  let mask = 0x80;
  while (tl <= 8 && !(b0 & mask)) {
    tl++;
    mask >>= 1;
  }
  if (tl > 8 || tl + 3 > len) return null;
  let track = b0 & (mask - 1);
  for (let i = 1; i < tl; i++) track = track * 256 + buf[off + i];
  const rel = buf.readInt16BE(off + tl);
  const flags = buf[off + tl + 2];
  return { track, rel, flags };
}

// ---------------------------------------------------------------------------
// 書き出し用のエンコード
// ---------------------------------------------------------------------------

function idBytes(id: number): Buffer {
  const len = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const b = Buffer.alloc(len);
  let v = id;
  for (let i = len - 1; i >= 0; i--) {
    b[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return b;
}

function sizeBytes(n: number, fixedLen?: number): Buffer {
  let len = fixedLen ?? 1;
  if (fixedLen === undefined) {
    while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  }
  if (n >= 2 ** (7 * len) - 1) throw new WebmFormatError("サイズが大きすぎます");
  const b = Buffer.alloc(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  b[0] |= 0x80 >> (len - 1);
  return b;
}

function uintBytes(n: number, fixedLen?: number): Buffer {
  let len = fixedLen ?? 1;
  if (fixedLen === undefined) {
    while (len < 8 && n >= 2 ** (8 * len)) len++;
  }
  const b = Buffer.alloc(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return b;
}

function element(id: number, payload: Buffer, fixedSizeLen?: number): Buffer {
  return Buffer.concat([idBytes(id), sizeBytes(payload.length, fixedSizeLen), payload]);
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

type ClusterInfo = {
  /** 入力ファイル上の Cluster データ部の範囲 */
  dataStart: number;
  dataEnd: number;
  timecode: number;
  /** トラックごとの最初のキーフレームの絶対時刻 */
  firstKey: Map<number, number>;
};

type RawRange = { start: number; end: number };

export async function indexWebm(inputPath: string, outputPath: string): Promise<WebmIndexResult> {
  const fileSize = (await stat(inputPath)).size;
  const fh = await open(inputPath, "r");
  try {
    const r = new Reader(fh, fileSize);

    const ebml = await readHeader(r, 0, fileSize);
    if (!ebml || ebml.id !== ID.EBML || ebml.size === null) throw new WebmFormatError("WebM ではありません");
    const headerEnd = ebml.dataStart + ebml.size;

    const seg = await readHeader(r, headerEnd, fileSize);
    if (!seg || seg.id !== ID.Segment) throw new WebmFormatError("Segment が見つかりません");
    const segDataStart = seg.dataStart;
    const segEnd = seg.size === null ? fileSize : Math.min(fileSize, segDataStart + seg.size);

    let info: RawRange | null = null;
    let tracks: RawRange | null = null;
    const kept: RawRange[] = [];
    const clusters: ClusterInfo[] = [];
    let truncated = false;
    let maxTime = 0;

    let pos = segDataStart;
    while (pos < segEnd) {
      const h = await readHeader(r, pos, segEnd);
      if (!h) {
        truncated = true;
        break;
      }
      if (h.id === ID.Cluster) {
        const parsed = await parseCluster(r, h, segEnd);
        if (parsed.cluster) {
          clusters.push(parsed.cluster);
          maxTime = Math.max(maxTime, parsed.maxTime);
        }
        if (parsed.truncated) {
          truncated = true;
          break;
        }
        pos = parsed.end;
        continue;
      }
      if (h.size === null) throw new WebmFormatError("サイズ不明の要素は扱えません");
      const end = h.dataStart + h.size;
      if (end > segEnd) {
        truncated = true;
        break;
      }
      if (h.id === ID.Info) info = { start: pos, end };
      else if (h.id === ID.Tracks) tracks = { start: pos, end };
      else if (h.id === ID.Tags || h.id === ID.Chapters || h.id === ID.Attachments) kept.push({ start: pos, end });
      // SeekHead / Cues / Void / CRC-32 / その他は作り直すか捨てる
      pos = end;
    }

    if (!info || !tracks) throw new WebmFormatError("Info / Tracks が見つかりません");
    if (clusters.length === 0) throw new WebmFormatError("映像データがありません");

    // --- Info(Duration を差し替え) ---
    await r.ensure(info.start, info.end - info.start);
    const infoBuf = r.slice(info.start, info.end - info.start);
    const infoHdr = await readHeader(r, info.start, info.end);
    if (!infoHdr || infoHdr.size === null) throw new WebmFormatError("Info を読めません");
    const infoDataOff = infoHdr.dataStart - info.start;
    let timecodeScale = 1_000_000;
    const infoChildren: Buffer[] = [];
    for (const c of children(infoBuf, infoDataOff, infoBuf.length)) {
      if (c.id === ID.TimecodeScale) timecodeScale = readUintBuf(infoBuf, c.dataStart, c.size) || 1_000_000;
      if (c.id === ID.Duration) continue;
      infoChildren.push(infoBuf.subarray(c.start, c.dataStart + c.size));
    }
    const durationUnits = maxTime;
    const durBuf = Buffer.alloc(8);
    durBuf.writeDoubleBE(durationUnits, 0);
    infoChildren.push(element(ID.Duration, durBuf));
    const newInfo = element(ID.Info, Buffer.concat(infoChildren));

    // --- Tracks(映像トラックを Cues の対象にする) ---
    await r.ensure(tracks.start, tracks.end - tracks.start);
    const tracksBuf = r.slice(tracks.start, tracks.end - tracks.start);
    const tracksHdr = await readHeader(r, tracks.start, tracks.end);
    if (!tracksHdr) throw new WebmFormatError("Tracks を読めません");
    let videoTrack: number | null = null;
    let firstTrack: number | null = null;
    for (const e of children(tracksBuf, tracksHdr.dataStart - tracks.start, tracksBuf.length)) {
      if (e.id !== ID.TrackEntry) continue;
      let num: number | null = null;
      let type: number | null = null;
      for (const c of children(tracksBuf, e.dataStart, e.dataStart + e.size)) {
        if (c.id === ID.TrackNumber) num = readUintBuf(tracksBuf, c.dataStart, c.size);
        if (c.id === ID.TrackType) type = readUintBuf(tracksBuf, c.dataStart, c.size);
      }
      if (num === null) continue;
      if (firstTrack === null) firstTrack = num;
      if (type === 1 && videoTrack === null) videoTrack = num;
    }
    const cueTrack = videoTrack ?? firstTrack ?? 1;

    const keptBufs: Buffer[] = [];
    for (const k of kept) {
      await r.ensure(k.start, k.end - k.start);
      keptBufs.push(r.slice(k.start, k.end - k.start));
    }

    // --- レイアウト(Segment データ部先頭からのオフセット) ---
    // SeekHead は SeekPosition を8バイト固定にして長さを確定させる
    const seekEntry = (target: number, position: number) =>
      element(ID.Seek, Buffer.concat([element(ID.SeekID, idBytes(target)), element(ID.SeekPosition, uintBytes(position, 8))]));
    const seekHeadLen = element(ID.SeekHead, Buffer.concat([seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)])).length;

    const offInfo = seekHeadLen;
    const offTracks = offInfo + newInfo.length;
    let off = offTracks + tracksBuf.length;
    for (const k of keptBufs) off += k.length;

    const CLUSTER_HEADER = 4 + 8; // ID(4) + サイズ(8バイト固定)
    const clusterOffsets: number[] = [];
    for (const c of clusters) {
      clusterOffsets.push(off);
      off += CLUSTER_HEADER + (c.dataEnd - c.dataStart);
    }
    const offCues = off;

    const cuePoints: Buffer[] = [];
    let lastCueTime = -1;
    clusters.forEach((c, i) => {
      let t = c.firstKey.get(cueTrack);
      if (t === undefined && videoTrack === null) t = c.timecode;
      if (t === undefined || t <= lastCueTime) return;
      lastCueTime = t;
      cuePoints.push(
        element(
          ID.CuePoint,
          Buffer.concat([
            element(ID.CueTime, uintBytes(Math.max(0, t))),
            element(
              ID.CueTrackPositions,
              Buffer.concat([
                element(ID.CueTrack, uintBytes(cueTrack)),
                element(ID.CueClusterPosition, uintBytes(clusterOffsets[i], 8)),
              ]),
            ),
          ]),
        ),
      );
    });
    const cues = element(ID.Cues, Buffer.concat(cuePoints));
    const seekHead = element(
      ID.SeekHead,
      Buffer.concat([seekEntry(ID.Info, offInfo), seekEntry(ID.Tracks, offTracks), seekEntry(ID.Cues, offCues)]),
    );
    if (seekHead.length !== seekHeadLen) throw new WebmFormatError("SeekHead の長さが一致しません");
    const segmentSize = offCues + cues.length;

    // --- 書き出し ---
    await r.ensure(0, headerEnd);
    const ebmlHeader = r.slice(0, headerEnd);
    const out = await open(outputPath, "w");
    let written = 0;
    try {
      const pending: Buffer[] = [];
      let pendingLen = 0;
      const flush = async () => {
        if (pendingLen === 0) return;
        const b = Buffer.concat(pending, pendingLen);
        pending.length = 0;
        pendingLen = 0;
        await out.write(b);
        written += b.length;
      };
      const push = async (b: Buffer) => {
        pending.push(b);
        pendingLen += b.length;
        if (pendingLen >= 1 << 20) await flush();
      };

      await push(ebmlHeader);
      await push(Buffer.concat([idBytes(ID.Segment), sizeBytes(segmentSize, 8)]));
      await push(seekHead);
      await push(newInfo);
      await push(tracksBuf);
      for (const k of keptBufs) await push(k);

      const copyBuf = Buffer.alloc(1 << 20);
      for (const c of clusters) {
        const len = c.dataEnd - c.dataStart;
        await push(Buffer.concat([idBytes(ID.Cluster), sizeBytes(len, 8)]));
        await flush();
        let p = c.dataStart;
        while (p < c.dataEnd) {
          const n = Math.min(copyBuf.length, c.dataEnd - p);
          const { bytesRead } = await fh.read(copyBuf, 0, n, p);
          if (bytesRead <= 0) throw new WebmFormatError("読み出しに失敗しました");
          await out.write(copyBuf, 0, bytesRead);
          written += bytesRead;
          p += bytesRead;
        }
      }
      await push(cues);
      await flush();
      await out.sync();
    } finally {
      await out.close();
    }

    return {
      durationMs: Math.round((durationUnits * timecodeScale) / 1_000_000),
      cueCount: cuePoints.length,
      clusterCount: clusters.length,
      truncated,
      bytesWritten: written,
    };
  } finally {
    await fh.close();
  }
}

async function parseCluster(
  r: Reader,
  h: ElementHeader,
  segEnd: number,
): Promise<{ cluster: ClusterInfo | null; end: number; truncated: boolean; maxTime: number }> {
  const known = h.size !== null;
  const limit = known ? Math.min(segEnd, h.dataStart + (h.size as number)) : segEnd;
  let p = h.dataStart;
  let lastGood = h.dataStart;
  let timecode: number | null = null;
  const firstKey = new Map<number, number>();
  let maxTime = 0;
  let truncated = known && h.dataStart + (h.size as number) > segEnd;
  let blocks = 0;

  while (p < limit) {
    const c = await readHeader(r, p, limit);
    if (!c) {
      truncated = true;
      break;
    }
    if (!known && TOP_LEVEL.has(c.id)) break; // 次の Cluster 等に到達
    if (c.size === null) {
      truncated = true;
      break;
    }
    const cend = c.dataStart + c.size;
    if (cend > limit) {
      truncated = true;
      break;
    }
    if (c.id === ID.Timecode) {
      if (!(await r.ensure(c.dataStart, c.size))) {
        truncated = true;
        break;
      }
      timecode = readUintBuf(r.slice(c.dataStart, c.size), 0, c.size);
    } else if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) {
      let info: { track: number; rel: number; key: boolean } | null = null;
      if (c.id === ID.SimpleBlock) {
        const peek = Math.min(c.size, 16);
        if (!(await r.ensure(c.dataStart, peek))) {
          truncated = true;
          break;
        }
        const bh = blockHeader(r.slice(c.dataStart, peek), 0, peek);
        if (bh) info = { track: bh.track, rel: bh.rel, key: (bh.flags & 0x80) !== 0 };
      } else {
        // BlockGroup: 子要素のヘッダだけを辿る(フレーム本体は読まない)。
        // ReferenceBlock があれば非キーフレーム。
        let block: { track: number; rel: number } | null = null;
        let hasRef = false;
        let q = c.dataStart;
        while (q < cend) {
          const g = await readHeader(r, q, cend);
          if (!g || g.size === null) break;
          if (g.id === ID.Block) {
            const peek = Math.min(g.size, 16);
            if (await r.ensure(g.dataStart, peek)) {
              const bh = blockHeader(r.slice(g.dataStart, peek), 0, peek);
              if (bh) block = { track: bh.track, rel: bh.rel };
            }
          } else if (g.id === ID.ReferenceBlock) {
            hasRef = true;
          }
          q = g.dataStart + g.size;
        }
        if (block) info = { ...block, key: !hasRef };
      }
      if (info && timecode !== null) {
        const abs = timecode + info.rel;
        blocks++;
        if (abs > maxTime) maxTime = abs;
        if (info.key && !firstKey.has(info.track)) firstKey.set(info.track, abs);
      }
    }
    p = cend;
    lastGood = cend;
  }

  const end = truncated ? lastGood : known ? limit : p;
  const cluster =
    timecode !== null && blocks > 0 ? { dataStart: h.dataStart, dataEnd: lastGood, timecode, firstKey } : null;
  return { cluster, end, truncated, maxTime };
}

/** 書き出したファイルの検証用: Duration(ms)と Cues の件数を読む */
export async function inspectWebm(path: string): Promise<{ durationMs: number | null; cueCount: number; segmentSizeKnown: boolean }> {
  const size = (await stat(path)).size;
  const fh = await open(path, "r");
  try {
    const r = new Reader(fh, size);
    const ebml = await readHeader(r, 0, size);
    if (!ebml || ebml.size === null) throw new WebmFormatError("WebM ではありません");
    const seg = await readHeader(r, ebml.dataStart + ebml.size, size);
    if (!seg || seg.id !== ID.Segment) throw new WebmFormatError("Segment がありません");
    let durationMs: number | null = null;
    let cueCount = 0;
    let scale = 1_000_000;
    let pos = seg.dataStart;
    const end = seg.size === null ? size : seg.dataStart + seg.size;
    while (pos < end) {
      const h = await readHeader(r, pos, end);
      if (!h || h.size === null) break;
      if (h.id === ID.Info || h.id === ID.Cues) {
        await r.ensure(h.dataStart, h.size);
        const buf = r.slice(h.dataStart, h.size);
        for (const c of children(buf, 0, buf.length)) {
          if (c.id === ID.TimecodeScale) scale = readUintBuf(buf, c.dataStart, c.size);
          if (c.id === ID.Duration) {
            const units = c.size === 8 ? buf.readDoubleBE(c.dataStart) : buf.readFloatBE(c.dataStart);
            durationMs = units;
          }
          if (c.id === ID.CuePoint) cueCount++;
        }
      }
      pos = h.dataStart + h.size;
    }
    return {
      durationMs: durationMs === null ? null : Math.round((durationMs * scale) / 1_000_000),
      cueCount,
      segmentSizeKnown: seg.size !== null,
    };
  } finally {
    await fh.close();
  }
}
