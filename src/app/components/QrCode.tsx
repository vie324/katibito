// QR コード(SVG)。同意のリンクを紙に印刷したり、スマートフォンで読み取ってもらったりするため。

import qrcode from "qrcode-generator";
import { useMemo } from "react";

const QUIET = 4;

export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const count = q.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (q.isDark(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
    return { n: count + QUIET * 2, d: path };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label="QRコード" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
