// 設問セット(§2 [3])。3問 × 各60秒。
// 内面や性格を尋ねる設問にせず、行動の記述を促す設問にしてある。

export type Question = {
  id: string;
  text: string;
  durationMs: number;
};

export const QUESTIONS: Question[] = [
  {
    id: "q1",
    text: "最近の仕事や学びの中で、いちばん手応えを感じた出来事を教えてください。",
    durationMs: 60_000,
  },
  {
    id: "q2",
    text: "意見が合わない相手と物事を進めた場面を、そのときの自分の動きとあわせて教えてください。",
    durationMs: 60_000,
  },
  {
    id: "q3",
    text: "この一年で、自分から変えにいったことをひとつ教えてください。",
    durationMs: 60_000,
  },
];

/** 設問間のインターバル(次の設問を表示するまでの間) */
export const INTERSTITIAL_MS = 2_000;
