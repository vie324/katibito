// 起動画面(§2 [1])。モデル・WASM のプリロード進捗を出す。

type BootScreenProps = {
  stage: string;
  fraction: number;
};

export function BootScreen({ stage, fraction }: BootScreenProps) {
  const pct = Math.round(fraction * 100);
  return (
    <div className="boot">
      <div className="boot-inner">
        <h1>行動シグナル解析</h1>
        <div className="stage-label">
          <span>{stage}</span>
          <span className="num">{pct}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
