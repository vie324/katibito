// 年代の区切り。表情の出方は年齢で大きく違うため、比較の相手を同じ年代にそろえられるようにする。

export type AgeBand = { id: string; label: string; min: number; max: number };

export const AGE_BANDS: AgeBand[] = [
  { id: "u9", label: "9歳以下", min: 0, max: 9 },
  { id: "10-12", label: "10〜12歳", min: 10, max: 12 },
  { id: "13-15", label: "13〜15歳", min: 13, max: 15 },
  { id: "16-18", label: "16〜18歳", min: 16, max: 18 },
  { id: "19+", label: "19歳以上", min: 19, max: 200 },
];

export function ageBand(age: number | null | undefined): AgeBand | null {
  if (age === null || age === undefined || !Number.isFinite(age)) return null;
  return AGE_BANDS.find((b) => age >= b.min && age <= b.max) ?? null;
}
