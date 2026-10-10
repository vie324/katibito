// 再生中の映像に、見ている人の名前と日時を薄く重ねる(画面の撮影や持ち出しの抑止)。
// 位置は一定時間ごとに変える。クリックなどの操作は映像にそのまま届く。

import { useEffect, useState } from "react";

const POSITIONS = [
  { left: "6%", top: "8%" },
  { right: "6%", top: "38%" },
  { left: "10%", bottom: "16%" },
  { right: "8%", bottom: "30%" },
];

export function Watermark({ text }: { text: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % POSITIONS.length), 20_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="watermark" style={POSITIONS[i]} aria-hidden>
      {text}
    </div>
  );
}

/** 透かしの文言: 見ている人の名前と日付 */
export function watermarkText(name: string | null | undefined): string {
  const d = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  return `${name ?? ""} ${d} 閲覧`;
}
